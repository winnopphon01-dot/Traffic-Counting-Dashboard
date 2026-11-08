// UI rendering layer — แยกชั้นออกจาก API Client (apiClient.js) และตรรกะแอป (app.js)
import { formatClock, formatDateTime, formatNumber, toDate } from './format.js';

export const els = {};

function $(id) {
  const el = document.getElementById(id);
  if (!el) console.warn(`[ui] ไม่พบ element #${id}`);
  return el;
}

for (const id of [
  'connStatus', 'connText', 'lastUpdated', 'refreshBtn', 'autoRefreshToggle', 'refreshInterval',
  'filtersToggleBtn', 'noKeyBanner',
  'startFilter', 'endFilter', 'limitFilter', 'applyFilterBtn', 'clearFilterBtn',
  'filterError', 'cameraError', 'summaryCards', 'filtersSection', 'chartSection', 'tableSection',
  'vehicleValue', 'vehicleSub', 'vehicleDelta',
  'nonVehicleValue', 'nonVehicleSub', 'nonVehicleDelta',
  'personValue', 'personSub', 'personDelta',
  'cardVehicle', 'cardNonVehicle', 'cardPerson',
  'cameraWindows', 'trendCameraWindows', 'addMonitorWindow', 'trendAddMonitorWindow', 'trendStartDate', 'trendEndDate', 'trendSearchBtn', 'trendSearchStatus',
  'trendLayoutCols', 'trendResults', 'trendRowsLimit', 'trendExportBtn', 'trendTableCount', 'trendTableState', 'trendTableScroll', 'trendResultsBody',
  'trendPrevPage', 'trendNextPage', 'trendPageInfo',
  'analysisFile', 'analysisCamera', 'analysisRunBtn', 'analysisStatus', 'analysisTableState', 'analysisTableToolbar',
  'analysisRowsLimit', 'analysisTableCount', 'analysisPrevPage', 'analysisNextPage', 'analysisPageInfo',
  'analysisStartFilter', 'analysisEndFilter', 'analysisMediaFilter', 'analysisTableScroll', 'analysisResultsBody',
  'monitorTableSection', 'monitorTableBody', 'monitorTableChip', 'monitorTableState',
  'chartState', 'chartWrap', 'chartTooltip', 'chartNotice', 'chartFullscreenBtn',
  'tableState', 'tableScroll', 'historyBody', 'tableCount',
  'tbLatency', 'tbRows', 'tbNewRows',
  'chartInfo', 'chartRange', 'layoutCols',
  'sbUpdated', 'sbClock', 'apiUpstream', 'apiDocsLink', 'apiSpecLink',
]) {
  els[id] = $(id);
}

