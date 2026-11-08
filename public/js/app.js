// ตัวประสานหลัก: โหลดข้อมูล, จัดการ state, ผูก event — ไม่รู้จัก API Key และไม่ยิง upstream โดยตรง
import { apiClient, ApiClientError, metrics } from './apiClient.js';
import { TrendChart } from './chart.js';
import * as ui from './ui.js';
import { datetimeLocalToIso, formatNumber, RANGE_MS } from './format.js';
import { calculatePlaylistDeltas, parsePlaylistReport } from './playlistReport.js';
import { authReady, currentUser } from './auth.js';

const REFRESH_INTERVALS = [10, 30, 60, 300, 600];

const RANGE_LABEL = { '15m': '15 นาที', '30m': '30 นาที', '1h': '1 ชม.', '6h': '6 ชม.', '1d': '1 วัน', '3d': '3 วัน', '7d': '7 วัน', '30d': '1 เดือน', '1mo': '1 เดือน' };

const state = {
  meta: null,
  health: null,
  cameras: [],
  history: [],
  liveError: null,
  filters: { cameraId: '', start: '', end: '', limit: 300 },
  autoRefresh: true,
  refreshIntervalSeconds: 10,
  layoutCols: 2,
  trendLayoutCols: 2,
  trendRowsLimit: 50,
  trendPage: 0,
  lastUpdated: null,
  loading: false,
  view: 'overview', // overview | trend | history | analysis
  filtersCollapsed: true,
  chartRange: 'all', // ช่วงเวลากราฟ: all | 15m | 30m | 1h | 6h | 1d | 7d | 30d
  chartRangeData: { key: '', range: 'all', rows: [], loading: false, error: null, loadedEnd: null },
  visibleSeries: ['total_car', 'total_motorcycle', 'total_people'],
  monitorWindows: [],
  monitorWindowRanges: [],
  monitorWindowTicks: [],
  monitorWindowSeries: [],
  monitorWindowSizes: [],
  monitorWindowModes: [],
  trendWindows: [],
  trendWindowRanges: [],
  trendWindowTicks: [],
  trendWindowSeries: [],
  trendWindowSizes: [],
  trendWindowModes: [],
  trendWindowOffsets: [],
  trendStartDate: '',
  trendEndDate: '',
  trendSearchApplied: false,
  trendSearchSubmitted: false,
  trendLoading: false,
  trendError: null,
  analysis: {
    fileName: '', records: [], results: [], error: null, loading: false, requestId: null,
    cameraId: '', page: 0, rowsLimit: 50, filters: { start: '', end: '', media: '' },
  },
  prevTotals: null, // ยอดรอบก่อนหน้าสำหรับ delta (รีเซ็ตเมื่อเปลี่ยน filter/toggle)
  latencyMs: null, // วัดจริงจาก performance.now() ฝั่ง apiClient
  newRows: null, // จำนวนรายการที่ใหม่กว่ารอบอัปเดตก่อนหน้า
  errors: { meta: null, health: null, cameras: null, history: null },
};

let chart = null;
// หน้าต่างกราฟมอนิเตอร์: Map<windowIndex, TrendChart>
const camCharts = new Map();
const liveData = new Map();
const trendData = new Map();
const HISTORY_REQUEST_CONCURRENCY = 4;
let activeHistoryRequests = 0;
const historyRequestWaiters = [];
let seq = 0;
let controller = null;
let timer = null;
let trendController = null;
let analysisController = null;
let bootComplete = false;
let preferenceSaveQueue = Promise.resolve();

// ---------- มุมมอง (rail ซ้าย / hash) ----------
const VIEWS = ['overview', 'trend', 'history', 'analysis'];

function viewFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return VIEWS.includes(raw) ? raw : 'overview';
}

