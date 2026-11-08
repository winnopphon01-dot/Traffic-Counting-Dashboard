// กราฟแนวโน้มตามเวลา (SVG เขียนเอง — ไม่มี dependency ภายนอก/CDN)
// เส้นแสดงแนวโน้มทุกจุด; จุดกะพริบแสดงเฉพาะค่าล่าสุดของแต่ละชุดข้อมูล
import { toDate, formatDateTime, formatNumber, formatAxisTime, RANGE_MS } from './format.js';

let nextChartId = 0;
const chartMotionStates = new Map();

const SERIES = [
  { key: 'total_car', label: 'Car', color: '#059669' },
  { key: 'total_motorcycle', label: 'Motorcycle', color: '#d97706' },
  { key: 'total_people', label: 'People', color: '#0284c7' },
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function niceStep(raw) {
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// เส้นโค้งนุ่มแบบ Monotone Cubic (Fritsch–Carlson) → Cubic Bezier
// ต่างจาก Catmull-Rom ตรงที่ "ไม่ overshoot และไม่วนกลับตัว" (loop) ได้เลย
// สมบัตินี้สำคัญกับข้อมูล IoT ที่มีหลายจุดค่าแตกต่างกันแต่เวลาเกือบเท่ากัน
// เพราะ Catmull-Rom จะดันจุดควบคุมล้ำเส้นกรอบจนเกิดวงก景วนอ่านค่าไม่ได้
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  if (n === 2) {
    return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  }

  // ความชันของแต่ละเซ็กเมนต์ (ถ้า x ซ้ำกันให้ความชัน 0 เพื่อกันค่าลิม)
  const slopes = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = pts[i + 1][0] - pts[i][0];
    slopes.push(dx === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx);
  }

  // ความชันที่จุดยอด (tangent) แบบรักษาความเอียงเดียว (monotone)
  const tangents = new Array(n);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    const m0 = slopes[i - 1];
    const m1 = slopes[i];
    if (m0 * m1 <= 0) {
      tangents[i] = 0; // จุดเปลี่ยนทิศ — ล็อกให้แบนเพื่อกัน overshoot
    } else {
      // หารรับความชัน (harmonic mean)
      const w0 = 2 * (pts[i + 1][0] - pts[i][0]) + (pts[i][0] - pts[i - 1][0]);
      const w1 = (pts[i + 1][0] - pts[i][0]) + 2 * (pts[i][0] - pts[i - 1][0]);
      tangents[i] = (w0 + w1) / (w0 / m0 + w1 / m1);
    }
  }

  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = pts[i + 1][0] - pts[i][0];
    const c1x = pts[i][0] + h / 3;
    const c1y = pts[i][1] + (tangents[i] * h) / 3;
    const c2x = pts[i + 1][0] - h / 3;
    const c2y = pts[i + 1][1] - (tangents[i + 1] * h) / 3;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

// รวมจุดที่เวลาใกล้กันเป็นกลุ่มเดียว (time bucketing) แล้วบวกค่าสะสม
// จำเป็นที่สุดกับข้อมูล IoT ที่สตรีมถี่เกินไป: 300 รายการอาจเกิดขึ้นในไม่กี่วินาที
// ถ้าไม่รวมกลุ่ม แกนเวลาจะถูกดึงกว้างออกตามความกระจายของการสตรีม แล้วจุดทั้งหมด
// ทับกันที่ขอบขวาอ่านค่าไม่ได้ (ปัญหาที่เห็นบนหน้าจอจริง)
// ขนาดถังคำนวณจากช่วงเวลาทั้งหมดและจำนวนจุดที่ต้องการ เพื่อให้กราฟอ่านง่ายทุกช่วง
const TARGET_BUCKETS = 60;
const DISPLAY_POINTS = 48;
const BUCKET_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 86400];

function reduceDisplayPoints(points) {
  if (points.length <= DISPLAY_POINTS) return points;
  const bucketSize = Math.ceil(points.length / DISPLAY_POINTS);
  const reduced = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    const values = { total_car: 0, total_motorcycle: 0, total_people: 0 };
    for (const point of bucket) {
      for (const series of SERIES) values[series.key] += Number(point.values?.[series.key]) || 0;
    }
    for (const series of SERIES) values[series.key] /= bucket.length;
    const last = bucket[bucket.length - 1];
    reduced.push({
      ...last,
      t: bucket.reduce((sum, point) => sum + point.t, 0) / bucket.length,
      values,
    });
  }
  return reduced;
}

