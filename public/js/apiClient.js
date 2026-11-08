// API Client ของฝั่ง Browser — ยิงเฉพาะ Dashboard Proxy บน localhost เท่านั้น
// ข้อกำหนดความปลอดภัย: ไม่มี API Key อยู่ในไฟล์ฝั่ง Browser จึงไม่ต้อง (และห้าม) ส่ง X-API-Key ที่นี่
export class ApiClientError extends Error {
  constructor(message, { code = 'UNKNOWN', status = 0, upstreamStatus = null, detail = null } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.detail = detail;
  }
}

function buildQuery(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** ตัวชี้วัดที่วัดได้จริงจากการเรียก proxy (performance.now — ไม่ใช่ค่าสมมติ) */
export const metrics = { lastLatencyMs: null, historyLatencyMs: null };

async function get(path, params, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${path}${buildQuery(params)}`;

  // กัน fetch ค้างถาวร: รวม caller signal (ไว้ยกเลิกเมื่อมีคำขอใหม่) กับ timeout 15 วินาที
  let combinedSignal = signal;
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    combinedSignal =
      signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, timeoutSignal])
        : signal ?? timeoutSignal;
  } catch {
    combinedSignal = signal; // เบราว์เซอร์เก่าไม่รองรับ AbortSignal.timeout → ใช้ caller signal ตามเดิม
  }

  const startedAt = performance.now();
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: combinedSignal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.name === 'TimeoutError') {
      throw new ApiClientError(`หมดเวลาคอยคำตอบจากเซิร์ฟเวอร์ (เกิน ${Math.round(timeoutMs / 1000)} วินาที)`, {
        code: 'CLIENT_TIMEOUT',
      });
    }
    throw new ApiClientError('ไม่สามารถเชื่อมต่อ Dashboard Server ได้ (เซิร์ฟเวอร์อาจยังไม่ทำงาน)', {
      code: 'PROXY_UNREACHABLE',
    });
  }

  const elapsed = Math.round(performance.now() - startedAt);
  metrics.lastLatencyMs = elapsed;
  if (path.startsWith('/api/traffic/')) metrics.historyLatencyMs = elapsed;

  const contentType = String(res.headers.get('content-type') || '');
  let body = null;
  if (contentType.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = (body && typeof body === 'object' && body.error) || {};
    if (res.status === 401) window.dispatchEvent(new CustomEvent('dashboard:unauthorized'));
    throw new ApiClientError(err.message || `คำขอล้มเหลว (HTTP ${res.status})`, {
      code: err.code || `HTTP_${res.status}`,
      status: res.status,
      upstreamStatus: err.upstreamStatus ?? null,
      detail: err.detail ?? null,
    });
  }

  return body;
}

export const apiClient = {
  /** สถานะ proxy/เซิร์ฟเวอร์ (ไม่แตะ upstream) */
  meta: (opts) => get('/api/meta', undefined, opts),
  /** GET /health ของ API จริง (ไม่ต้องใช้ key) */
  health: (opts) => get('/api/health', undefined, opts),
  /** GET /api/cameras — proxy แนบ API Key ฝั่งเซิร์ฟเวอร์ */
  cameras: (opts) => get('/api/cameras', undefined, opts),
  /** GET /api/traffic/latest?camera_id= — key ถูกแนบฝั่งเซิร์ฟเวอร์ */
  latest: (params, opts) => get('/api/traffic/latest', params, opts),
  /** เหตุการณ์ล่าสุดต่อกล้องจาก /api/traffic/latest/all ผ่าน Dashboard Proxy */
  live: (opts) => get('/api/traffic/live', undefined, opts),
  /** GET /api/traffic/history?camera_id=&start=&end=&limit= — key ถูกแนบฝั่งเซิร์ฟเวอร์ */
  history: (params, opts) => get('/api/traffic/history', params, opts),
};