function setView(view, { updateHash = true, refresh = true } = {}) {
  const previousView = state.view;
  const permitted = (candidate) => currentUser?.role === 'admin' || currentUser?.pages?.includes(candidate);
  const fallbackView = VIEWS.find(permitted) || 'overview';
  const v = VIEWS.includes(view) && permitted(view) ? view : fallbackView;
  if (previousView === 'analysis' && v !== 'analysis' && analysisController) {
    analysisController.abort();
    state.analysis.loading = false;
    updateAnalysisRunButton();
  }
  state.view = v;
  ui.setView(v);
  if (updateHash) {
    const want = `#/${v}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  // กราฟที่เพิ่งถูก unhidden ต้องวาดใหม่เพราะ clientWidth ตอน hidden = 0
  requestAnimationFrame(() => {
    try {
      if (v === 'trend' && chart) chart.render();
      if (v === 'overview' || v === 'trend') camCharts.forEach((c) => c.render());
    } catch (err) {
      console.error('[view:rerender]', err);
    }
  });
  if (refresh && bootComplete && previousView !== v) refreshCurrentView({ full: false });
}

// ---------- การตั้งค่า layout grid + series + ช่วงเวลา (จัดเก็บใน localStorage) ----------
function applyLayout() {
  const layouts = [
    [ui.els.cameraWindows, state.layoutCols],
    [ui.els.trendCameraWindows, state.trendLayoutCols],
  ];
  for (const [target, columns] of layouts) {
    if (!target) continue;
    target.classList.remove('layout-1col', 'layout-2col', 'layout-3col');
    target.classList.add(`layout-${columns}col`);
  }
  if (ui.els.layoutCols) ui.els.layoutCols.value = String(state.layoutCols);
  if (ui.els.trendLayoutCols) ui.els.trendLayoutCols.value = String(state.trendLayoutCols);
  if (ui.els.trendRowsLimit) ui.els.trendRowsLimit.value = String(state.trendRowsLimit);
  requestAnimationFrame(() => {
    camCharts.forEach((c) => c.render());
    chart?.render();
  });
}

function setVisibleSeries(keys) {
  state.visibleSeries = keys;
  chart?.setVisibleSeries(keys);
  document.querySelectorAll('[data-series-key]').forEach((btn) => {
    const on = keys.includes(btn.getAttribute('data-series-key'));
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  persist();
}

/** กันไม่ให้ผู้ใช้ปิด series ทั้งหมดจนกราฟว่าง — ถ้าจะปิดตัวสุดท้ายให้คืนค่าทั้ง 3 */
function toggleSeries(key) {
  const has = state.visibleSeries.includes(key);
  if (has && state.visibleSeries.length === 1) {
    setVisibleSeries(['total_car', 'total_motorcycle', 'total_people']);
    return;
  }
  setVisibleSeries(
    has ? state.visibleSeries.filter((k) => k !== key) : [...state.visibleSeries, key],
  );
}

function setChartRange(value) {
  state.chartRange = value;
  persist();
  loadData({ full: false });
}

// การตั้งค่าซีรีส์เป็นของหน้าต่างกราฟ ไม่ผูกกับกล้อง เพื่อให้กล้องเดียวมีหลายกราฟได้
function windowSeries(scope, index) {
  const series = scope === 'trend' ? state.trendWindowSeries : state.monitorWindowSeries;
  if (!series[index]) series[index] = [...state.visibleSeries];
  return series[index];
}

function toggleCamSeries(scope, index, key) {
  const windows = windowList(scope);
  if (!Number.isInteger(index) || index < 0 || index >= windows.length) return;
  const series = windowSeries(scope, index);
  const pref = { visibleSeries: series };
  const has = pref.visibleSeries.includes(key);
  if (has && pref.visibleSeries.length === 1) {
    pref.visibleSeries = ['total_car', 'total_motorcycle', 'total_people']; // กันปิดหมด
  } else {
    pref.visibleSeries = has
      ? pref.visibleSeries.filter((k) => k !== key)
      : [...pref.visibleSeries, key];
  }
  const targetSeries = scope === 'trend' ? state.trendWindowSeries : state.monitorWindowSeries;
  targetSeries[index] = pref.visibleSeries;
  camCharts.get(`${scope}:${index}`)?.setVisibleSeries(pref.visibleSeries);
  const node = document.querySelector(
    `[data-window-scope="${scope}"][data-window-index="${index}"]`,
  );
  node?.querySelectorAll('[data-cam-series-key]').forEach((btn) => {
    const on = pref.visibleSeries.includes(btn.getAttribute('data-cam-series-key'));
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  persist();
}

function windowList(scope = state.view) {
  return scope === 'trend' ? state.trendWindows : state.monitorWindows;
}

function addMonitorWindow() {
  const scope = state.view === 'trend' ? 'trend' : 'overview';
  const windows = windowList(scope);
  if (scope === 'trend' && windows.length >= 1) return;
  if (currentUser?.role !== 'admin' && windows.length >= (currentUser?.maxGraphs || 1)) {
    window.alert('account limited');
    return;
  }
  const ranges = scope === 'trend' ? state.trendWindowRanges : state.monitorWindowRanges;
  const ticks = scope === 'trend' ? state.trendWindowTicks : state.monitorWindowTicks;
  const series = scope === 'trend' ? state.trendWindowSeries : state.monitorWindowSeries;
  const sizes = scope === 'trend' ? state.trendWindowSizes : state.monitorWindowSizes;
  const modes = scope === 'trend' ? state.trendWindowModes : state.monitorWindowModes;
  const offsets = scope === 'trend' ? state.trendWindowOffsets : null;
  const container = scope === 'trend' ? ui.els.trendCameraWindows : ui.els.cameraWindows;
  const lastIndex = windows.length - 1;
  let lastSize = lastIndex >= 0 ? sizes[lastIndex] : null;
  if (lastIndex >= 0 && !lastSize) {
    const lastCard = container?.querySelector(`[data-window-index="${lastIndex}"]`);
    if (lastCard) {
      const rect = lastCard.getBoundingClientRect();
      lastSize = {
        width: Math.min(1800, Math.max(360, Math.round(rect.width))),
        height: Math.min(1600, Math.max(560, Math.round(rect.height))),
      };
      sizes[lastIndex] = lastSize;
    }
  }
  windows.push(null);
  ranges.push(scope === 'trend' ? '1d' : '7d');
  ticks.push(scope === 'trend' ? 60 * 1000 : 60 * 1000);
  series.push([...state.visibleSeries]);
  sizes.push(lastSize ? { ...lastSize } : null);
  modes.push('real');
  offsets?.push(0);
  if (scope === 'overview') {
    persist();
    renderMonitorSection();
  } else {
    persist();
    state.trendSearchApplied = false;
    state.trendSearchSubmitted = false;
    renderTrendSection();
  }
}

function selectMonitorCamera(index, cameraId, scope = state.view) {
  const id = String(cameraId || '');
  const windows = windowList(scope);
  if (index < 0 || index >= windows.length || !id) {
    console.error('[monitor:camera] กล้องหรือหน้าต่างที่เลือกไม่ถูกต้อง');
    if (scope === 'trend') renderTrendSection();
    else renderMonitorSection();
    return;
  }
  windows[index] = id;
  if (scope === 'trend') {
    persist();
    state.trendWindowOffsets[index] = 0;
    state.trendSearchApplied = false;
    state.trendSearchSubmitted = false;
    state.trendWindowModes[index] = 'real';
    renderTrendSection();
    loadOverviewLive({ full: false });
  } else {
    persist();
    refreshCurrentView({ full: false });
  }
}

function removeMonitorWindow(index, scope = state.view) {
  const targetScope = scope === 'trend' ? 'trend' : 'overview';
  const windows = windowList(targetScope);
  if (index < 0 || index >= windows.length) return;
  windows.splice(index, 1);
  const ranges = targetScope === 'trend' ? state.trendWindowRanges : state.monitorWindowRanges;
  const ticks = targetScope === 'trend' ? state.trendWindowTicks : state.monitorWindowTicks;
  const series = targetScope === 'trend' ? state.trendWindowSeries : state.monitorWindowSeries;
  const sizes = targetScope === 'trend' ? state.trendWindowSizes : state.monitorWindowSizes;
  const modes = targetScope === 'trend' ? state.trendWindowModes : state.monitorWindowModes;
  const offsets = targetScope === 'trend' ? state.trendWindowOffsets : null;
  ranges.splice(index, 1);
  ticks.splice(index, 1);
  series.splice(index, 1);
  sizes.splice(index, 1);
  modes.splice(index, 1);
  offsets?.splice(index, 1);
  if (targetScope === 'trend') {
    persist();
    state.trendSearchApplied = false;
    state.trendSearchSubmitted = false;
    renderTrendSection();
  } else {
    persist();
    renderMonitorSection();
  }
}

/** วาดกราฟใหม่จากข้อมูลล่าสุด (ใช้เมื่อเปลี่ยน series / ช่วงเวลา โดยไม่ต้องยิง API ใหม่) */
function renderChartOnly() {
  renderChartSection(state.errors.history, state.history);
}

// จัดเก็บการตั้งค่าไว้ฝั่งเซิร์ฟเวอร์ แยกตามบัญชีที่เข้าสู่ระบบ
function persist() {
  const preferences = {
        layoutCols: state.layoutCols,
        trendLayoutCols: state.trendLayoutCols,
        trendRowsLimit: state.trendRowsLimit,
        visibleSeries: state.visibleSeries,
        chartRange: state.chartRange,
        refreshIntervalSeconds: state.refreshIntervalSeconds,
        monitorWindows: state.monitorWindows,
        monitorWindowRanges: state.monitorWindowRanges,
        monitorWindowTicks: state.monitorWindowTicks,
        monitorWindowSeries: state.monitorWindowSeries,
        monitorWindowSizes: state.monitorWindowSizes,
        monitorWindowModes: state.monitorWindowModes,
        trendWindows: state.trendWindows,
        trendWindowRanges: state.trendWindowRanges,
        trendWindowTicks: state.trendWindowTicks,
        trendWindowSeries: state.trendWindowSeries,
        trendWindowSizes: state.trendWindowSizes,
        trendWindowModes: state.trendWindowModes,
        trendWindowOffsets: state.trendWindowOffsets,
        trendStartDate: ui.els.trendStartDate?.value || state.trendStartDate,
        trendEndDate: ui.els.trendEndDate?.value || state.trendEndDate,
      };
  preferenceSaveQueue = preferenceSaveQueue.then(async () => {
    const response = await fetch('/api/user/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(preferences),
      keepalive: true,
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* use the HTTP status below */ }
      throw new Error(payload.error?.message || `บันทึกคอนฟิกไม่สำเร็จ (HTTP ${response.status})`);
    }
  }).catch((error) => {
    console.error('[preferences:save]', error);
    ui.setChartNotice('info', `บันทึกคอนฟิกไม่สำเร็จ: ${error.message}`);
  });
}

function loadPrefs(p = {}) {
    if ([1, 2, 3].includes(Number(p.layoutCols))) state.layoutCols = Number(p.layoutCols);
    if ([1, 2, 3].includes(Number(p.trendLayoutCols))) state.trendLayoutCols = Number(p.trendLayoutCols);
    if ([50, 100, 200, 500, 1000].includes(Number(p.trendRowsLimit))) state.trendRowsLimit = Number(p.trendRowsLimit);
    if (Array.isArray(p.visibleSeries) && p.visibleSeries.length > 0) {
      state.visibleSeries = p.visibleSeries.filter((k) => ['total_car', 'total_motorcycle', 'total_people'].includes(k));
      if (state.visibleSeries.length === 0) state.visibleSeries = ['total_car', 'total_motorcycle', 'total_people'];
    }
    if (['all', '15m', '30m', '1h', '6h', '1d', '7d', '30d'].includes(p.chartRange)) state.chartRange = p.chartRange;
    if (REFRESH_INTERVALS.includes(Number(p.refreshIntervalSeconds))) {
      state.refreshIntervalSeconds = Number(p.refreshIntervalSeconds);
    }
    if (Array.isArray(p.monitorWindows)) {
      state.monitorWindows = p.monitorWindows
        .filter((id) => id === null || typeof id === 'string');
    }
    state.monitorWindowRanges = state.monitorWindows.map((_, index) => p.monitorWindowRanges?.[index] || '7d');
    state.monitorWindowTicks = state.monitorWindows.map((_, index) => Number(p.monitorWindowTicks?.[index]) || 60 * 1000);
    state.monitorWindowSeries = state.monitorWindows.map((_, index) => {
      const keys = p.monitorWindowSeries?.[index];
      return Array.isArray(keys) && keys.some((key) => ['total_car', 'total_motorcycle', 'total_people'].includes(key))
        ? keys.filter((key) => ['total_car', 'total_motorcycle', 'total_people'].includes(key))
        : [...state.visibleSeries];
    });
    state.monitorWindowSizes = state.monitorWindows.map((_, index) => {
      const size = p.monitorWindowSizes?.[index];
      if (!size || !Number.isFinite(Number(size.width)) || !Number.isFinite(Number(size.height))) return null;
      return {
        width: Math.min(1800, Math.max(360, Math.round(Number(size.width)))),
        height: Math.min(1600, Math.max(560, Math.round(Number(size.height)))),
      };
    });
    state.monitorWindowModes = state.monitorWindows.map((_, index) =>
      p.monitorWindowModes?.[index] === 'delta' ? 'delta' : 'real',
    );
    if (Array.isArray(p.trendWindows)) state.trendWindows = p.trendWindows
      .filter((id) => id === null || typeof id === 'string');
    state.trendWindowRanges = state.trendWindows.map((_, index) => p.trendWindowRanges?.[index] || '7d');
    state.trendWindowTicks = state.trendWindows.map((_, index) => Number(p.trendWindowTicks?.[index]) || 60 * 60 * 1000);
    state.trendWindowSeries = state.trendWindows.map((_, index) => {
      const keys = p.trendWindowSeries?.[index];
      return Array.isArray(keys) && keys.some((key) => ['total_car', 'total_motorcycle', 'total_people'].includes(key))
        ? keys.filter((key) => ['total_car', 'total_motorcycle', 'total_people'].includes(key))
        : [...state.visibleSeries];
    });
    state.trendWindowSizes = state.trendWindows.map((_, index) => {
      const size = p.trendWindowSizes?.[index];
      if (!size || !Number.isFinite(Number(size.width)) || !Number.isFinite(Number(size.height))) return null;
      return {
        width: Math.min(1800, Math.max(360, Math.round(Number(size.width)))),
        height: Math.min(1600, Math.max(560, Math.round(Number(size.height)))),
      };
    });
    state.trendWindowModes = state.trendWindows.map((_, index) => p.trendWindowModes?.[index] === 'delta' ? 'delta' : 'real');
    state.trendWindowOffsets = state.trendWindows.map((_, index) => Number(p.trendWindowOffsets?.[index]) || 0);
    state.trendStartDate = typeof p.trendStartDate === 'string' ? p.trendStartDate : '';
    state.trendEndDate = typeof p.trendEndDate === 'string' ? p.trendEndDate : '';
    const graphLimit = currentUser?.role === 'admin' ? Infinity : currentUser?.maxGraphs || 1;
    state.monitorWindows = state.monitorWindows.slice(0, graphLimit);
    state.trendWindows = state.trendWindows.slice(0, graphLimit);
    for (const [windows, fields] of [
      [state.monitorWindows, [state.monitorWindowRanges, state.monitorWindowTicks, state.monitorWindowSeries, state.monitorWindowSizes, state.monitorWindowModes]],
      [state.trendWindows, [state.trendWindowRanges, state.trendWindowTicks, state.trendWindowSeries, state.trendWindowSizes, state.trendWindowModes, state.trendWindowOffsets]],
    ]) fields.forEach((field) => field.length = windows.length);
}

// ---------- helpers ----------
function historyParams() {
  const f = state.filters;
  return {
    camera_id: f.cameraId || undefined,
    start: datetimeLocalToIso(f.start),
    end: datetimeLocalToIso(f.end),
    limit: f.limit || 300,
  };
}

function splitTotals(rows) {
  const real = { vehicle: 0, nonVehicle: 0, person: 0 };
  const cameraIds = new Set();
  for (const r of rows) {
    cameraIds.add(r.camera_id);
    real.vehicle += Number(r.total_car) || 0;
    real.nonVehicle += Number(r.total_motorcycle) || 0;
    real.person += Number(r.total_people) || 0;
  }
  return { real, cameraCount: cameraIds.size };
}

const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

function errMsg(err) {
  if (err instanceof ApiClientError) {
    return { code: err.code, message: err.message, upstreamStatus: err.upstreamStatus };
  }
  return { code: 'UNKNOWN', message: (err && err.message) || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ' };
}

// ---------- สถานะการเชื่อมต่อ (ข้อกำหนดข้อ 6) ----------
function renderStatus() {
  const { meta, health, errors } = state;

  if ((state.view === 'overview' || state.view === 'trend') && state.liveError) {
    ui.setStatus('error', `Live API เรียกไม่สำเร็จ: ${state.liveError.message}`);
    return;
  }
  if (errors.meta && !meta) {
    ui.setStatus('error', 'เชื่อมต่อ Dashboard Server ไม่ได้');
    return;
  }
  if (!meta) {
    ui.setStatus('checking', 'กำลังตรวจสอบ…');
    return;
  }
  if (!meta.apiKeyConfigured && !meta.demoMode) {
    ui.setStatus('error', 'ยังไม่ตั้งค่า API Key');
    return;
  }
  if (errors.history) {
    if (errors.history.code === 'UPSTREAM_UNAUTHORIZED' || errors.history.code === 'UPSTREAM_FORBIDDEN') {
      ui.setStatus('error', 'API Key ถูกปฏิเสธ (401/403)');
      return;
    }
    if (errors.history.code === 'API_KEY_NOT_CONFIGURED') {
      ui.setStatus('error', 'ยังไม่ตั้งค่า API Key');
      return;
    }
    if (errors.history.code === 'UPSTREAM_UNREACHABLE' || errors.history.code === 'UPSTREAM_TIMEOUT') {
      ui.setStatus('error', 'เชื่อมต่อ API บน VPS ไม่ได้');
      return;
    }
  }
  if (errors.health) {
    ui.setStatus('error', 'เชื่อมต่อ API ไม่ได้');
    return;
  }
  if (health) {
    if (health.status === 'ok' && health.database === 'connected') {
      ui.setStatus('online', 'เชื่อมต่อ API ปกติ');
    } else {
      ui.setStatus('degraded', `API ตอบสนอง: ${health.status || 'ไม่ทราบสถานะ'}`);
    }
    return;
  }
  ui.setStatus('checking', 'กำลังตรวจสอบ…');
}

// ---------- ตัวโหลดข้อมูล ----------
async function loadMeta() {
  try {
    state.meta = await apiClient.meta();
    state.errors.meta = null;
  } catch (err) {
    state.meta = null;
    state.errors.meta = errMsg(err);
  }
  ui.renderFooter(state.meta);
  ui.renderBanners({ meta: state.meta });
}

async function loadHealth() {
  try {
    state.health = await apiClient.health();
    state.errors.health = null;
  } catch (err) {
    state.health = null;
    state.errors.health = errMsg(err);
  }
}

async function loadCameras() {
  try {
    state.cameras = await apiClient.cameras();
    state.errors.cameras = null;
    ui.setCameraError(null);
    ui.renderAnalysisCameras(state.cameras, state.analysis.cameraId);
  } catch (err) {
    state.errors.cameras = errMsg(err);
    ui.setCameraError(`โหลดรายชื่อกล้องไม่สำเร็จ: ${state.errors.cameras.message}`);
    ui.renderAnalysisCameras([], '');
  }
}

function rangeBounds(range) {
  const duration = RANGE_MS[range];
  if (!duration) return null;
  const end = state.filters.end ? Date.parse(datetimeLocalToIso(state.filters.end)) : Date.now();
  const rangeStart = end - duration;
  const filterStart = state.filters.start ? Date.parse(datetimeLocalToIso(state.filters.start)) : rangeStart;
  const start = Math.max(rangeStart, filterStart);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error('ช่วงวันเวลาที่เลือกไม่ถูกต้อง');
  }
  return { start, end };
}

function rangeCacheKey(range, cameraId) {
  return JSON.stringify([
    range,
    cameraId || '',
    state.filters.start || '',
    state.filters.end || '',
  ]);
}

function mergeHistoryRows(...rowLists) {
  const unique = new Map();
  for (const rows of rowLists) {
    for (const row of rows || []) {
      const key = row.id != null
        ? `id:${row.id}`
        : `${row.camera_id}|${row.event_time || row.received_at}|${row.total_car}|${row.total_motorcycle}|${row.total_people}`;
      unique.set(key, row);
    }
  }
  return [...unique.values()].sort((a, b) =>
    (Date.parse(a.event_time || a.received_at) || 0) - (Date.parse(b.event_time || b.received_at) || 0),
  );
}

async function withHistoryRequestSlot(signal, request) {
  let reservedSlot = false;
  if (activeHistoryRequests >= HISTORY_REQUEST_CONCURRENCY) {
    reservedSlot = await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      const abort = () => {
        const index = historyRequestWaiters.indexOf(waiter);
        if (index !== -1) historyRequestWaiters.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      waiter.abort = abort;
      historyRequestWaiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!reservedSlot) activeHistoryRequests += 1;
  try {
    return await request();
  } finally {
    let slotTransferred = false;
    while (historyRequestWaiters.length) {
      const waiter = historyRequestWaiters.shift();
      if (waiter.signal.aborted) continue;
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(true);
      slotTransferred = true;
      break;
    }
    if (!slotTransferred) activeHistoryRequests -= 1;
  }
}

async function fetchHistoryRange(params, { start, end }, signal) {
  const hourMs = 60 * 60 * 1000;
  const minimumChunkMs = 60 * 1000;
  const queue = [];
  for (let chunkStart = start; chunkStart <= end; chunkStart += hourMs) {
    queue.push({ start: chunkStart, end: Math.min(end, chunkStart + hourMs) });
  }

  const results = [];
  let failure = null;
  async function worker() {
    while (queue.length && !failure) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = queue.shift();
      try {
        const response = await withHistoryRequestSlot(signal, () => apiClient.history(
            {
              ...params,
              start: new Date(chunk.start).toISOString(),
              end: new Date(chunk.end).toISOString(),
              limit: 1000,
            },
            { signal },
          ));
        const rows = Array.isArray(response) ? response : [];
        if (rows.length >= 1000 && chunk.end - chunk.start + 1 > minimumChunkMs) {
          const midpoint = Math.floor((chunk.start + chunk.end) / 2);
          queue.push(
            { start: chunk.start, end: midpoint },
            { start: midpoint, end: chunk.end },
          );
        } else {
          results.push(...rows);
        }
      } catch (err) {
        if (!isAbort(err)) failure = err;
        else throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
  if (failure) throw failure;
  return mergeHistoryRows(results);
}

function parseTrendDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return NaN;
  }
  return endOfDay ? timestamp + 24 * 60 * 60 * 1000 - 1 : timestamp;
}

async function searchTrendHistory() {
  state.trendPage = 0;
  state.trendWindowOffsets = state.trendWindowOffsets.map(() => 0);
  state.trendSearchSubmitted = true;
  const startValue = ui.els.trendStartDate?.value || '';
  const endValue = ui.els.trendEndDate?.value || '';
  const start = parseTrendDate(startValue);
  const end = parseTrendDate(endValue, true);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    state.trendError = { message: 'กรุณาเลือกวันที่เริ่มต้นและสิ้นสุดให้ถูกต้อง' };
    renderTrendSection();
    return;
  }
  if (start > end) {
    state.trendError = { message: 'วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด' };
    renderTrendSection();
    return;
  }
  const cameraIds = [...new Set(state.trendWindows.filter(Boolean).map(String))];
  if (cameraIds.length === 0) {
    state.trendError = { message: 'กด “เพิ่มกราฟ” และเลือกกล้องก่อนค้นหาประวัติ' };
    renderTrendSection();
    return;
  }

  if (trendController) trendController.abort();
  trendController = new AbortController();
  const { signal } = trendController;
  const searchKey = JSON.stringify([startValue, endValue]);
  state.trendStartDate = startValue;
  state.trendEndDate = endValue;
  state.trendLoading = true;
  state.trendError = null;
  state.trendSearchApplied = false;
  state.trendSearchSubmitted = true;
  for (const cameraId of cameraIds) {
    trendData.set(cameraId, {
      key: searchKey,
      rows: [],
      loading: true,
      error: null,
    });
  }
  renderTrendSection();

  const results = await Promise.allSettled(cameraIds.map(async (cameraId) => {
    try {
      const rows = await fetchHistoryRange(
        { camera_id: cameraId },
        { start, end },
        signal,
      );
      if (!signal.aborted) {
        trendData.set(cameraId, { key: searchKey, rows, loading: false, error: null });
      }
    } catch (err) {
      if (!signal.aborted && !isAbort(err)) {
        trendData.set(cameraId, { key: searchKey, rows: [], loading: false, error: errMsg(err) });
      }
      throw err;
    }
  }));
  if (signal.aborted) return;
  const failed = results.find((result) => result.status === 'rejected');
  state.trendLoading = false;
  state.trendSearchApplied = !failed;
  state.trendError = failed ? errMsg(failed.reason) : null;
  renderTrendSection();
}

function appendLiveRows(rows) {
  let added = 0;
  for (const row of rows) {
    const cameraId = String(row.camera_id || '');
    if (!cameraId) continue;
    let entry = liveData.get(cameraId);
    if (!entry) {
      entry = { rows: [], signatures: new Set(), loading: false, error: null };
      liveData.set(cameraId, entry);
    }
    const signature = row.id != null
      ? `${row.id}|${row.event_time}|${row.total_car}|${row.total_motorcycle}|${row.total_people}`
      : `${row.camera_id}|${row.event_time || row.received_at}|${row.total_car}|${row.total_motorcycle}|${row.total_people}`;
    if (entry.signatures.has(signature)) continue;
    entry.signatures.add(signature);
    entry.rows.push(row);
    added += 1;
  }
  for (const entry of liveData.values()) {
    entry.rows.sort((a, b) =>
      (Date.parse(a.event_time || a.received_at) || 0) - (Date.parse(b.event_time || b.received_at) || 0),
    );
  }
  return added;
}

async function loadOverviewLive({ full = false } = {}) {
  const mySeq = ++seq;
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  state.loading = true;
  ui.setRefreshBusy(true);

  const jobs = [
    apiClient.live({ signal }).then((rows) => {
      if (signal.aborted) return;
      const added = appendLiveRows(Array.isArray(rows) ? rows : []);
      state.newRows = added;
      state.liveError = null;
    }).catch((err) => {
      if (isAbort(err)) throw err;
      state.liveError = errMsg(err);
      state.newRows = null;
    }),
  ];
  if (full) jobs.push(loadHealth(), loadCameras(), loadMeta());
  await Promise.allSettled(jobs);
  if (mySeq !== seq) return;

  state.loading = false;
  state.lastUpdated = new Date();
  state.latencyMs = metrics.historyLatencyMs;
  ui.setRefreshBusy(false);
  ui.setLastUpdated(state.lastUpdated);
  renderMonitorSection();
  if (state.view === 'trend') renderTrendSection();
  const visibleRows = [...new Set((state.view === 'trend' ? state.trendWindows : state.monitorWindows).filter(Boolean).map(String))]
    .reduce((count, cameraId) => count + (liveData.get(cameraId)?.rows.length || 0), 0);
  ui.renderMetrics({ latencyMs: state.latencyMs, newRows: state.newRows, rows: visibleRows });
  renderStatus();
}

function refreshCurrentView({ full = false } = {}) {
  if (state.view === 'overview' || state.view === 'trend') return loadOverviewLive({ full });
  if (state.view === 'analysis') {
    return state.analysis.records.length ? runPlaylistAnalysis() : Promise.resolve();
  }
  return loadData({ full });
}

function setAnalysisStatus(message, kind = '') {
  const status = ui.els.analysisStatus;
  if (!status) return;
  status.textContent = message;
  status.className = `analysis-status${kind ? ` is-${kind}` : ''}`;
}

async function loadPlaylistFile(file) {
  if (analysisController) analysisController.abort();
  const readId = Symbol('playlist-file');
  const { cameraId, rowsLimit, filters } = state.analysis;
  state.analysis = {
    fileName: file.name, records: [], results: [], error: null, loading: false,
    requestId: null, cameraId, rowsLimit, filters, page: 0, readId,
  };
  ui.renderAnalysisResults([]);
  ui.renderAnalysisCameras(state.cameras, cameraId);
  if (ui.els.analysisRunBtn) ui.els.analysisRunBtn.disabled = true;

  try {
    const parsed = parsePlaylistReport(await file.text());
    if (state.analysis.readId !== readId) return;
    if (parsed.errors.length) {
      throw new Error(`${parsed.errors.length} บรรทัดมีรูปแบบไม่ถูกต้อง: ${parsed.errors.slice(0, 5).join(' / ')}`);
    }
    if (parsed.records.length === 0) throw new Error('ไม่พบรายการสื่อในไฟล์');
    state.analysis.records = parsed.records;
    setAnalysisStatus(`นำเข้า ${file.name} สำเร็จ พบ ${formatNumber(parsed.records.length)} รายการ — เลือกกล้องก่อนคำนวณ`, 'success');
    updateAnalysisRunButton();
  } catch (error) {
    if (state.analysis.readId !== readId) return;
    state.analysis.error = error;
    setAnalysisStatus(`อ่านไฟล์ไม่สำเร็จ: ${error.message}`, 'error');
  }
}

async function runPlaylistAnalysis() {
  const { records, cameraId } = state.analysis;
  if (!records.length) {
    setAnalysisStatus('กรุณาเลือกไฟล์ Playlist Report ก่อน', 'error');
    return;
  }
  if (!cameraId) {
    const error = new Error('กรุณาเลือกกล้องที่ต้องการวิเคราะห์');
    state.analysis.error = error;
    ui.renderAnalysisResults([], { error });
    setAnalysisStatus(error.message, 'error');
    return;
  }
  if (!state.cameras.some((camera) => String(camera.camera_id) === cameraId)) {
    const error = new Error('กล้องที่เลือกไม่อยู่ในรายชื่อกล้องปัจจุบัน กรุณาเลือกกล้องใหม่');
    state.analysis.error = error;
    ui.renderAnalysisResults([], { error });
    setAnalysisStatus(error.message, 'error');
    return;
  }

  if (analysisController) analysisController.abort();
  analysisController = new AbortController();
  const { signal } = analysisController;
  const requestId = Symbol('analysis');
  state.analysis.requestId = requestId;
  state.analysis.loading = true;
  state.analysis.error = null;
  if (ui.els.analysisRunBtn) ui.els.analysisRunBtn.disabled = true;
  setAnalysisStatus(`กำลังดึงประวัติจากกล้อง ${cameraId} เพื่อวิเคราะห์ ${formatNumber(records.length)} รายการ…`);
  ui.renderAnalysisResults([], { loading: true });

  try {
    const boundaryMarginMs = 60 * 60 * 1000;
    const start = Math.min(...records.map((record) => record.start)) - boundaryMarginMs;
    const end = Math.max(...records.map((record) => record.end)) + boundaryMarginMs;
    const rows = await fetchHistoryRange({ camera_id: cameraId }, { start, end }, signal);
    if (signal.aborted || state.analysis.requestId !== requestId) return;

    const results = calculatePlaylistDeltas(records, rows)
      .map((record) => ({ ...record, cameraId }));
    state.analysis.results = results;
    state.analysis.loading = false;
    state.analysis.page = 0;
    renderFilteredAnalysisResults();
    const complete = results.filter((row) =>
      row.vehicle != null && row.nonVehicle != null && row.person != null,
    ).length;
    setAnalysisStatus(
      `วิเคราะห์จากกล้อง ${cameraId} เสร็จ: ${formatNumber(complete)} จาก ${formatNumber(results.length)} รายการมีค่าครบ — ใช้ค่า counter ก่อนเริ่มและค่าแรก ณ/หลังเวลาสิ้นสุด`,
      complete === results.length ? 'success' : 'error',
    );
  } catch (error) {
    if (signal.aborted) return;
    analysisController.abort();
    state.analysis.loading = false;
    state.analysis.error = error;
    ui.renderAnalysisResults([], { error });
    setAnalysisStatus(`วิเคราะห์ไม่สำเร็จ: ${error.message}`, 'error');
  } finally {
    if (state.analysis.requestId === requestId) {
      updateAnalysisRunButton();
    }
  }
}

function updateAnalysisRunButton() {
  if (ui.els.analysisRunBtn) {
    ui.els.analysisRunBtn.disabled = state.analysis.loading ||
      !state.analysis.records.length ||
      !state.analysis.cameraId;
  }
}

function parseAnalysisFilterTimestamp(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const localMs = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(localMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) return null;
  return localMs - 7 * 60 * 60 * 1000;
}

function getFilteredAnalysisResults() {
  const { results, filters } = state.analysis;
  const start = parseAnalysisFilterTimestamp(filters.start);
  const endTimestamp = parseAnalysisFilterTimestamp(filters.end);
  const end = endTimestamp === null ? null : endTimestamp + 60_000 - 1;
  const media = filters.media.trim().toLocaleLowerCase();
  return results.filter((record) => (
    (start === null || record.start >= start) &&
    (end === null || record.end <= end) &&
    (!media || record.media.toLocaleLowerCase().includes(media))
  ));
}

function renderFilteredAnalysisResults() {
  const filtered = getFilteredAnalysisResults();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.analysis.rowsLimit));
  state.analysis.page = Math.min(state.analysis.page, pageCount - 1);
  ui.renderAnalysisResults(filtered, {
    applied: true,
    page: state.analysis.page,
    limit: state.analysis.rowsLimit,
    totalCount: filtered.length,
    emptyMessage: state.analysis.results.length
      ? 'ไม่มีรายการที่ตรงกับตัวกรอง'
      : 'ไม่พบข้อมูลจากการคำนวณ',
  });
}

async function loadRangeHistory({ range, cameraId = '', cache, signal }) {
  const key = rangeCacheKey(range, cameraId);
  try {
    const bounds = rangeBounds(range);
    const sameRange = cache.key === key;
    const priorRows = sameRange ? cache.rows : [];
    const start = sameRange && Number.isFinite(cache.loadedEnd)
      ? Math.max(bounds.start, cache.loadedEnd - 60 * 60 * 1000)
      : bounds.start;
    cache.key = key;
    cache.range = range;
    cache.rows = priorRows;
    cache.loading = true;
    cache.error = null;
    const fetched = await fetchHistoryRange(
      { camera_id: cameraId || undefined },
      { start, end: bounds.end },
      signal,
    );
    if (signal.aborted) return;
    cache.rows = mergeHistoryRows(priorRows, fetched).filter((row) => {
      const time = Date.parse(row.event_time || row.received_at);
      return Number.isFinite(time) && time >= bounds.start && time <= bounds.end;
    });
    cache.loadedEnd = bounds.end;
    cache.loading = false;
  } catch (err) {
    if (isAbort(err) || signal.aborted) return;
    cache.loading = false;
    cache.error = errMsg(err);
  }
}

async function loadChartRange(signal) {
  const cache = state.chartRangeData;
  if (state.chartRange === 'all') return;
  await loadRangeHistory({
    range: state.chartRange,
    cameraId: state.filters.cameraId,
    cache,
    signal,
  });
}

async function loadData({ full = false } = {}) {
  const mySeq = ++seq;
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  const prevUpdatedMs = state.lastUpdated ? state.lastUpdated.getTime() : null;

  state.loading = true;
  ui.setRefreshBusy(true);

  const firstLoad = state.history.length === 0 && !state.errors.history;
  if (firstLoad) {
    ui.setSection('table', 'loading', 'กำลังโหลดข้อมูลประวัติ…');
    ui.setSection('chart', 'loading', 'กำลังโหลดกราฟแนวโน้ม…');
    ui.renderCards({ loading: true });
  }

  const jobs = [
    apiClient
      .history(historyParams(), { signal })
      .then((rows) => {
        const arr = Array.isArray(rows) ? rows : [];
        state.history = arr;
        state.errors.history = null;
        state.newRows =
          prevUpdatedMs === null
            ? null
            : arr.filter((r) => {
                const t = Date.parse(r.event_time || r.received_at);
                return Number.isFinite(t) && t > prevUpdatedMs;
              }).length;
      })
      .catch((err) => {
        if (isAbort(err)) throw err;
        state.history = [];
        state.newRows = null;
        state.errors.history = errMsg(err);
      }),
  ];

  if (full) {
    jobs.push(loadHealth(), loadCameras(), loadMeta());
  }

  await Promise.allSettled(jobs);
  if (mySeq !== seq) return; // มีคำขอใหม่กว่า → ข้อมูลชุดนี้ล้าสมัย ห้ามนำไปแสดง

  state.loading = false;
  state.lastUpdated = new Date();
  state.latencyMs = metrics.historyLatencyMs;
  ui.setRefreshBusy(false);
  ui.setLastUpdated(state.lastUpdated);
  renderAll();
}

function renderAll() {
  const rows = state.history;
  const { real, cameraCount } = splitTotals(rows);
  const historyError = state.errors.history;

  const deltas = computeDeltas(real, historyError);

  // แยก try/catch รายส่วน: ถ้าส่วนใดล้มเหลว ให้แสดงกล่อง error ของส่วนนั้น
  // แทนที่จะค้างสถานะ "กำลังโหลด..." ตลอดไป (ป้องกันอาการที่เคยพบ)
  try {
    ui.renderBanners({ meta: state.meta });
    ui.renderCards({
      real: historyError ? null : real,
      rowCount: rows.length,
      cameraCount,
      loading: state.loading && rows.length === 0 && !historyError,
      deltas,
    });
    ui.renderMetrics({
      latencyMs: state.latencyMs,
      newRows: state.newRows,
      rows: historyError ? 0 : rows.length,
    });
  } catch (err) {
    console.error('[render:cards]', err);
  }

  renderTableSection(historyError, rows);
  renderChartSection(historyError, rows);
  renderMonitorSection();
  renderTrendSection();

  try {
    ui.renderClock(new Date(), state.lastUpdated);
    renderStatus();
  } catch (err) {
    console.error('[render:status]', err);
  }
}

/** delta = ยอดที่แสดงขณะนี้ − ยอดรอบรีเฟรชก่อนหน้า (คำนวณจากข้อมูลจริง ไม่ได้ประมาณ) */
function computeDeltas(real, historyError) {
  if (historyError) {
    state.prevTotals = null;
    return null;
  }
  const cur = { ...real };
  const prev = state.prevTotals;
  const deltas = prev
    ? {
        vehicle: cur.vehicle - prev.vehicle,
        nonVehicle: cur.nonVehicle - prev.nonVehicle,
        person: cur.person - prev.person,
      }
    : null;
  state.prevTotals = cur;
  return deltas;
}

function renderTableSection(historyError, rows) {
  try {
    if (historyError) {
      ui.setSection('table', 'error', historyError.message, { code: historyError.code });
      ui.setTableCount(null);
    } else if (rows.length === 0) {
      ui.setSection('table', 'empty', 'ไม่พบข้อมูลในช่วงเวลาที่เลือก');
      ui.setTableCount(0);
    } else {
      ui.renderTableRows(rows);
      ui.setTableCount(rows.length);
      ui.setSection('table', 'ready');
    }
  } catch (err) {
    console.error('[render:table]', err);
    ui.setSection('table', 'error', `แสดงตารางไม่สำเร็จ: ${err.message}`, { code: 'RENDER_ERROR' });
  }
}

/** วาดกราฟแนวโน้มจากข้อมูลที่ผ่านตัวกรองแล้ว */
function renderChartSection(historyError, rows) {
  try {
    if (historyError) {
      chart?.clear();
      ui.setChartNotice(null);
      ui.setSection('chart', 'error', historyError.message, { code: historyError.code });
      return;
    }

    if (state.chartRange !== 'all') {
      const rangeData = state.chartRangeData;
      if (rangeData.loading) {
        chart?.clear();
        ui.setChartNotice(null);
        ui.setSection('chart', 'loading', `กำลังโหลดข้อมูลกราฟช่วง ${RANGE_LABEL[state.chartRange] || state.chartRange}…`);
        return;
      }
      if (rangeData.error) {
        chart?.clear();
        ui.setChartNotice(null);
        ui.setSection('chart', 'error', rangeData.error.message, { code: rangeData.error.code });
        return;
      }
      rows = rangeData.rows;
    }

    const { chartRows, notice } = pickChartRows(rows);
    const ranged = applyChartRange(chartRows);

    if (ranged.length === 0) {
      chart?.clear();
      ui.setChartNotice(null);
      ui.setChartInfo('—');
      ui.setSection(
        'chart',
        'empty',
        chartRows.length === 0
          ? rows.length === 0
            ? 'ไม่พบข้อมูลในช่วงเวลาที่เลือก'
            : 'ไม่มีข้อมูลสำหรับแสดงในช่วงนี้'
          : 'ไม่มีจุดในช่วงเวลาที่เลือก (ลองขยายช่วง หรือเลือก "ทั้งหมด")',
      );
      return;
    }

    ui.setChartNotice(notice ? notice[0] : null, notice ? notice[1] : '');
    ui.setChartInfo(chartInfoText(ranged.length, chartRows.length));
    ui.setSection('chart', 'ready');
    chart?.setData(ranged);
    ui.setChartInfo(chartInfoText());
  } catch (err) {
    console.error('[render:chart]', err);
    try {
      chart?.clear();
    } catch {
      // ไม่ต้องทำอะไรเพิ่ม
    }
    ui.setSection('chart', 'error', `แสดงกราฟไม่สำเร็จ: ${err.message}`, { code: 'RENDER_ERROR' });
  }
}

/** กรองจุดตามช่วงเวลา (อ้างเวลาเหตุการณ์ล่าสุดในชุดนั้น) — ใช้ร่วมกันทั้งกราฟใหญ่และมอนิเตอร์ */
function applyRangeToPoints(points, range) {
  const list = Array.isArray(points) ? points : [];
  if (range === 'all' || !RANGE_MS[range]) return list;
  let anchor = -Infinity;
  for (const p of list) if (p.t > anchor) anchor = p.t;
  if (anchor === -Infinity) return list;
  const cutoff = anchor - RANGE_MS[range];
  return list.filter((p) => p.t >= cutoff);
}

/** กรองจุดกราฟตามช่วงเวลาที่เลือก (อ้างอิงเวลาเหตุการณ์ล่าสุดในชุดข้อมูล) */
function applyChartRange(rows) {
  if (state.chartRange === 'all') return rows;
  const ms = RANGE_MS[state.chartRange];
  if (!ms) return rows;
  let anchor = -Infinity;
  for (const r of rows) {
    const t = Date.parse(r.event_time || r.received_at);
    if (Number.isFinite(t) && t > anchor) anchor = t;
  }
  if (anchor === -Infinity) return rows;
  const cutoff = anchor - ms;
  return rows.filter((r) => {
    const t = Date.parse(r.event_time || r.received_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** ชิปสรุปบนหัวกราฟ — จำนวนจุดที่แสดงและช่วงเวลาที่เลือก */
function chartInfoText(shown, total) {
  if (!chart) return '—';
  if (shown === undefined) return rangeInfo(chart.points ? chart.points.length : 0, chart.points ? chart.points.length : 0);
  return rangeInfo(shown, total);
}

/** ข้อความชิปสรุปช่วงเวลาที่แสดงบนกราฟ */
function rangeInfo(shown, total) {
  if (state.chartRange === 'all') return `${formatNumber(shown)} จุด`;
  const label = RANGE_LABEL[state.chartRange] || state.chartRange;
  if (shown === total) return `${formatNumber(shown)} จุด · ${label}`;
  return `${formatNumber(shown)}/${formatNumber(total)} จุด · ${label}`;
}

/** กราฟแสดงข้อมูลทุกแถวจาก API โดยไม่แยกตามป้ายกำกับภายใน */
function pickChartRows(rows) {
  return { chartRows: rows, notice: null };
}

/**
 * มอนิเตอร์รายกล้อง (มุมมอง overview):
 *  - กริดแสดงเฉพาะหน้าต่างที่ผู้ใช้เพิ่มและเลือกกล้องไว้ (จำนวนคอลัมน์ปรับอัตโนมัติ)
 *  - ตารางเหตุการณ์ล่าสุดใต้กริด (ไม่มีกราฟเดียวกับตารางประวัติ — แยกตามมุมมองแล้ว)
 * ข้อมูลทุกจุดมาจาก history ที่กรองแล้ว
 */
function renderMonitorSection() {
  const cameraIds = [...new Set(state.monitorWindows.filter(Boolean).map(String))];
  const chartRows = cameraIds.flatMap((cameraId) => liveData.get(cameraId)?.rows || []);
  renderCameraWindowGrid({
    container: ui.els.cameraWindows,
    scope: 'overview',
    windows: state.monitorWindows,
    rows: chartRows,
    cameraStates: liveData,
    emptyMessage: 'ไม่มีกราฟ realtime — กด “＋ เพิ่มกราฟ” แล้วเลือกกล้อง',
  });
}

function renderTrendSection() {
  // Trend is a dedicated single-camera realtime monitor, not a history search page.
  if (state.trendWindows.length > 1) {
    state.trendWindows = state.trendWindows.slice(0, 1);
    for (const key of ['trendWindowRanges', 'trendWindowTicks', 'trendWindowSeries', 'trendWindowSizes', 'trendWindowModes', 'trendWindowOffsets']) {
      state[key] = state[key].slice(0, 1);
    }
  }
  if (state.trendWindows.length === 0) {
    state.trendWindows.push(null);
    state.trendWindowRanges.push('1d');
    state.trendWindowTicks.push(60 * 1000);
    state.trendWindowSeries.push([...state.visibleSeries]);
    state.trendWindowSizes.push(null);
    state.trendWindowModes.push('real');
    state.trendWindowOffsets.push(0);
  }
  state.trendWindowModes[0] = 'real';
  const cameraIds = [...new Set(state.trendWindows.filter(Boolean).map(String))];
  const chartRows = cameraIds.flatMap((cameraId) => liveData.get(cameraId)?.rows || []);
  renderTrendCards(chartRows);
  renderCameraWindowGrid({
    container: ui.els.trendCameraWindows,
    scope: 'trend',
    windows: state.trendWindows,
    rows: chartRows,
    cameraStates: liveData,
    emptyMessage: 'เลือกกล้องเพื่อเริ่มดูกราฟ Realtime',
  });
  if (ui.els.trendSearchStatus) {
    const cameraId = cameraIds[0];
    const latest = cameraId ? liveData.get(cameraId)?.rows?.at(-1) : null;
    const stamp = latest?.event_time || latest?.received_at;
    ui.els.trendSearchStatus.textContent = cameraId
      ? `${state.liveError ? 'การเชื่อมต่อมีปัญหา' : 'LIVE MONITOR'} · กล้อง ${cameraId}${stamp ? ` · ข้อมูลล่าสุด ${new Date(stamp).toLocaleString('th-TH')}` : ''}`
      : 'เลือกกล้องจากกราฟเพื่อเริ่มแสดงข้อมูลแบบ Realtime';
    ui.els.trendSearchStatus.classList.toggle('is-error', Boolean(state.liveError));
  }
  if (ui.els.trendResults) ui.els.trendResults.hidden = true;
}

function getTrendSearchRows() {
  const cameraIds = [...new Set(state.trendWindows.filter(Boolean).map(String))];
  return mergeHistoryRows(
    ...cameraIds.map((cameraId) => trendData.get(cameraId)?.rows || []),
  ).sort((a, b) => (
    (Date.parse(b.event_time || b.received_at) || 0) -
    (Date.parse(a.event_time || a.received_at) || 0)
  ));
}

function exportTrendResults() {
  const rows = getTrendSearchRows();
  if (!state.trendSearchSubmitted || state.trendLoading || state.trendError || rows.length === 0) return;

  const columns = [
    ['Timestamp', (row) => row.event_time || ''],
    ['Camera', (row) => row.camera_id || ''],
    ['Camera name', (row) => row.camera_name || ''],
    ['Car in', (row) => row.car?.in ?? ''],
    ['Car out', (row) => row.car?.out ?? ''],
    ['Motorcycle in', (row) => row.motorcycle?.in ?? ''],
    ['Motorcycle out', (row) => row.motorcycle?.out ?? ''],
    ['People in', (row) => row.people?.in ?? ''],
    ['People out', (row) => row.people?.out ?? ''],
    ['Total car', (row) => row.total_car ?? ''],
    ['Total motorcycle', (row) => row.total_motorcycle ?? ''],
    ['Total people', (row) => row.total_people ?? ''],
    ['Received at', (row) => row.received_at || ''],
  ];
  const csvCell = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    let text = String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [
    columns.map(([header]) => csvCell(header)).join(','),
    ...rows.map((row) => columns.map(([, value]) => csvCell(value(row))).join(',')),
  ].join('\r\n');
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `traffic-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getTrendVisibleRows(cameraIds = [...new Set(state.trendWindows.filter(Boolean).map(String))]) {
  const visibleRows = [];
  for (const cameraId of cameraIds) {
    const rows = trendData.get(cameraId)?.rows || [];
    const windowIndexes = state.trendWindows
      .map((id, index) => String(id || '') === cameraId ? index : -1)
      .filter((index) => index >= 0);
    const range = windowIndexes
      .map((index) => state.trendWindowRanges[index] || '7d')
      .sort((a, b) => (RANGE_MS[b] || 0) - (RANGE_MS[a] || 0))[0] || '7d';
    const rangeMs = RANGE_MS[range] || RANGE_MS['7d'];
    const latestT = rows.reduce((latest, row) => {
      const time = Date.parse(row.event_time || row.received_at);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, -Infinity);
    if (!Number.isFinite(latestT)) continue;
    const cutoff = latestT - rangeMs;
    visibleRows.push(...rows.filter((row) => {
      const time = Date.parse(row.event_time || row.received_at);
      return Number.isFinite(time) && time >= cutoff;
    }));
  }
  return visibleRows;
}

function renderTrendCards(rows) {
  const latest = [...rows].sort((a, b) =>
    (Date.parse(b.event_time || b.received_at) || 0) - (Date.parse(a.event_time || a.received_at) || 0),
  )[0];
  const real = latest ? {
    vehicle: Number(latest.total_car) || 0,
    nonVehicle: Number(latest.total_motorcycle) || 0,
    person: Number(latest.total_people) || 0,
  } : null;
  ui.renderCards({
    real,
    rowCount: rows.length,
    cameraCount: latest ? 1 : 0,
    loading: state.loading && rows.length === 0,
    emptyMessage: state.trendWindows.some(Boolean)
      ? 'กำลังรอข้อมูล Realtime จากกล้อง'
      : 'เลือกกล้องเพื่อเริ่ม Monitor',
  });
}

function renderCameraWindowGrid({ container, scope, windows, rows, seriesRows = rows, cameraStates, emptyMessage }) {
  try {
    const groups = buildCamGroups(rows);
    if (seriesRows !== rows) {
      const seriesById = new Map(buildCamGroups(seriesRows).map((group) => [String(group.id), group.series]));
      for (const group of groups) group.series = seriesById.get(String(group.id)) || [];
    }
    const modes = scope === 'trend' ? state.trendWindowModes : state.monitorWindowModes;
    const windowOptions = windows.map((_, index) => ({
      range: scope === 'trend'
        ? state.trendWindowRanges[index] || '7d'
        : state.monitorWindowRanges[index] || '7d',
      tickIntervalMs: scope === 'trend'
        ? state.trendWindowTicks[index] || 60 * 60 * 1000
        : state.monitorWindowTicks[index] || 60 * 1000,
      visibleSeries: windowSeries(scope, index),
      historyOffsetMs: scope === 'trend' ? state.trendWindowOffsets[index] || 0 : 0,
      mode: modes[index] || 'real',
    }));
    ui.renderCameraWindows(groups, windows, {
      container,
      scope,
      emptyMessage,
      cameras: state.cameras,
      cameraStates,
      windowChartOptions: windowOptions,
      windowSizes: scope === 'trend' ? state.trendWindowSizes : state.monitorWindowSizes,
      onCreateChart: (camId, chartKey, wrap, tip, series) => {
        const windowIndex = Number(chartKey.split(':').at(-1));
        const isTrend = scope === 'trend';
        const chartOptions = isTrend
          ? {
              range: state.trendWindowRanges[windowIndex] || '7d',
              tickIntervalMs: state.trendWindowTicks[windowIndex] || 60 * 60 * 1000,
            }
          : {
              range: state.monitorWindowRanges[windowIndex] || '7d',
              tickIntervalMs: state.monitorWindowTicks[windowIndex] || 60 * 1000,
            };
        // Trend uses the live rolling window; no history offset/paging.
        const inst = new TrendChart(wrap, tip, {
          compact: true,
          historyMode: false,
          range: chartOptions.range,
          tickIntervalMs: chartOptions.tickIntervalMs,
          motionKey: isTrend ? undefined : `${chartKey}:${camId}`,
          refreshStepMs: state.refreshIntervalSeconds * 1000,
          onHistoryOffsetChange: isTrend
            ? (offset) => { state.trendWindowOffsets[windowIndex] = offset; }
            : null,
        });
        const mode = modes[windowIndex] || 'real';
        inst.setPoints(mode === 'delta' ? toDeltaSeries(series) : series);
        inst.setVisibleSeries(windowSeries(scope, windowIndex));
        camCharts.set(chartKey, inst);
      },
      onRemoveChart: (chartKey) => {
        camCharts.get(chartKey)?.dispose();
        camCharts.delete(chartKey);
      },
    });
  } catch (err) {
    console.error(`[render:${scope}-charts]`, err);
  }
}

/** รวมรายการตามกล้อง — ใช้กับทั้งกริดมอนิเตอร์ (ข้อมูลทุกช่องมาจากแถวจริงที่กรองแล้ว) */
function buildCamGroups(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  for (const r of list) {
    const id = r.camera_id || '—';
    if (!map.has(id)) {
      map.set(id, { id, count: 0, vehicle: 0, nonVehicle: 0, person: 0, series: [], lastLabel: '—', lastT: null });
    }
    const g = map.get(id);
    g.count += 1;
    g.vehicle += Number(r.total_car) || 0;
    g.nonVehicle += Number(r.total_motorcycle) || 0;
    g.person += Number(r.total_people) || 0;
    const t = Date.parse(r.event_time || r.received_at);
    if (Number.isFinite(t)) {
      g.series.push({
        time: r.event_time || r.received_at,
        cameraId: id,
        t,
        values: {
          total_car: Number(r.total_car) || 0,
          total_motorcycle: Number(r.total_motorcycle) || 0,
          total_people: Number(r.total_people) || 0,
        },
      });
      if (g.lastT === null || t > g.lastT) {
        g.lastT = t;
        g.lastLabel = r.event_time || r.received_at || '—';
      }
    }
  }
  return [...map.values()]
    .map((g) => {
      g.series.sort((a, b) => a.t - b.t);
      const previous = g.series.at(-2)?.values;
      const latest = g.series.at(-1)?.values;
      g.latest = latest || null;
      g.delta = latest && previous
        ? {
            vehicle: latest.total_car - previous.total_car,
            nonVehicle: latest.total_motorcycle - previous.total_motorcycle,
            person: latest.total_people - previous.total_people,
          }
        : null;
      return { ...g, series: g.series };
    })
    .sort((a, b) => b.count - a.count);
}

function toDeltaSeries(series) {
  return series.slice(1).map((point, index) => {
    const previous = series[index].values;
    return {
      ...point,
      values: Object.fromEntries(
        ['total_car', 'total_motorcycle', 'total_people'].map((key) => [
          key,
          (Number(point.values[key]) || 0) - (Number(previous[key]) || 0),
        ]),
      ),
    };
  });
}

// ---------- ตัวกรอง (ข้อกำหนดข้อ 3) ----------
function applyFilters() {
  const f = ui.readFilters(state.filters.cameraId);
  if (f.start && f.end) {
    const s = new Date(f.start);
    const e = new Date(f.end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      ui.showFilterError('รูปแบบวัน-เวลาไม่ถูกต้อง');
      return;
    }
    if (s.getTime() > e.getTime()) {
      ui.showFilterError('เวลา "จาก" ต้องไม่มากกว่าเวลา "ถึง"');
      return;
    }
  }
  ui.showFilterError(null);
  state.filters = f;
  state.prevTotals = null;
  loadData({ full: false });
}

function clearFilters() {
  const { startFilter, endFilter, limitFilter } = ui.els;
  if (startFilter) startFilter.value = '';
  if (endFilter) endFilter.value = '';
  if (limitFilter) limitFilter.value = '300';
  ui.showFilterError(null);
  state.filters = { cameraId: '', start: '', end: '', limit: 300 };
  state.prevTotals = null;
  loadData({ full: false });
}

// ---------- Auto refresh (ข้อกำหนดข้อ 5) ----------
function restartTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!state.autoRefresh) return;
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible' || state.loading) return;
    if (state.view === 'overview' || state.view === 'trend') loadOverviewLive({ full: false });
    else if (state.view === 'history') loadData({ full: false });
  }, state.refreshIntervalSeconds * 1000);
}