function motionStateFor(key) {
  if (!chartMotionStates.has(key)) {
    chartMotionStates.set(key, {
      range: 'all',
      span: null,
      viewMin: null,
      panOffsetMs: 0,
      latestT: null,
      latestSignature: null,
      transition: null,
      recenter: null,
    });
  }
  return chartMotionStates.get(key);
}

function easeInOut(value) {
  return value < 0.5 ? 4 * value * value * value : 1 - ((-2 * value + 2) ** 3) / 2;
}

function animationValue(animation, now) {
  if (!animation) return null;
  const progress = Math.min(1, Math.max(0, (now - animation.start) / animation.duration));
  const eased = easeInOut(progress);
  return { progress, value: animation.from + (animation.to - animation.from) * eased };
}

function pickBucketSeconds(minT, maxT, count) {
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) return 1;
  // ถ้าข้อมูลกระจายดีอยู่แล้ว (จุดต่อวินาทีต่ำ) ไม่ต้องรวมกลุ่ม
  const spanSec = (maxT - minT) / 1000;
  if (count <= TARGET_BUCKETS && spanSec / Math.max(1, count) >= 0.5) return 1;
  const want = Math.max(1, Math.ceil(spanSec / TARGET_BUCKETS));
  for (const s of BUCKET_STEPS) if (s >= want) return s;
  return BUCKET_STEPS[BUCKET_STEPS.length - 1];
}



