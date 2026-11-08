// ข้อมูลทดสอบสังเคราะห์สำหรับโหมด DEMO_MODE
// ข้อกำหนด: ทุกแถวต้องถูกทำเครื่องหมาย is_test=true เสมอ และแยกจากสถิติจริงใน UI
import { decorateRows, decorateCamera } from './testFlag.js';

const DEMO_CAMERAS = ['TEST-DEMO-01', 'TEST-DEMO-02'];
const ROW_COUNT = 240;
const SPAN_MS = 24 * 60 * 60 * 1000; // ย้อนหลัง 24 ชั่วโมง
const REBUILD_MS = 5 * 60 * 1000; // สร้างชุดข้อมูลใหม่ทุก 5 นาที
const DEMO_REASON = 'สร้างโดยโหมด DEMO (ข้อมูลทดสอบสังเคราะห์)';

// PRNG แบบ deterministic เพื่อให้ข้อมูลทดสอบซ้ำได้ (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRows(now) {
  const rand = mulberry32(0x7a1f);
  const rows = [];
  const start = now - SPAN_MS;
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const camera = DEMO_CAMERAS[i % DEMO_CAMERAS.length];
    const t = new Date(start + Math.round((i / (ROW_COUNT - 1)) * SPAN_MS));
    const hour = t.getHours();
    const isRush = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19);
    const rush = isRush ? 2.1 : 1;
    const wave = 1 + 0.35 * Math.sin(i / 17); // ให้เห็นแนวโน้มขึ้นลงในกราฟ
    const car = Math.max(0, Math.round((7 + rand() * 16) * rush * wave));
    const motorcycle = Math.max(0, Math.round(1 + rand() * 6 * wave));
    const people = Math.max(0, Math.round((2 + rand() * 8) * (isRush ? 1.5 : 1)));
    const iso = t.toISOString();
    rows.push({
      id: 900000 + i,
      camera_id: camera,
      camera_name: `Demo ${camera}`,
      timestamp: t.getTime() / 1000,
      car: { in: car, out: Math.floor(car * 0.7) },
      motorcycle: { in: motorcycle, out: Math.floor(motorcycle * 0.6) },
      people: { in: people, out: Math.floor(people * 0.8) },
      total_car: car,
      total_motorcycle: motorcycle,
      total_people: people,
      event_time: iso,
      received_at: iso,
    });
  }
  return rows;
}

let cache = { at: 0, rows: [] };

function demoRows(now = Date.now()) {
  if (now - cache.at > REBUILD_MS || cache.rows.length === 0) {
    cache = { at: now, rows: buildRows(now) };
  }
  return cache.rows;
}

export function demoHistory({ cameraId, start, end, limit } = {}) {
  let rows = demoRows();
  if (cameraId) rows = rows.filter((r) => r.camera_id === cameraId);
  if (start) {
    const s = Date.parse(start);
    if (Number.isFinite(s)) rows = rows.filter((r) => Date.parse(r.event_time) >= s);
  }
  if (end) {
    const e = Date.parse(end);
    if (Number.isFinite(e)) rows = rows.filter((r) => Date.parse(r.event_time) <= e);
  }
  rows = [...rows].sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  if (limit) rows = rows.slice(0, limit);
  return decorateRows(rows, { forceTest: true, extraReason: DEMO_REASON });
}

export function demoLatest(cameraId) {
  const [row] = demoHistory({ cameraId, limit: 1 });
  return row ?? null;
}

export function demoCameras() {
  const map = new Map();
  for (const row of demoRows()) {
    const entry = map.get(row.camera_id) ?? {
      camera_id: row.camera_id,
      camera_name: row.camera_name,
      event_count: 0,
      last_event_time: null,
    };
    entry.event_count += 1;
    if (!entry.last_event_time || Date.parse(row.event_time) > Date.parse(entry.last_event_time)) {
      entry.last_event_time = row.event_time;
    }
    map.set(row.camera_id, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.camera_id.localeCompare(b.camera_id))
    .map((cam) => decorateCamera(cam, { forceTest: true, extraReason: DEMO_REASON }));
}