function wireEvents() {
  const { els } = ui;
  const toggleFilters = () => {
    state.filtersCollapsed = !state.filtersCollapsed;
    ui.setFiltersCollapsed(state.filtersCollapsed);
  };
  els.refreshBtn?.addEventListener('click', () => refreshCurrentView({ full: true }));
  els.analysisFile?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) loadPlaylistFile(file);
  });
  els.analysisCamera?.addEventListener('change', (event) => {
    if (analysisController) analysisController.abort();
    state.analysis.cameraId = event.target.value;
    state.analysis.loading = false;
    state.analysis.results = [];
    state.analysis.error = null;
    ui.renderAnalysisResults([]);
    setAnalysisStatus(
      state.analysis.cameraId
        ? `เลือกกล้อง ${state.analysis.cameraId}${state.analysis.records.length ? ' — กดคำนวณยอดเพื่อเริ่มวิเคราะห์' : ''}`
        : 'กรุณาเลือกกล้องที่ต้องการวิเคราะห์',
      state.analysis.cameraId ? '' : 'error',
    );
    updateAnalysisRunButton();
  });
  const updateAnalysisFilter = (key, value) => {
    state.analysis.filters[key] = value;
    state.analysis.page = 0;
    if (state.analysis.results.length) renderFilteredAnalysisResults();
  };
  els.analysisStartFilter?.addEventListener('change', (event) => {
    updateAnalysisFilter('start', event.target.value);
  });
  els.analysisEndFilter?.addEventListener('change', (event) => {
    updateAnalysisFilter('end', event.target.value);
  });
  els.analysisMediaFilter?.addEventListener('input', (event) => {
    updateAnalysisFilter('media', event.target.value);
  });
  els.analysisRowsLimit?.addEventListener('change', (event) => {
    const limit = Number(event.target.value);
    if (![50, 100, 200, 500, 1000].includes(limit)) return;
    state.analysis.rowsLimit = limit;
    state.analysis.page = 0;
    if (state.analysis.results.length) renderFilteredAnalysisResults();
  });
  els.analysisPrevPage?.addEventListener('click', () => {
    state.analysis.page = Math.max(0, state.analysis.page - 1);
    if (state.analysis.results.length) renderFilteredAnalysisResults();
  });
  els.analysisNextPage?.addEventListener('click', () => {
    const pageCount = Math.max(1, Math.ceil(
      getFilteredAnalysisResults().length / state.analysis.rowsLimit,
    ));
    state.analysis.page = Math.min(pageCount - 1, state.analysis.page + 1);
    if (state.analysis.results.length) renderFilteredAnalysisResults();
  });
  els.analysisRunBtn?.addEventListener('click', runPlaylistAnalysis);
  els.applyFilterBtn?.addEventListener('click', applyFilters);
  els.clearFilterBtn?.addEventListener('click', clearFilters);
  els.filtersToggleBtn?.addEventListener('click', toggleFilters);
  const syncFullscreenButton = () => {
    const active = document.fullscreenElement === els.chartSection;
    if (els.chartFullscreenBtn) {
      els.chartFullscreenBtn.textContent = active ? '⤢ ออกจากเต็มจอ' : '⛶ เต็มจอ';
      els.chartFullscreenBtn.setAttribute('aria-label', active ? 'ออกจากโหมดเต็มจอ' : 'ขยายกราฟเต็มจอ');
      els.chartFullscreenBtn.setAttribute('aria-pressed', String(active));
    }
    requestAnimationFrame(() => chart?.render());
  };
  els.chartFullscreenBtn?.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === els.chartSection) {
        await document.exitFullscreen();
      } else if (els.chartSection?.requestFullscreen) {
        await els.chartSection.requestFullscreen();
      } else {
        throw new Error('เบราว์เซอร์นี้ไม่รองรับโหมดเต็มจอ');
      }
    } catch (err) {
      console.error('[chart:fullscreen]', err);
      ui.setChartNotice('info', `เปิดหรือปิดโหมดเต็มจอไม่สำเร็จ: ${err.message}`);
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);

  // rail: สลับมุมมอง (ภาพรวม / แนวโน้ม / ประวัติ) + ⌗ พับแถบตัวกรอง
  document.querySelectorAll('[data-rail-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setView(btn.getAttribute('data-rail-view') || 'overview');
    });
  });
  document.querySelectorAll('[data-rail-action="filters"]').forEach((btn) => {
    btn.addEventListener('click', toggleFilters);
  });

  window.addEventListener('hashchange', () => {
    setView(viewFromHash(), { updateHash: false });
  });

  // ---------- ตั้งค่ากราฟ: series (3 toggle) + ช่วงเวลา ----------
  document.querySelectorAll('[data-series-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-series-key');
      const cur = state.visibleSeries;
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      if (next.length === 0) return; // กันกราฟว่างทั้งหมด — ต้องมีอย่างน้อย 1 series
      setVisibleSeries(next);
    });
  });

  els.chartRange?.addEventListener('change', (e) => { setChartRange(e.target.value); });
  els.layoutCols?.addEventListener('change', (e) => {
    const columns = Number(e.target.value);
    if (![1, 2, 3].includes(columns)) return;
    state.layoutCols = columns;
    applyLayout();
    persist();
  });
  els.autoRefreshToggle?.addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    restartTimer();
  });
  ui.els.addMonitorWindow?.addEventListener('click', addMonitorWindow);
  ui.els.trendAddMonitorWindow?.addEventListener('click', addMonitorWindow);
  els.refreshInterval?.addEventListener('change', (e) => {
    const seconds = Number(e.target.value);
    if (!REFRESH_INTERVALS.includes(seconds)) {
      e.target.value = String(state.refreshIntervalSeconds);
      console.error('[refresh:interval] ช่วงเวลารีเฟรชที่เลือกไม่ถูกต้อง');
      return;
    }
    state.refreshIntervalSeconds = seconds;
    persist();
    restartTimer();
  });

  // ---------- ตัวกรอง "ต่อหน้าต่าง" ในมอนิเตอร์ (series + ช่วงเวลา แยกทีละกล้อง) ----------
  // หน้าต่างถูกสร้างใหม่ทุก render จึงผูกด้วย event delegation บน container แม่
  const bindCameraWindowEvents = (container, scope) => {
    let persistResizeTimer = null;
    const sizeObserver = new ResizeObserver((entries) => {
      if (!container?.isConnected || container.getClientRects().length === 0) return;
      const sizes = scope === 'trend' ? state.trendWindowSizes : state.monitorWindowSizes;
      let changed = false;
      for (const entry of entries) {
        if (entry.target.getClientRects().length === 0) continue;
        const index = Number(entry.target.getAttribute('data-window-index'));
        if (!Number.isInteger(index) || index < 0 || index >= windowList(scope).length) continue;
        const rect = entry.target.getBoundingClientRect();
        const next = {
          width: Math.min(1800, Math.max(360, Math.round(rect.width))),
          height: Math.min(1600, Math.max(560, Math.round(rect.height))),
        };
        entry.target.style.width = `${next.width}px`;
        entry.target.style.height = `${next.height}px`;
        entry.target.style.flex = '0 0 auto';
        const current = sizes[index];
        if (!current || Math.abs(current.width - next.width) > 1 || Math.abs(current.height - next.height) > 1) {
          sizes[index] = next;
          changed = true;
        }
      }
      if (changed) {
        clearTimeout(persistResizeTimer);
        persistResizeTimer = setTimeout(persist, 150);
      }
    });
    const observeCards = () => {
      container?.querySelectorAll('.cam-win[data-window-index]').forEach((card) => sizeObserver.observe(card));
    };
    if (container) {
      observeCards();
      new MutationObserver(observeCards).observe(container, { childList: true });
    }
    container?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-monitor-remove]');
      if (removeBtn && container.contains(removeBtn)) {
        removeMonitorWindow(Number(removeBtn.getAttribute('data-monitor-remove')), scope);
        return;
      }
      const modeToggle = e.target.closest('[data-window-mode-toggle]');
      if (modeToggle && container.contains(modeToggle)) {
        const index = Number(modeToggle.getAttribute('data-window-index'));
        const modes = scope === 'trend' ? state.trendWindowModes : state.monitorWindowModes;
        if (!Number.isInteger(index) || index < 0 || index >= windowList(scope).length) return;
        modes[index] = modes[index] === 'delta' ? 'real' : 'delta';
        if (scope === 'trend') {
          persist();
          renderTrendSection();
        } else {
          persist();
          renderMonitorSection();
        }
        return;
      }
      const btn = e.target.closest('[data-cam-series-key]');
      if (!btn || !container.contains(btn)) return;
      toggleCamSeries(
        scope,
        Number(btn.getAttribute('data-window-index')),
        btn.getAttribute('data-cam-series-key'),
      );
    });
    container?.addEventListener('change', (e) => {
      const cameraSelect = e.target.closest('[data-monitor-camera]');
      if (!cameraSelect || !container.contains(cameraSelect)) return;
      selectMonitorCamera(
        Number(cameraSelect.getAttribute('data-window-index')),
        cameraSelect.value,
        scope,
      );
    });
    container?.addEventListener('change', (e) => {
      const rangeSelect = e.target.closest('[data-trend-chart-range]');
      const tickSelect = e.target.closest('[data-trend-chart-tick]');
      const control = rangeSelect || tickSelect;
      if (!control || !container.contains(control)) return;
      const index = Number(control.getAttribute('data-window-index'));
      const windows = windowList(scope);
      if (!Number.isInteger(index) || index < 0 || index >= windows.length) return;
      const ranges = scope === 'trend' ? state.trendWindowRanges : state.monitorWindowRanges;
      const ticks = scope === 'trend' ? state.trendWindowTicks : state.monitorWindowTicks;
      if (rangeSelect) {
        ranges[index] = rangeSelect.value;
        if (scope === 'trend') state.trendWindowOffsets[index] = 0;
      }
      else {
        const intervalMs = Number(tickSelect.value);
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
        ticks[index] = intervalMs;
      }
      if (scope === 'trend') {
        persist();
        renderTrendSection();
      }
      else {
        persist();
        renderMonitorSection();
      }
    });
  };
  bindCameraWindowEvents(els.cameraWindows, 'overview');
  bindCameraWindowEvents(els.trendCameraWindows, 'trend');
  els.trendSearchBtn?.addEventListener('click', searchTrendHistory);
  els.trendLayoutCols?.addEventListener('change', () => {
    const columns = Number(els.trendLayoutCols.value);
    if (![1, 2, 3].includes(columns)) return;
    state.trendLayoutCols = columns;
    applyLayout();
    persist();
  });
  els.trendRowsLimit?.addEventListener('change', () => {
    const limit = Number(els.trendRowsLimit.value);
    if (![50, 100, 200, 500, 1000].includes(limit)) return;
    state.trendRowsLimit = limit;
    state.trendPage = 0;
    persist();
    renderTrendSection();
  });
  els.trendPrevPage?.addEventListener('click', () => {
    state.trendPage = Math.max(0, state.trendPage - 1);
    renderTrendSection();
    ui.els.trendTableScroll?.scrollTo({ top: 0 });
  });
  els.trendNextPage?.addEventListener('click', () => {
    const pageCount = Math.ceil(getTrendSearchRows().length / state.trendRowsLimit);
    state.trendPage = Math.min(Math.max(0, pageCount - 1), state.trendPage + 1);
    renderTrendSection();
    ui.els.trendTableScroll?.scrollTo({ top: 0 });
  });
  els.trendExportBtn?.addEventListener('click', exportTrendResults);
  [els.trendStartDate, els.trendEndDate].forEach((input) => {
    input?.addEventListener('change', persist);
  });

  // ปุ่ม "ลองใหม่" ในกล่อง Error ทุกกล่อง
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="retry"]');
    if (btn) refreshCurrentView({ full: true });
  });

  // กด Enter ในช่องกรองเพื่อใช้ตัวกรอง
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const id = e.target && e.target.id;
    if (id === 'startFilter' || id === 'endFilter') {
      e.preventDefault();
      applyFilters();
    }
  });
}