function aggregatePoints(rows) {
  if (!rows || rows.length === 0) return [];
  let minT = Infinity;
  let maxT = -Infinity;
  for (const r of rows) {
    if (Number.isFinite(r.t)) {
      if (r.t < minT) minT = r.t;
      if (r.t > maxT) maxT = r.t;
    }
  }
  const bucketSec = pickBucketSeconds(minT, maxT, rows.length);
  const groups = new Map();
  for (const r of rows) {
    const bucket = Number.isFinite(r.t) ? Math.floor(r.t / (bucketSec * 1000)) * bucketSec * 1000 : r.t;
    const key = bucket;
    if (!groups.has(key)) {
      groups.set(key, {
        t: bucket,
        time: r.time,
        cameraId: r.cameraId,
        count: 0,
        values: { total_car: 0, total_motorcycle: 0, total_people: 0 },
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.time = r.t >= g.t ? r.time : g.time; // เวลาแทนของกลุ่ม = รายการล่าสุดในถัง
    for (const s of SERIES) g.values[s.key] += Number(r.values?.[s.key]) || 0;
  }
  return [...groups.values()].sort((a, b) => a.t - b.t);
}

export class TrendChart {
  constructor(wrap, tooltip, opts = {}) {
    this.wrap = wrap;
    this.tooltip = tooltip;
    this.compact = Boolean(opts.compact); // กราฟย่อ: สูงน้อยลง ซ่อนป้ายแกน
    this.historyMode = Boolean(opts.historyMode);
    this.tickIntervalMs = Number(opts.tickIntervalMs) || 10 * 60 * 1000;
    this.historyOffsetMs = Math.max(0, Number(opts.historyOffsetMs) || 0);
    this.onHistoryOffsetChange = typeof opts.onHistoryOffsetChange === 'function'
      ? opts.onHistoryOffsetChange
      : null;
    this.chartId = ++nextChartId;
    this.motionKey = opts.motionKey ? String(opts.motionKey) : null;
    this.motion = this.motionKey ? motionStateFor(this.motionKey) : null;
    this.refreshStepMs = Math.max(1000, Number(opts.refreshStepMs) || 30_000);
    this.range = opts.range || this.motion?.range || 'all';
    if (this.motion && this.motion.range !== this.range) {
      this.motion.range = this.range;
      this.motion.span = null;
      this.motion.viewMin = null;
      this.motion.panOffsetMs = 0;
      this.motion.latestT = null;
      this.motion.latestSignature = null;
      this.motion.lastRawT = null;
      this.motion.transition = null;
      this.motion.recenter = null;
      this.motion.fromValues = null;
      this.motion.latestValues = null;
    }
    this.animationFrame = null;
    this.visibleKeys = new Set(SERIES.map((s) => s.key)); // series ที่เปิดอยู่บนกราฟ
    this._lastWidth = 0; // ความกว้างล่าสุดที่วัดได้ (กันกรณี clientWidth=0 ชั่วคราวแล้ว SVG แคบตายตัว)
    this.points = [];
    this.geometry = null;
    const card = wrap.closest('.cam-win');
    this.historySlider = card?.querySelector('[data-cam-history-slider]') || null;
    this.historyLabel = card?.querySelector('[data-cam-history-label]') || null;
    this.historyPrevButton = card?.querySelector('[data-cam-history-prev]') || null;
    this.historyNextButton = card?.querySelector('[data-cam-history-next]') || null;
    this.historySlider?.addEventListener('input', () => {
      const latestPage = Number(this.historySlider.max) || 0;
      const selectedPage = Number(this.historySlider.value) || 0;
      const offset = Math.max(0, latestPage - selectedPage) * this._historyPageMs();
      this._setHistoryOffset(offset);
      this._applyWindowView();
      this.render();
    });
    this.historyPrevButton?.addEventListener('click', () => this._moveHistoryPage(1));
    this.historyNextButton?.addEventListener('click', () => this._moveHistoryPage(-1));
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(wrap);
    wrap.addEventListener('mousemove', (e) => this._onMouseMove(e));
    wrap.addEventListener('mouseleave', () => this._hideTooltip());
  }

  /** ตั้ง series ที่จะแสดงบนกราฟ — ถ้าปิดหมดจะยกเลิก (ต้องเปิดอย่างน้อย 1 ชุด) */
  setVisibleSeries(keys) {
    const list = Array.isArray(keys) ? keys.filter((k) => SERIES.some((s) => s.key === k)) : [];
    if (list.length === 0) return; // ห้ามปิดทั้ง 3 ชุด
    this.visibleKeys = new Set(list);
    this.render();
  }

  _activeSeries() {
    return SERIES.filter((s) => this.visibleKeys.has(s.key));
  }

  /** รวมจุดที่เวลาใกล้กันก่อนคำนวณแกน — ลดการทับของจุดให้มากที่สุด */
  _normalize(rows) {
    const mapped = (rows || [])
      .map((r) => {
        const t = toDate(r.event_time) || toDate(r.received_at);
        if (!t) return null;
        return {
          t: t.getTime(),
          time: t,
          cameraId: r.camera_id || '',
          values: {
            total_car: Number(r.total_car) || 0,
            total_motorcycle: Number(r.total_motorcycle) || 0,
            total_people: Number(r.total_people) || 0,
          },
        };
      })
      .filter(Boolean);
    return aggregatePoints(mapped).sort((a, b) => a.t - b.t);
  }

  setData(rows) {
    this.points = this._normalize(rows);
    this.render();
  }

  render() {
    this._renderLine();
  }

  clear() {
    this.points = [];
    this.geometry = null;
    this._hideTooltip();
    const svg = this.wrap.querySelector('svg');
    if (svg) svg.remove();
  }

  /** รับจุดที่ normalize ไว้แล้ว (เช่น จากมอนิเตอร์รายกล้อง) — รูปแบบเดียวกับผลลัพธ์ของ setData */
  setPoints(points) {
    this.allPoints = (points || [])
      .filter((p) => p && Number.isFinite(p.t) && p.values)
      .sort((a, b) => a.t - b.t);
    this._applyWindowView();
    if (this.historyMode) {
      this.render();
      return;
    }
    this._updateMotionTarget();
    this.render();
    this._scheduleMotionFrame();
  }

  /** กรองช่วงเวลาจากจุดดิบที่เก็บไว้ (allPoints) โดยไม่ต้องคำนวณ _normalize ใหม่ */
  setRange(range) {
    const nextRange = RANGE_MS[range] ? range : 'all';
    if (this.range !== nextRange) {
      this.range = nextRange;
      if (this.motion) {
        this.motion.range = nextRange;
        this.motion.span = null;
        this.motion.viewMin = null;
        this.motion.recenter = null;
        this.motion.panOffsetMs = 0;
      }
    }
    this._applyWindowView();
    if (!this.historyMode) {
      if (this.motion && this.points.length > 0) {
        this.motion.latestValues = { ...this.points[this.points.length - 1].values };
      }
      this._updateMotionTarget();
    }
    this.render();
    if (!this.historyMode) this._scheduleMotionFrame();
  }

  setTickInterval(intervalMs) {
    const next = Number(intervalMs);
    if (!Number.isFinite(next) || next <= 0 || next === this.tickIntervalMs) return;
    this.tickIntervalMs = next;
    this._applyWindowView();
    if (this.motion && this.points.length > 0) {
      this.motion.latestValues = { ...this.points[this.points.length - 1].values };
    }
    this.render();
    if (!this.historyMode) this._scheduleMotionFrame();
  }

  _historyPageMs() {
    return RANGE_MS[this.range] || 0;
  }

  _moveHistoryPage(direction) {
    if (!this._historyPageMs()) return;
    const pageMs = this._historyPageMs();
    const currentOffset = this.historyMode
      ? this.historyOffsetMs
      : Number(this.motion?.panOffsetMs) || 0;
    const maxOffset = Math.max(0, Math.floor(
      (this.allPoints[this.allPoints.length - 1]?.t - this.allPoints[0]?.t) / pageMs,
    ) * pageMs);
    this._setHistoryOffset(Math.min(maxOffset, Math.max(0, currentOffset + direction * pageMs)));
    this._applyWindowView();
    this.render();
  }

  _setHistoryOffset(offset) {
    const nextOffset = Math.max(0, Number(offset) || 0);
    if (this.historyMode) {
      this.historyOffsetMs = nextOffset;
      this.onHistoryOffsetChange?.(nextOffset);
      return;
    }
    if (!this.motion) return;
    this.motion.panOffsetMs = nextOffset;
    this.motion.transition = null;
    this.motion.recenter = null;
  }

  _applyWindowView() {
    if (!this.allPoints || this.allPoints.length === 0) {
      this.points = [];
      this.historyLatestT = null;
      this._updateHistorySlider(0, 0);
      return;
    }
    const latestT = this.allPoints[this.allPoints.length - 1].t;
    const rangeMs = RANGE_MS[this.range];
    const earliestT = this.allPoints[0].t;
    const maxOffset = rangeMs
      ? Math.floor((latestT - earliestT) / rangeMs) * rangeMs
      : latestT - earliestT;
    const requestedOffset = this.historyMode
      ? this.historyOffsetMs
      : Number(this.motion?.panOffsetMs) || 0;
    const offset = Math.min(maxOffset, Math.max(0, requestedOffset));
    if (this.historyMode) this.historyOffsetMs = offset;
    else if (this.motion) this.motion.panOffsetMs = offset;
    const viewEndT = latestT - offset;
    const cutoff = rangeMs ? viewEndT - rangeMs : earliestT;
    this.historyLatestT = viewEndT;
    this._updateHistorySlider(offset, maxOffset, viewEndT);
    const buckets = new Map();
    for (const point of this.allPoints) {
      if (point.t < cutoff || point.t > viewEndT) continue;
      const bucketT = Math.max(
        cutoff,
        Math.floor(point.t / this.tickIntervalMs) * this.tickIntervalMs,
      );
      let bucket = buckets.get(bucketT);
      if (!bucket) {
        bucket = {
          t: bucketT,
          time: point.time,
          cameraId: point.cameraId,
          count: 0,
          values: { total_car: 0, total_motorcycle: 0, total_people: 0 },
        };
        buckets.set(bucketT, bucket);
      }
      bucket.count += 1;
      bucket.time = point.time;
      for (const series of SERIES) {
        bucket.values[series.key] += Number(point.values[series.key]) || 0;
      }
    }
    this.points = reduceDisplayPoints([...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        values: Object.fromEntries(
          SERIES.map((series) => [series.key, bucket.values[series.key] / bucket.count]),
        ),
      }))
      .sort((a, b) => a.t - b.t));
  }

  _updateHistorySlider(offset, maxOffset, viewEndT = null) {
    if (!this.historySlider) return;
    const pageMs = this._historyPageMs();
    const maxPage = pageMs > 0 ? Math.floor(maxOffset / pageMs) : 0;
    const currentOffsetPage = pageMs > 0 ? Math.round(offset / pageMs) : 0;
    this.historySlider.max = String(maxPage);
    this.historySlider.value = String(Math.max(0, maxPage - currentOffsetPage));
    this.historySlider.disabled = maxPage <= 0;
    if (this.historyPrevButton) this.historyPrevButton.disabled = currentOffsetPage >= maxPage;
    if (this.historyNextButton) this.historyNextButton.disabled = currentOffsetPage <= 0;
    if (this.historyLabel) {
      const endT = Number.isFinite(viewEndT) ? viewEndT : this.allPoints?.at(-1)?.t;
      const startT = endT - (pageMs || maxOffset);
      this.historyLabel.textContent = Number.isFinite(startT) && Number.isFinite(endT)
        ? `${formatDateTime(new Date(startT))} – ${formatDateTime(new Date(endT))}`
        : '—';
    }
  }

  _updateMotionTarget() {
    if (!this.motion || this.allPoints.length === 0) return;
    const latest = this.allPoints[this.allPoints.length - 1];
    const signature = `${latest.t}|${SERIES.map((series) => latest.values[series.key]).join('|')}`;
    if (signature === this.motion.latestSignature) return;
    const latestDisplayValues = this.points[this.points.length - 1]?.values || latest.values;

    const now = performance.now();
    const previousTarget = this.motion.latestT;
    const currentTransition = animationValue(this.motion.transition, now);
    const from = currentTransition ? currentTransition.value : previousTarget;
    let fromValues = this.motion.latestValues;
    if (currentTransition && currentTransition.progress < 1 && this.motion.fromValues) {
      const eased = easeInOut(currentTransition.progress);
      fromValues = Object.fromEntries(SERIES.map((series) => [
        series.key,
        this.motion.fromValues[series.key] +
          (this.motion.latestValues[series.key] - this.motion.fromValues[series.key]) * eased,
      ]));
    }
    let to = latest.t;
    const indexAxis = new Set(this.allPoints.map((point) => point.t)).size < this.allPoints.length * 0.6;
    if (previousTarget !== null && indexAxis) {
      const rawDelta = Math.max(0, latest.t - (this.motion.lastRawT ?? latest.t));
      const times = this.allPoints.map((point) => point.t);
      const dataSpan = Math.max(...times) - Math.min(...times) || 60 * 60 * 1000;
      const desiredSpan = RANGE_MS[this.range] || Math.max(dataSpan, 60 * 60 * 1000) * 2;
      const displaySlots = Math.max(12, Math.min(DISPLAY_POINTS, this.allPoints.length));
      const pointStep = desiredSpan / (2 * Math.max(1, displaySlots - 1));
      to = Math.max(latest.t, from + Math.max(rawDelta, this.refreshStepMs, pointStep));
    }
    if (previousTarget !== null && to <= from) to = from + this.refreshStepMs;

    if (previousTarget === null) {
      this.motion.latestT = to;
      this.motion.transition = null;
    } else if (to > from) {
      this.motion.transition = { from, to, start: now, duration: 1100 };
      this.motion.fromValues = fromValues || { ...latest.values };
      this.motion.latestT = to;
    } else {
      this.motion.latestT = latest.t;
      this.motion.transition = null;
    }

    this.motion.latestSignature = signature;
    this.motion.lastRawT = latest.t;
    this.motion.latestValues = { ...latestDisplayValues };
    this.motion.latestTime = latest.time;
  }

  _scheduleMotionFrame() {
    if (!this.motion || this.animationFrame !== null) return;
    this.animationFrame = requestAnimationFrame((now) => {
      this.animationFrame = null;
      this.render();
      const transition = animationValue(this.motion.transition, now);
      const recenter = animationValue(this.motion.recenter, now);
      if ((transition && transition.progress < 1) || (recenter && recenter.progress < 1) ||
          (this.motion.recenter && now < this.motion.recenter.start)) {
        this._scheduleMotionFrame();
      }
    });
  }

  dispose() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this._ro.disconnect();
  }

  /** วาดกราฟเส้นตามข้อมูลจริง */
  _renderLine() {
    const old = this.wrap.querySelector('svg');
    if (old) old.remove();
    if (this.points.length === 0) {
      this.geometry = null;
      return;
    }

    // วัดความกว้างจริงของกล่อง ถ้าอ่านไม่ได้ (เช่น ถูกซ่อน/เพิ่ง unmount) ให้อ้างค่าล่าสุดก่อน
    const measured = Math.round(this.wrap.clientWidth || 0);
    if (measured > 0) this._lastWidth = measured;
    const width = Math.max(
      this.compact ? 220 : 260,
      this._lastWidth || (this.compact ? 320 : 300),
    );
    const fullscreen = this.wrap.closest('#chartSection') === document.fullscreenElement;
    const height = this.compact
      ? Math.max(220, Math.round(this.wrap.clientHeight || Math.min(320, Math.max(220, width * 0.55))))
      : fullscreen
        ? Math.max(320, Math.round(this.wrap.clientHeight || window.innerHeight - 160))
        : Math.round(Math.min(360, Math.max(230, width * 0.42)));
    const m = this.compact
      ? { top: 8, right: 40, bottom: 30, left: 34 }
      : { top: 14, right: 66, bottom: 42, left: 14 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;

    const times = this.points.map((p) => p.t);
    let minT = Math.min(...times);
    const panned = Boolean(this.motion && this.motion.panOffsetMs > 0);
    let maxT = (this.historyMode || panned) && Number.isFinite(this.historyLatestT)
      ? this.historyLatestT
      : Math.max(...times);
    const dataSpan = maxT === minT ? 60 * 60 * 1000 : maxT - minT;
    const distinctTimes = new Set(times).size;
    const useIndexAxis = distinctTimes < Math.ceil(this.points.length * 0.6);
    const now = performance.now();
    let latestT = maxT;
    let latestValues = this.points[this.points.length - 1].values;
    if (this.motion && !panned) {
      const transition = animationValue(this.motion.transition, now);
      latestT = transition ? transition.value : (this.motion.latestT ?? maxT);
      if (transition && transition.progress >= 1) this.motion.transition = null;
      const latestPoint = this.points[this.points.length - 1];
      if (transition && transition.progress < 1 && this.motion.fromValues) {
        const eased = easeInOut(transition.progress);
        latestValues = Object.fromEntries(SERIES.map((series) => [
          series.key,
          this.motion.fromValues[series.key] +
            (this.motion.latestValues[series.key] - this.motion.fromValues[series.key]) * eased,
        ]));
      } else {
        latestValues = this.motion.latestValues || latestPoint.values;
      }
    }

    const requestedSpan = RANGE_MS[this.range] || Math.max(dataSpan, 60 * 60 * 1000) * 2;
    if (this.motion && (!this.motion.span || !Number.isFinite(this.motion.viewMin))) {
      this.motion.span = requestedSpan;
      this.motion.viewMin = latestT - requestedSpan / 2;
    }
    const span = this.historyMode ? requestedSpan : (this.motion?.span || requestedSpan);
    let viewMinT = this.historyMode || panned
      ? maxT - span
      : (this.motion?.viewMin ?? latestT - span / 2);
    if (this.motion && !panned) {
      const targetFraction = (this.motion.latestT - viewMinT) / span;
      if (targetFraction >= 0.82 && !this.motion.recenter) {
        this.motion.recenter = {
          from: viewMinT,
          to: this.motion.latestT - span / 2,
          start: now + 250,
          duration: 950,
        };
      }
      const recenter = animationValue(this.motion.recenter, now);
      if (recenter) {
        viewMinT = recenter.value;
        if (recenter.progress >= 1) {
          this.motion.viewMin = this.motion.recenter.to;
          this.motion.recenter = null;
          viewMinT = this.motion.viewMin;
        }
      }
    }

    const plotPoints = this.points.map((point, index) => {
      let t = point.t;
      if (useIndexAxis && this.motion && !panned) {
        const step = span / (2 * Math.max(1, this.points.length - 1));
        t = latestT - (this.points.length - 1 - index) * step;
      } else if (index === this.points.length - 1) {
        t = latestT;
      }
      return { ...point, t, values: index === this.points.length - 1 ? latestValues : point.values };
    });
    const viewMaxT = viewMinT + span;

    const active = this._activeSeries();
    let minV = Infinity;
    let maxV = -Infinity;
    let latestTotal = 0;
    for (const s of active) latestTotal += latestValues[s.key];
    const centerV = latestTotal / active.length;
    for (const p of plotPoints) {
      for (const s of active) {
        minV = Math.min(minV, p.values[s.key]);
        maxV = Math.max(maxV, p.values[s.key]);
      }
    }
    const radius = Math.max(maxV - centerV, centerV - minV, Math.abs(centerV) * 0.05, 1) * 1.2;
    const step = niceStep(Math.max(1, (radius * 2) / 4));
    const tickRadius = Math.ceil(radius / step) * step;
    const yMin = centerV - tickRadius;
    const yMax = centerV + tickRadius;
    const tickCount = Math.round((yMax - yMin) / step);

    const x = (t) => m.left + ((t - viewMinT) / span) * iw;
    const y = (v) => m.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
    this.plotPoints = plotPoints;
    this.geometry = {
      width,
      height,
      m,
      iw,
      ih,
      minT: viewMinT,
      span,
      x,
      y,
      useIndexAxis,
      plotPoints,
    };

    const parts = [];
    parts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="กราฟแนวโน้ม Car Motorcycle People ตามเวลา">`);
    parts.push('<defs>');
    active.forEach((s) => {
      const gradientId = `chart-area-${this.chartId}-${s.key}`;
      parts.push(
        `<linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="${s.color}" stop-opacity="0.2"/>` +
          `<stop offset="100%" stop-color="${s.color}" stop-opacity="0.008"/>` +
        '</linearGradient>',
      );
    });
    parts.push('</defs>');

    for (let i = 0; i <= tickCount; i += 1) {
      const v = yMin + i * step;
      const yy = y(v);
      const plotRight = width - m.right;
      parts.push(`<line x1="${m.left}" y1="${yy.toFixed(1)}" x2="${plotRight}" y2="${yy.toFixed(1)}" stroke="rgba(100,116,139,0.18)"/>`);
      parts.push(`<text x="${plotRight + (this.compact ? 4 : 7)}" y="${(yy + 4).toFixed(1)}" text-anchor="start" font-size="${this.compact ? 9 : 11}" fill="#64748b">${formatNumber(Math.round(v))}</text>`);
    }

    const xTicks = this.compact ? 3 : width < 520 ? 3 : 5;
    for (let i = 0; i <= xTicks; i += 1) {
      const t = viewMinT + (i / xTicks) * span;
      const xx = m.left + (i / xTicks) * iw;
      parts.push(`<line x1="${xx.toFixed(1)}" y1="${m.top}" x2="${xx.toFixed(1)}" y2="${m.top + ih}" stroke="rgba(100,116,139,0.12)"/>`);
      const anchor = i === 0 ? 'start' : i === xTicks ? 'end' : 'middle';
      parts.push(`<text x="${xx.toFixed(1)}" y="${height - (this.compact ? 15 : 19)}" text-anchor="${anchor}" font-size="${this.compact ? 9 : 11}" fill="#64748b">${formatAxisTime(new Date(t), span)}</text>`);
    }

    active.forEach((s) => {
      const pts = plotPoints.map((p) => [x(p.t), y(p.values[s.key])]);
      const linePath = smoothPath(pts);
      const first = pts[0];
      const last = pts[pts.length - 1];
      const plotBottom = m.top + ih;
      const areaPath = `${linePath} L${last[0].toFixed(1)},${plotBottom.toFixed(1)} L${first[0].toFixed(1)},${plotBottom.toFixed(1)} Z`;
      parts.push(
        `<path d="${areaPath}" fill="url(#chart-area-${this.chartId}-${s.key})" stroke="none"/>`,
      );
      parts.push(
        `<path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      parts.push(`<circle class="chart-live-halo" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="7" fill="${s.color}"/>`);
      parts.push(`<circle class="chart-live-dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="${s.color}"/>`);
    });

    parts.push(`<line class="hover-line" x1="0" y1="${m.top}" x2="0" y2="${m.top + ih}" stroke="rgba(71,85,105,0.45)" stroke-dasharray="4 3" visibility="hidden"/>`);
    parts.push(
      `<g class="hover-dots" visibility="hidden">` +
        active.map((s) => `<circle r="4.5" fill="${s.color}" stroke="#ffffff" stroke-width="1.5" cx="0" cy="0" data-k="${s.key}"/>`).join('') +
        `</g>`,
    );
    const plotRight = width - m.right;
    const plotBottom = m.top + ih;
    parts.push(`<line x1="${m.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="rgba(148,163,184,0.45)"/>`);
    parts.push(`<line x1="${plotRight}" y1="${m.top}" x2="${plotRight}" y2="${plotBottom}" stroke="rgba(148,163,184,0.45)"/>`);
    parts.push(`<text x="${((m.left + plotRight) / 2).toFixed(1)}" y="${height - (this.compact ? 2 : 3)}" text-anchor="middle" font-size="${this.compact ? 9 : 11}" fill="#64748b">Time</text>`);
    parts.push(`<text x="${width - 7}" y="${(m.top + ih / 2).toFixed(1)}" text-anchor="middle" font-size="${this.compact ? 9 : 11}" fill="#64748b" transform="rotate(90 ${width - 7} ${(m.top + ih / 2).toFixed(1)})">${this.compact ? 'Val' : 'Value'}</text>`);
    parts.push('</svg>');

    this.wrap.insertAdjacentHTML('afterbegin', parts.join(''));
  }

  _onMouseMove(e) {
    const g0 = this.geometry;
    if (!g0) return;
    const g = g0;
    if (!g || this.points.length === 0) return;
    const rect = this.wrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const scale = g.width / rect.width;
    const svgX = (e.clientX - rect.left) * scale;

    let best = null;
    let bestIdx = -1;
    let bestDist = Infinity;
    const tAt = g.minT + ((svgX - g.m.left) / g.iw) * g.span;
    g.plotPoints.forEach((p, i) => {
      const d = Math.abs(p.t - tAt);
      if (d < bestDist) {
        bestDist = d;
        best = this.points[i];
        bestIdx = i;
      }
    });
    if (!best) return;
    this._showAt(best, g, e, rect, scale, bestIdx);
  }

  _showAt(p, g, e, rect, scale, idx = -1) {
    const line = this.wrap.querySelector('.hover-line');
    const dots = this.wrap.querySelector('.hover-dots');
    const plotPoint = idx >= 0 ? g.plotPoints[idx] : p;
    const cx = g.x(plotPoint.t);

    if (line) {
      line.setAttribute('x1', cx.toFixed(1));
      line.setAttribute('x2', cx.toFixed(1));
      line.setAttribute('visibility', 'visible');
    }
    if (dots) {
      dots.setAttribute('visibility', 'visible');
      for (const c of dots.querySelectorAll('circle')) {
        c.setAttribute('cx', cx.toFixed(1));
        c.setAttribute('cy', g.y(p.values[c.getAttribute('data-k')]).toFixed(1));
      }
    }

    const tip = this.tooltip;
    tip.innerHTML =
      `<div class="tt-time">${formatDateTime(p.time)} · ${escapeHtml(p.cameraId)}</div>` +
      this._activeSeries()
        .map(
          (s) =>
            `<div class="tt-row"><span class="k"><i class="swatch" style="background:${s.color}"></i>${s.label}</span>` +
            `<span class="v">${formatNumber(p.values[s.key])}</span></div>`,
        )
        .join('');
    tip.hidden = false;

    const wrapW = this.wrap.clientWidth;
    const tipW = tip.offsetWidth || 170;
    const tipH = tip.offsetHeight || 90;
    const pxX = cx / scale;
    let left = pxX + 14;
    if (left + tipW > wrapW) left = pxX - tipW - 14;
    if (left < 0) left = 0;
    let top = e.clientY - rect.top - tipH / 2;
    top = Math.max(0, Math.min(top, rect.height - tipH));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  _hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
    const cross = this.wrap.querySelector('.hover-cross');
    if (cross) cross.setAttribute('visibility', 'hidden');
    const line = this.wrap.querySelector('.hover-line');
    if (line) line.setAttribute('visibility', 'hidden');
    const dots = this.wrap.querySelector('.hover-dots');
    if (dots) dots.setAttribute('visibility', 'hidden');
  }

}