const SECTION_MAP = {
  chart: { block: 'chartState', content: 'chartWrap' },
  table: { block: 'tableState', content: 'tableScroll' },
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** kind: loading | error | empty | ready */
export function setSection(section, kind, message = '', opts = {}) {
  const map = SECTION_MAP[section];
  if (!map) return;
  const block = els[map.block];
  const content = els[map.content];
  if (!block || !content) return;

  if (kind === 'ready') {
    block.hidden = true;
    content.hidden = false;
    return;
  }

  content.hidden = true;
  block.hidden = false;
  block.className = `state-block state-${kind}`;
  const msgEl = block.querySelector('.state-msg');
  if (msgEl) {
    if (kind === 'error' && opts.code) {
      msgEl.innerHTML = `<strong>${escapeHtml(opts.code)}</strong> — ${escapeHtml(message)}`;
    } else {
      msgEl.textContent = message;
    }
  }
  const retryBtn = block.querySelector('[data-action="retry"]');
  if (retryBtn) retryBtn.hidden = kind !== 'error';
}

/** แถบแจ้งสถานะใต้หัวข้อกราฟ: kind = 'test' | 'info' | null (null = ซ่อน) */
export function setChartNotice(kind, message) {
  const el = els.chartNotice;
  if (!el) return;
  if (!kind || !message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'chart-notice';
    return;
  }
  el.hidden = false;
  el.className = 'chart-notice is-info';
  el.textContent = message;
}

/** kind: checking | online | degraded | error */
export function setStatus(kind, text) {
  if (els.connStatus) els.connStatus.className = `status-pill is-${kind}`;
  if (els.connText) els.connText.textContent = text;
}

export function setLastUpdated(date) {
  if (!els.lastUpdated) return;
  els.lastUpdated.textContent = date ? `อัปเดตล่าสุด ${formatClock(date)}` : 'ยังไม่เคยอัปเดต';
}

export function setRefreshBusy(busy) {
  if (!els.refreshBtn) return;
  els.refreshBtn.classList.toggle('is-busy', busy);
  els.refreshBtn.disabled = busy;
  els.refreshBtn.textContent = busy ? 'กำลังโหลด…' : '↻ รีเฟรช';
  els.refreshBtn.setAttribute('aria-label', busy ? 'กำลังโหลดข้อมูล' : 'รีเฟรช');
  els.refreshBtn.title = busy ? 'กำลังโหลดข้อมูล' : 'รีเฟรช';
}

export function renderBanners({ meta }) {
  if (els.noKeyBanner) {
    els.noKeyBanner.hidden = !(meta && !meta.apiKeyConfigured && !meta.demoMode);
  }
}

export function renderFooter(meta) {
  const base = meta && meta.upstream ? meta.upstream : '—';
  if (els.apiUpstream) els.apiUpstream.textContent = base;
  if (els.apiDocsLink && meta && meta.upstream) {
    els.apiDocsLink.href = `${meta.upstream}/docs`;
    els.apiSpecLink.href = `${meta.upstream}/openapi.json`;
  }
}

export function setCameraError(message) {
  if (!els.cameraError) return;
  els.cameraError.hidden = !message;
  els.cameraError.textContent = message || '';
}

export function showFilterError(message) {
  if (!els.filterError) return;
  els.filterError.hidden = !message;
  els.filterError.textContent = message || '';
}

export function readFilters(cameraId) {
  return {
    cameraId: cameraId || '',
    start: els.startFilter ? els.startFilter.value : '',
    end: els.endFilter ? els.endFilter.value : '',
    limit: els.limitFilter ? Number(els.limitFilter.value) || 300 : 300,
  };
}

/** การ์ดสรุป 3 ตัวจากทุกแถวที่ผ่านตัวกรอง */
export function renderCards({
  real = null,
  rowCount = 0,
  cameraCount = 0,
  loading = false,
  deltas = null,
  emptyMessage = 'โหลดข้อมูลไม่สำเร็จ',
} = {}) {
  const cards = [
    { value: els.vehicleValue, sub: els.vehicleSub, card: els.cardVehicle, delta: els.vehicleDelta, key: 'vehicle' },
    { value: els.nonVehicleValue, sub: els.nonVehicleSub, card: els.cardNonVehicle, delta: els.nonVehicleDelta, key: 'nonVehicle' },
    { value: els.personValue, sub: els.personSub, card: els.cardPerson, delta: els.personDelta, key: 'person' },
  ];

  const setDelta = (el, d) => {
    if (!el) return;
    if (d === null || d === undefined) {
      el.textContent = '—';
      el.className = 'stat-delta';
      return;
    }
    if (d > 0) {
      el.textContent = `▲ +${formatNumber(d)}`;
      el.className = 'stat-delta is-up';
    } else if (d < 0) {
      el.textContent = `▼ ${formatNumber(d)}`;
      el.className = 'stat-delta is-down';
    } else {
      el.textContent = '±0';
      el.className = 'stat-delta is-flat';
    }
  };

  const baseSub = `จาก ${formatNumber(rowCount)} รายการ · ${formatNumber(cameraCount)} กล้อง`;
  for (const c of cards) {
    if (!c.value) continue;
    if (!real) {
      c.value.textContent = loading ? '…' : '—';
      c.sub.textContent = loading ? 'กำลังโหลด…' : emptyMessage;
      if (c.card) c.card.classList.remove('with-test');
      setDelta(c.delta, null);
      continue;
    }
    c.value.textContent = formatNumber(real[c.key] ?? 0);
    c.sub.textContent = baseSub;
    if (c.card) c.card.classList.remove('with-test');
    setDelta(c.delta, deltas ? deltas[c.key] : null);
  }
}

export function renderTableRows(rows) {
  if (!els.historyBody) return;
  els.historyBody.innerHTML = rows
    .map((r) => {
      const time = formatDateTime(r.event_time || r.received_at);
      return `<tr>
        <td class="cell-time">${escapeHtml(time)}</td>
        <td><span class="cam-name">${escapeHtml(r.camera_id)}</span></td>
        <td class="num">${formatNumber(r.car?.in)}</td>
        <td class="num">${formatNumber(r.car?.out)}</td>
        <td class="num">${formatNumber(r.motorcycle?.in)}</td>
        <td class="num">${formatNumber(r.motorcycle?.out)}</td>
        <td class="num">${formatNumber(r.people?.in)}</td>
        <td class="num">${formatNumber(r.people?.out)}</td>
        <td class="num num-strong">${formatNumber(r.total_car)}</td>
        <td class="num num-strong">${formatNumber(r.total_motorcycle)}</td>
        <td class="num num-strong">${formatNumber(r.total_people)}</td>
        <td>${escapeHtml(r.camera_name || '—')}</td>
        <td class="cell-time">${escapeHtml(formatDateTime(r.received_at))}</td>
      </tr>`;
    })
    .join('');
}

export function setTableCount(shown) {
  if (!els.tableCount) return;
  if (shown === null) {
    els.tableCount.textContent = '';
    return;
  }
  els.tableCount.textContent = `${formatNumber(shown)} รายการ`;
}

/** สลับมุมมอง: 'overview' | 'trend' | 'history' — section ที่ไม่ใช่มุมมองปัจจุบันถูกซ่อนด้วย [hidden] */
export function setView(view) {
  const views = new Set(['overview', 'trend', 'history', 'analysis']);
  const v = views.has(view) ? view : 'overview';
  document.querySelector('.container')?.setAttribute('data-active-view', v);
  document.querySelectorAll('[data-view]').forEach((el) => {
    // รองรับ section ที่แสดงได้หลายมุมมอง เช่น data-view="overview trend"
    const allowed = (el.getAttribute('data-view') || '').split(/\s+/);
    el.hidden = !allowed.includes(v);
  });
  document.querySelectorAll('[data-overview-hidden="true"]').forEach((el) => {
    if (v === 'overview') {
      el.hidden = true;
    } else if (el.getAttribute('data-view') && !(el.getAttribute('data-view') || '').split(/\s+/).includes(v)) {
      el.hidden = true;
    } else {
      el.hidden = false;
    }
  });
  if (els.filtersSection?.classList.contains('is-collapsed')) els.filtersSection.hidden = true;
  document.querySelectorAll('[data-rail-view]').forEach((btn) => {
    const active = btn.getAttribute('data-rail-view') === v;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

export function renderAnalysisResults(records, {
  error = null,
  loading = false,
  applied = false,
  page = 0,
  limit = 50,
  totalCount = records.length,
  emptyMessage = 'ไม่พบข้อมูลจากการคำนวณ',
} = {}) {
  const body = els.analysisResultsBody;
  const stateBlock = els.analysisTableState;
  const scroll = els.analysisTableScroll;
  const toolbar = els.analysisTableToolbar;
  if (!body || !stateBlock || !scroll) return;
  const pageCount = Math.max(1, Math.ceil(totalCount / limit));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  if (toolbar) toolbar.hidden = !applied || loading || Boolean(error);
  if (els.analysisRowsLimit) els.analysisRowsLimit.value = String(limit);
  if (els.analysisTableCount) {
    els.analysisTableCount.textContent = `${formatNumber(totalCount)} รายการ`;
  }
  if (els.analysisPageInfo) {
    els.analysisPageInfo.textContent = `หน้า ${formatNumber(currentPage + 1)} / ${formatNumber(pageCount)}`;
  }
  if (els.analysisPrevPage) els.analysisPrevPage.disabled = loading || Boolean(error) || currentPage <= 0;
  if (els.analysisNextPage) els.analysisNextPage.disabled = loading || Boolean(error) || currentPage >= pageCount - 1;

  if (!applied && !error && !loading && records.length === 0) {
    stateBlock.hidden = true;
    scroll.hidden = true;
    body.innerHTML = '';
    return;
  }

  if (loading || error || records.length === 0) {
    scroll.hidden = true;
    stateBlock.hidden = false;
    stateBlock.className = `state-block ${error ? 'state-error' : loading ? 'state-loading' : 'state-empty'}`;
    const message = stateBlock.querySelector('.state-msg');
    if (message) {
      message.textContent = error
        ? `วิเคราะห์ไม่สำเร็จ: ${error.message}`
        : loading
          ? 'กำลังค้นหาประวัติจากกล้องที่เลือก…'
          : emptyMessage;
    }
    body.innerHTML = '';
    return;
  }

  stateBlock.hidden = true;
  scroll.hidden = false;
  const visibleRecords = records.slice(currentPage * limit, (currentPage + 1) * limit);
  body.innerHTML = visibleRecords.map((record) => `
    <tr>
      <td class="cell-time">${escapeHtml(formatBangkokDateTime(record.start))}</td>
      <td class="cell-time">${escapeHtml(formatBangkokDateTime(record.end))}</td>
      <td>${escapeHtml(record.media)}</td>
      <td class="num num-strong">${record.vehicle == null ? '—' : formatNumber(record.vehicle)}</td>
      <td class="num">${record.nonVehicle == null ? '—' : formatNumber(record.nonVehicle)}</td>
      <td class="num">${record.person == null ? '—' : formatNumber(record.person)}</td>
      <td>${escapeHtml(record.cameraId || '—')}</td>
    </tr>`).join('');
}

export function renderAnalysisCameras(cameras, selectedCameraId = '') {
  const select = els.analysisCamera;
  if (!select) return;
  const validCameras = Array.isArray(cameras)
    ? cameras.filter((camera) => camera?.camera_id)
    : [];
  select.innerHTML = [
    '<option value="">เลือกกล้อง…</option>',
    ...validCameras.map((camera) => {
      const cameraId = String(camera.camera_id);
      const label = camera.camera_name && camera.camera_name !== cameraId
        ? `${camera.camera_name} · ${cameraId}`
        : cameraId;
      return `<option value="${escapeHtml(cameraId)}">${escapeHtml(label)}</option>`;
    }),
  ].join('');
  select.value = validCameras.some((camera) => String(camera.camera_id) === String(selectedCameraId))
    ? String(selectedCameraId)
    : '';
  select.disabled = validCameras.length === 0;
}

function formatBangkokDateTime(timestamp) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

export function renderTrendResults(rows, { limit = 50, page = 0, applied = false, loading = false, error = null } = {}) {
  const section = els.trendResults;
  const body = els.trendResultsBody;
  if (!section || !body) return;
  section.hidden = !applied;
  if (!applied) return;

  const pageCount = Math.max(1, Math.ceil(rows.length / limit));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const firstRow = currentPage * limit;
  const visibleRows = rows.slice(firstRow, firstRow + limit);
  const tableState = els.trendTableState;
  const scroll = els.trendTableScroll;
  if (loading || error || rows.length === 0) {
    if (tableState) {
      tableState.hidden = false;
      tableState.className = `state-block ${error ? 'state-error' : 'state-empty'}`;
      const message = tableState.querySelector('.state-msg');
      if (message) message.textContent = error ? `ค้นหาข้อมูลไม่สำเร็จ: ${error.message}` : loading ? 'กำลังค้นหาข้อมูล…' : 'ไม่พบข้อมูลในช่วงที่ค้นหา';
    }
    if (scroll) scroll.hidden = true;
    body.innerHTML = '';
  } else {
    if (tableState) tableState.hidden = true;
    if (scroll) scroll.hidden = false;
    body.innerHTML = visibleRows.map((row) => `
      <tr>
        <td class="cell-time">${escapeHtml(formatDateTime(row.event_time || row.received_at))}</td>
        <td><span class="cam-name">${escapeHtml(row.camera_id || '—')}</span></td>
        <td class="num">${formatNumber(row.car?.in)}</td>
        <td class="num">${formatNumber(row.car?.out)}</td>
        <td class="num">${formatNumber(row.motorcycle?.in)}</td>
        <td class="num">${formatNumber(row.motorcycle?.out)}</td>
        <td class="num">${formatNumber(row.people?.in)}</td>
        <td class="num">${formatNumber(row.people?.out)}</td>
        <td class="num num-strong">${formatNumber(row.total_car)}</td>
        <td class="num num-strong">${formatNumber(row.total_motorcycle)}</td>
        <td class="num num-strong">${formatNumber(row.total_people)}</td>
        <td>${escapeHtml(row.camera_name || '—')}</td>
        <td class="cell-time">${escapeHtml(formatDateTime(row.received_at))}</td>
      </tr>`).join('');
  }
  if (els.trendTableCount) {
    const first = rows.length ? firstRow + 1 : 0;
    const last = Math.min(firstRow + limit, rows.length);
    els.trendTableCount.textContent = `${formatNumber(first)}–${formatNumber(last)} / ${formatNumber(rows.length)} แถว`;
  }
  if (els.trendPageInfo) els.trendPageInfo.textContent = `หน้า ${formatNumber(currentPage + 1)} / ${formatNumber(pageCount)}`;
  if (els.trendPrevPage) els.trendPrevPage.disabled = loading || Boolean(error) || currentPage <= 0;
  if (els.trendNextPage) els.trendNextPage.disabled = loading || Boolean(error) || currentPage >= pageCount - 1;
  if (els.trendExportBtn) els.trendExportBtn.disabled = loading || Boolean(error) || rows.length === 0;
}

/** พับ/ขยายแถบตัวกรอง (ปุ่ม ⌗ บน rail) — ตัวกรองยังใช้ได้ทุกมุมมอง */
export function setFiltersCollapsed(collapsed) {
  if (!els.filtersSection) return;
  els.filtersSection.classList.toggle('is-collapsed', collapsed);
  els.filtersSection.hidden = collapsed;
  if (els.filtersToggleBtn) {
    els.filtersToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    els.filtersToggleBtn.textContent = collapsed ? '⌕ ตัวกรอง' : '× ซ่อนตัวกรอง';
  }
  document.querySelectorAll('[data-rail-action="filters"]').forEach((btn) => {
    btn.classList.toggle('is-active', !collapsed);
    btn.setAttribute('aria-pressed', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'เปิดตัวกรอง' : 'ซ่อนตัวกรอง');
    btn.title = collapsed ? 'เปิดตัวกรอง' : 'ซ่อนตัวกรอง';
  });
}

/** ชิปสรุปด้านขวาหัวกราฟ — จำนวนจุดที่แสดงจริง / ช่วงเวลาที่เลือก */
export function setChartInfo(text) {
  if (els.chartInfo) els.chartInfo.textContent = text || '—';
}

/** แถบตัวชี้วัด footer — ทุกค่ามาจากการวัดจริง (performance.now / จำนวนแถวจริง) */
export function renderMetrics({ latencyMs = null, newRows = null, rows = 0 } = {}) {
  if (els.tbLatency) {
    els.tbLatency.textContent = latencyMs === null ? '—' : `${formatNumber(latencyMs)} ms`;
    els.tbLatency.classList.toggle('is-warn', latencyMs !== null && latencyMs > 1000);
  }
  if (els.tbRows) els.tbRows.textContent = formatNumber(rows);
  if (els.tbNewRows) els.tbNewRows.textContent = newRows === null ? '—' : `+${formatNumber(newRows)}`;
}






/** นาฬิกา status bar + เวลา LAST PUSH แบบ relative (เวลาจริงของเครื่อง + timezone จริง) */
export function renderClock(now = new Date(), lastUpdated = null) {
  if (els.sbClock) {
    let tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      tz = '';
    }
    els.sbClock.textContent = `${formatClock(now)}${tz ? ' ' + tz : ''}`;
  }
  if (els.sbUpdated) {
    if (!lastUpdated) {
      els.sbUpdated.textContent = '—';
    } else {
      const sec = Math.max(0, Math.round((now.getTime() - lastUpdated.getTime()) / 1000));
      els.sbUpdated.textContent = sec < 60 ? `${sec} วินาทีที่แล้ว` : formatClock(lastUpdated);
    }
  }
}

/**
 * หน้าต่างมอนิเตอร์ (มุมมอง overview) — แสดงเฉพาะหน้าต่างที่ผู้ใช้เพิ่มและเลือกกล้องแล้ว
 * แต่ละหน้าต่างมีกล่องกราฟของตัวเอง (TrendChart) สร้างผ่าน onCreateChart callback
 * เพื่อให้ ui.js ไม่ต้อง import chart.js (แยกชั้น UI ออกจากตรรกะกราฟ)
 * groups: [{ id, count, vehicle, nonVehicle, person, series, lastLabel }]
 */
export function renderCameraWindows(
  groups,
  selectedIds = [],
  {
    cameras = [],
    cameraStates = new Map(),
    onCreateChart = null,
    onRemoveChart = null,
    container = els.cameraWindows,
    scope = 'overview',
    windowChartOptions = [],
    windowSizes = [],
    emptyMessage = 'ยังไม่มีหน้าต่างกราฟ กด “+ เพิ่มกราฟ” แล้วเลือกกล้องที่ต้องการ',
  } = {},
) {
  const el = container;
  if (!el) return;

  // ล้างหน้าต่างเดิม (แจ้ง callback ทุกตัวก่อนลบ)
  el.querySelectorAll('[data-cam-win]').forEach((node) => {
    if (onRemoveChart) onRemoveChart(`${scope}:${node.getAttribute('data-window-index')}`);
  });
  el.innerHTML = '';

  const groupList = Array.isArray(groups) ? groups : [];
  const cameraList = Array.isArray(cameras) ? cameras : [];
  const groupById = new Map(groupList.map((group) => [String(group.id), group]));
  const windows = Array.isArray(selectedIds) ? selectedIds : [];
  const options = cameraList.length ? cameraList : groupList.map(({ id }) => ({ camera_id: id }));
  const cameraOptions = (selectedId) => {
    const known = options.some((camera) => String(camera.camera_id) === selectedId);
    const selectedOption = selectedId && !known
      ? `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedId)} (ไม่พบในรายการ)</option>`
      : '';
    return selectedOption + options.map((camera) => {
      const id = String(camera.camera_id);
      const name = camera.camera_name && camera.camera_name !== id ? `${camera.camera_name} · ${id}` : id;
      return `<option value="${escapeHtml(id)}"${id === selectedId ? ' selected' : ''}>${escapeHtml(name)}</option>`;
    }).join('');
  };
  const windowSizeStyle = (index) => {
    const size = windowSizes[index];
    if (!size) return '';
    const width = Math.min(1800, Math.max(360, Math.round(Number(size.width) || 0)));
    const height = Math.min(1600, Math.max(560, Math.round(Number(size.height) || 0)));
    return ` style="width:${width}px;height:${height}px;flex:0 0 auto"`;
  };

  if (windows.length === 0) {
    el.innerHTML = `<div class="cam-empty cam-empty-start">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  el.insertAdjacentHTML(
    'beforeend',
    windows
      .map((selectedId, i) => {
        const g = selectedId ? groupById.get(String(selectedId)) : null;
        const key = selectedId ? String(selectedId) : '';
        const cameraState = key ? cameraStates.get(key) : null;
        const chipText = g
          ? `${formatNumber(g.count)} EV`
          : key && cameraState?.loading
            ? 'กำลังโหลด'
            : key && cameraState?.error
              ? 'โหลดไม่สำเร็จ'
              : key
                ? 'ไม่มีข้อมูล'
                : 'เลือกกล้อง';
        if (!key) {
          return `<article class="card win cam-win cam-win-slot"${windowSizeStyle(i)} data-window-index="${i}" data-window-scope="${scope}">
            <div class="win-head">
              <span class="win-code">CAM-${String(i + 1).padStart(2, '0')}</span>
              <h3 class="win-title">หน้าต่างกราฟ</h3>
              <label class="cam-picker">
                <span class="visually-hidden">เลือกกล้องสำหรับหน้าต่าง ${i + 1}</span>
                <select data-monitor-camera data-window-index="${i}" aria-label="เลือกกล้องสำหรับหน้าต่าง ${i + 1}">
                  <option value="" selected disabled>เลือกกล้อง…</option>
                  ${cameraOptions('')}
                </select>
              </label>
              <button class="btn btn-ghost btn-sm cam-remove" type="button" data-monitor-remove="${i}" aria-label="ลบหน้าต่างกราฟ ${i + 1}">×</button>
            </div>
            <div class="cam-empty-slot">เลือกกล้องเพื่อแสดงกราฟ</div>
          </article>`;
        }
        const title = g
          ? key
          : cameraState?.loading
            ? `${key} · กำลังโหลดข้อมูล`
            : cameraState?.error
              ? `${key} · โหลดข้อมูลไม่สำเร็จ`
              : `${key} · ไม่มีข้อมูลในช่วงตัวกรอง`;
        const mode = windowChartOptions[i]?.mode === 'delta' ? 'delta' : 'real';
        const metricValues = mode === 'delta'
          ? g?.delta
          : g?.latest
            ? {
                vehicle: g.latest.total_car,
                nonVehicle: g.latest.total_motorcycle,
                person: g.latest.total_people,
              }
            : null;
        return `<article class="card win cam-win"${windowSizeStyle(i)} data-cam-win="${escapeHtml(key)}" data-window-index="${i}" data-window-scope="${scope}">
          <div class="win-head">
            <span class="win-code">CAM-${String(i + 1).padStart(2, '0')}</span>
            <h3 class="win-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
            <label class="cam-picker">
              <span class="visually-hidden">เปลี่ยนกล้องในหน้าต่าง ${i + 1}</span>
              <select data-monitor-camera data-window-index="${i}" aria-label="เปลี่ยนกล้องในหน้าต่าง ${i + 1}">
                ${cameraOptions(key)}
              </select>
            </label>
            <button class="btn btn-ghost btn-sm cam-remove" type="button" data-monitor-remove="${i}" aria-label="ลบหน้าต่างกราฟ ${i + 1}">×</button>
            <span class="win-chip">${chipText}</span>
            <div class="cam-controls">
            <button type="button" class="mode-switch${mode === 'delta' ? ' is-delta' : ''}" role="switch" aria-checked="${mode === 'delta'}" data-window-mode-toggle data-window-index="${i}" aria-label="สลับโหมดกราฟ ${i + 1}">
              <span class="mode-switch-track" aria-hidden="true"><span></span></span>
              <span class="mode-switch-label">${mode === 'delta' ? 'ผลต่าง' : 'ค่าจริง'}</span>
            </button>
            <div class="trend-chart-options">
              <label class="trend-chart-option">
                <span>ช่วงกราฟ</span>
                <select data-trend-chart-range data-window-index="${i}" aria-label="ช่วงเวลาที่แสดงในกราฟ ${i + 1}">
                  ${[
                    ['15m', '15 นาที'],
                    ['30m', '30 นาที'],
                    ['1h', '1 ชม.'],
                    ['6h', '6 ชม.'],
                    ['1d', '1 วัน'],
                    ['3d', '3 วัน'],
                    ['7d', '7 วัน'],
                    ['1mo', '1 เดือน'],
                  ].map(([value, label]) => `<option value="${value}"${(windowChartOptions[i]?.range || '7d') === value ? ' selected' : ''}>${label}</option>`).join('')}
                </select>
              </label>
              <label class="trend-chart-option">
                <span>Tick / รวมข้อมูล</span>
                <select data-trend-chart-tick data-window-index="${i}" aria-label="ช่วงห่าง Tick ของกราฟ ${i + 1}">
                  ${[
                    [10_000, '10 วินาที'],
                    [60_000, '1 นาที'],
                    [600_000, '10 นาที'],
                    [1_800_000, '30 นาที'],
                    [3_600_000, '1 ชม.'],
                  ].map(([value, label]) => `<option value="${value}"${Number(windowChartOptions[i]?.tickIntervalMs || 3_600_000) === value ? ' selected' : ''}>${label}</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="series-toggles" role="group" aria-label="เลือกชุดข้อมูลของกราฟ ${escapeHtml(key)}">
              ${[
                ['total_car', 'Car', 'swatch-vehicle'],
                ['total_motorcycle', 'Motorcycle', 'swatch-non'],
                ['total_people', 'People', 'swatch-person'],
              ].map(([seriesKey, label, swatch]) => {
                const enabled = (windowChartOptions[i]?.visibleSeries || ['total_car', 'total_motorcycle', 'total_people']).includes(seriesKey);
                return `<button type="button" class="series-toggle${enabled ? ' is-on' : ''}" data-window-index="${i}" data-cam-series-key="${seriesKey}" aria-pressed="${enabled}"><i class="swatch ${swatch}"></i>${label}</button>`;
              }).join('')}
            </div>
          </div>
          </div>
          ${g ? `<div class="chart-wrap chart-wrap-mini cam-chart-wrap" data-cam-chart-wrap="${escapeHtml(key)}">
            <div class="chart-tooltip" data-cam-tooltip="${escapeHtml(key)}" hidden></div>
          </div>
          <div class="cam-history-control">
            <button type="button" class="btn btn-ghost btn-sm cam-history-step" data-cam-history-prev aria-label="เลื่อนกรอบกราฟ ${i + 1} ย้อนหลัง" title="ย้อนกลับหนึ่งช่วง" disabled>‹</button>
            <input type="range" min="0" max="0" value="0" step="1" data-cam-history-slider aria-label="เลื่อนดูข้อมูลย้อนหลังของกราฟ ${i + 1}" disabled>
            <button type="button" class="btn btn-ghost btn-sm cam-history-step" data-cam-history-next aria-label="เลื่อนกรอบกราฟ ${i + 1} ไปข้างหน้า" title="ไปข้างหน้าหนึ่งช่วง" disabled>›</button>
            <output data-cam-history-label>—</output>
          </div>` : `<div class="cam-empty-slot">${cameraState?.loading
            ? 'กำลังโหลดข้อมูลของกล้อง…'
            : cameraState?.error
              ? `โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(cameraState.error.message)}`
              : 'ไม่มีข้อมูลของกล้องนี้ในช่วงเวลาที่เลือก'}</div>`}
          <div class="cam-metrics" aria-label="${mode === 'delta' ? 'ผลต่างจากข้อมูลก่อนหน้า' : 'ค่าล่าสุดของกราฟ'}">
            ${[
              ['CAR', 'vehicle', 't-vehicle'],
              ['MOTORCYCLE', 'nonVehicle', 't-non'],
              ['PEOPLE', 'person', 't-person'],
            ].map(([label, key, colorClass]) => {
              const value = metricValues?.[key];
              const direction = mode !== 'delta' || value === null || value === undefined
                ? 'unknown'
                : value > 0 ? 'up' : 'down';
              const formattedValue = value === null || value === undefined
                ? '—'
                : mode === 'delta' && value > 0
                  ? `+${formatNumber(value)}`
                  : formatNumber(value);
              return `<div class="cam-metric">
                <span class="micro ${colorClass}">${label}</span>
                <strong>${mode === 'delta' ? `<svg class="cam-trend-icon is-${direction}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 4.5 11h4.3v9h6.4v-9h4.3L12 3z"/></svg>` : ''}<span class="cam-metric-delta is-${direction}">${formattedValue}</span></strong>
              </div>`;
            }).join('')}
          </div>
          <p class="cam-foot"><span class="micro">LAST EVENT</span><code>${escapeHtml(g ? g.lastLabel : '—')}</code></p>
        </article>`;
      })
      .join(''),
  );

  if (!onCreateChart) return;
  windows.forEach((selectedId, i) => {
    if (!selectedId) return;
    const g = groupById.get(String(selectedId));
    if (!g) return;
    // หาผ่านโครงสร้าง DOM โดยตรง (ไม่สร้าง CSS selector จาก camera_id — กันเครื่องหมายพิเศษ)
    const nodes = el.querySelectorAll('[data-cam-win]');
    const node = Array.from(nodes).find((item) => item.getAttribute('data-window-index') === String(i));
    if (!node) return;
    const wrap = node.querySelector('[data-cam-chart-wrap]');
    const tip = node.querySelector('[data-cam-tooltip]');
    if (!wrap || !tip) return;
    onCreateChart(String(g.id), `${scope}:${i}`, wrap, tip, g.series, windowChartOptions[i]);
  });
}

/** ตารางเหตุการณ์ล่าสุดใต้กริดมอนิเตอร์ (มุมมอง overview) — ไม่มีกราฟคู่ (แยกตามมุมมองแล้ว) */
export function renderMonitorTable(rows, { maxRows = 12 } = {}) {
  const body = els.monitorTableBody;
  const state = els.monitorTableState;
  const chip = els.monitorTableChip;
  const scroll = body && body.closest('.table-scroll');
  const list = Array.isArray(rows) ? rows : [];

  if (!body) return;
  if (list.length === 0) {
    if (state) {
      state.hidden = false;
      state.className = 'state-block state-empty';
      state.innerHTML = '<p class="state-msg">ไม่พบข้อมูลในช่วงเวลาที่เลือก</p>';
    }
    if (scroll) scroll.hidden = true;
    body.innerHTML = '';
    if (chip) {
      chip.textContent = '0 รายการ';
      chip.className = 'win-chip';
    }
    return;
  }

  if (state) state.hidden = true;
  if (scroll) scroll.hidden = false;

  const shown = list.slice(0, maxRows);
  body.innerHTML = shown
    .map((r) => {
      return `<tr>
        <td class="cell-time">${escapeHtml(formatDateTime(r.event_time || r.received_at))}</td>
        <td><span class="cam-name">${escapeHtml(r.camera_id || '—')}</span></td>
        <td class="num">${formatNumber(r.car?.in)}</td>
        <td class="num">${formatNumber(r.car?.out)}</td>
        <td class="num">${formatNumber(r.motorcycle?.in)}</td>
        <td class="num">${formatNumber(r.motorcycle?.out)}</td>
        <td class="num">${formatNumber(r.people?.in)}</td>
        <td class="num">${formatNumber(r.people?.out)}</td>
        <td class="num num-strong">${formatNumber(r.total_car)}</td>
        <td class="num num-strong">${formatNumber(r.total_motorcycle)}</td>
        <td class="num num-strong">${formatNumber(r.total_people)}</td>
        <td>${escapeHtml(r.camera_name || '—')}</td>
        <td class="cell-time">${escapeHtml(formatDateTime(r.received_at))}</td>
      </tr>`;
    })
    .join('');

  if (chip) {
    chip.textContent = `${formatNumber(list.length)} รายการ`;
    chip.className = 'win-chip';
  }
}
