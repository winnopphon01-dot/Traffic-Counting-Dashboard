// ฟังก์ชันจัดรูปแบบตัวเลข/วันเวลาแบบกำหนดเอง เพื่อให้ผลลัพธ์คงที่ทุกเบราว์เซอร์
const pad = (n) => String(n).padStart(2, '0');

// ช่วงเวลาสำหรับกราฟ (ms) — ใช้ร่วมกันทั้ง app.js (กราฟใหญ่) และ chart.js (มอนิเตอร์)
export const RANGE_MS = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '1mo': 30 * 24 * 60 * 60 * 1000,
};

export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** รูปแบบ YYYY-MM-DD HH:mm:ss (เวลาเครื่องผู้ใช้) */
export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return '—';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** รูปแบบ HH:mm:ss */
export function formatClock(value) {
  const d = toDate(value);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ป้ายกำกับแกน X ตามช่วงเวลาที่แสดง */
export function formatAxisTime(date, spanMs) {
  const d = toDate(date);
  if (!d) return '';
  const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  if (spanMs > 7 * 24 * 3600 * 1000) return md;
  if (spanMs >= 6 * 3600 * 1000) return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

/** ค่า input[type=datetime-local] -> ISO string (ส่งให้ API) */
export function datetimeLocalToIso(value) {
  if (!value) return undefined;
  const d = toDate(value);
  return d ? d.toISOString() : undefined;
}