// ---------- เริ่มต้น ----------
async function boot() {
  const preferencesResponse = await fetch('/api/user/preferences', { headers: { Accept: 'application/json' } });
  if (!preferencesResponse.ok) throw new Error(`โหลดคอนฟิกผู้ใช้ไม่สำเร็จ (HTTP ${preferencesResponse.status})`);
  loadPrefs(await preferencesResponse.json());
  chart = new TrendChart(ui.els.chartWrap, ui.els.chartTooltip);
  wireEvents();
  if (ui.els.refreshInterval) ui.els.refreshInterval.value = String(state.refreshIntervalSeconds);
  applyLayout();
  setVisibleSeries(state.visibleSeries);
  if (ui.els.chartRange) ui.els.chartRange.value = state.chartRange;
  const trendEnd = state.trendEndDate || new Date().toISOString().slice(0, 10);
  const trendStart = state.trendStartDate || new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (ui.els.trendStartDate) ui.els.trendStartDate.value = trendStart;
  if (ui.els.trendEndDate) ui.els.trendEndDate.value = trendEnd;
  ui.setFiltersCollapsed(state.filtersCollapsed);
  document.querySelectorAll('[data-rail-view]').forEach((button) => {
    button.hidden = currentUser.role !== 'admin' && !currentUser.pages.includes(button.dataset.railView);
  });
  setView(viewFromHash(), { updateHash: false, refresh: false });

  ui.setStatus('checking', 'กำลังตรวจสอบ…');
  ui.setSection('table', 'loading', 'กำลังโหลดข้อมูลประวัติ…');
  ui.setSection('chart', 'loading', 'กำลังโหลดกราฟแนวโน้ม…');
  await loadMeta();
  await Promise.all([loadHealth(), loadCameras()]);
  const allowedCameraIds = new Set(state.cameras.map((camera) => String(camera.camera_id)));
  state.monitorWindows = state.monitorWindows.map((id) => id && allowedCameraIds.has(id) ? id : null);
  state.trendWindows = state.trendWindows.map((id) => id && allowedCameraIds.has(id) ? id : null);
  persist();
  renderStatus();

  bootComplete = true;
  if (state.view === 'overview') await loadOverviewLive({ full: false });
  else if (state.view !== 'analysis') await loadData({ full: false });
  restartTimer();
  ui.renderClock(new Date(), state.lastUpdated);
  setInterval(() => ui.renderClock(new Date(), state.lastUpdated), 1000);
}

if (await authReady) {
  boot().catch((error) => {
    console.error('[boot]', error);
    ui.setStatus('error', error.message || 'เริ่ม Dashboard ไม่สำเร็จ');
  });
}
