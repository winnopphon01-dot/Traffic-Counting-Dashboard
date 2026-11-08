// Client ฝั่งเซิร์ฟเวอร์สำหรับเรียก FastAPI บน VPS
// - แนบ header X-API-Key ที่นี่เท่านั้น (ไม่ส่ง key ไป Browser)
// - ยิงเฉพาะ read-only: GET /health, /api/cameras, /api/traffic/latest/all, /api/traffic/history
// - map สถานะผิดพลาดของ upstream เป็น error ที่ UI เข้าใจได้
import { config } from './config.js';
import { decorateRow, decorateCamera } from './testFlag.js';

export class UpstreamError extends Error {
  constructor(message, { code = 'UPSTREAM_ERROR', status = 502, upstreamStatus = null, detail = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.detail = detail;
  }
}

function ensureKey(forEndpoint) {
  if (config.apiKey) return;
  throw new UpstreamError(
    `ยังไม่ได้ตั้งค่า UPSTREAM_API_KEY ในไฟล์ .env จึงเรียก ${forEndpoint} ไม่ได้ ` +
      '(upstream ตอบ 401 เมื่อไม่มี header X-API-Key)',
    { code: 'API_KEY_NOT_CONFIGURED', status: 503 },
  );
}

async function call(path, { base = config.upstreamBase, needsKey = false, params = {} } = {}) {
  if (needsKey) ensureKey(path);

  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers = { Accept: 'application/json' };
  if (config.apiKey) headers['X-API-Key'] = config.apiKey;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(config.fetchTimeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new UpstreamError(
        `หมดเวลาเชื่อมต่อ ${config.upstreamBase} (เกิน ${config.fetchTimeoutMs} ms)`,
        { code: 'UPSTREAM_TIMEOUT', status: 504 },
      );
    }
    throw new UpstreamError(`เชื่อมต่อ ${config.upstreamBase} ไม่ได้: ${err.message}`, {
      code: 'UPSTREAM_UNREACHABLE',
      status: 502,
    });
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 500) : body;
    if (res.status === 401) {
      throw new UpstreamError('API Key ไม่ถูกต้องหรือถูกปฏิเสธ (upstream ตอบ 401 Unauthorized)', {
        code: 'UPSTREAM_UNAUTHORIZED',
        status: 502,
        upstreamStatus: 401,
        detail,
      });
    }
    if (res.status === 403) {
      throw new UpstreamError('API Key ไม่มีสิทธิ์เข้าถึง (upstream ตอบ 403 Forbidden)', {
        code: 'UPSTREAM_FORBIDDEN',
        status: 502,
        upstreamStatus: 403,
        detail,
      });
    }
    if (res.status === 404) {
      throw new UpstreamError('ไม่พบ endpoint ที่เรียกบน upstream (404)', {
        code: 'UPSTREAM_NOT_FOUND',
        status: 404,
        upstreamStatus: 404,
        detail,
      });
    }
    if (res.status === 422) {
      throw new UpstreamError('upstream ปฏิเสธพารามิเตอร์ (422 Validation Error)', {
        code: 'UPSTREAM_VALIDATION',
        status: 400,
        upstreamStatus: 422,
        detail,
      });
    }
    if (res.status === 503) {
      throw new UpstreamError('upstream รายงานว่าบริการไม่พร้อมใช้งาน (503)', {
        code: 'UPSTREAM_UNAVAILABLE',
        status: 502,
        upstreamStatus: 503,
        detail,
      });
    }
    throw new UpstreamError(`upstream ตอบ HTTP ${res.status}`, {
      code: 'UPSTREAM_ERROR',
      status: 502,
      upstreamStatus: res.status,
      detail,
    });
  }

  return body;
}

function invalidResponse(message) {
  return new UpstreamError(message, {
    code: 'UPSTREAM_INVALID_RESPONSE',
    status: 502,
  });
}

function normalizeTrafficRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw invalidResponse('Traffic API ส่งรายการข้อมูลในรูปแบบที่ไม่ถูกต้อง');
  }
  const timestamp = Number(row.timestamp);
  const eventTime = new Date(timestamp * 1000);
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const countsAreValid = ['people', 'car', 'motorcycle'].every((category) =>
    isCount(row[category]?.in) && isCount(row[category]?.out),
  );
  if (
    typeof row.camera_id !== 'string' ||
    !row.camera_id ||
    typeof row.camera_name !== 'string' ||
    !row.camera_name ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    Number.isNaN(eventTime.getTime()) ||
    !countsAreValid ||
    !isCount(row.total_people) ||
    !isCount(row.total_car) ||
    !isCount(row.total_motorcycle) ||
    typeof row.received_at !== 'string' ||
    !Number.isFinite(Date.parse(row.received_at))
  ) {
    throw invalidResponse('Traffic API ส่งรายการข้อมูลไม่ตรงกับโครงสร้างที่กำหนด');
  }
  return decorateRow({ ...row, event_time: eventTime.toISOString() });
}

function normalizeTrafficRows(body, endpoint) {
  if (!Array.isArray(body)) {
    throw invalidResponse(`${endpoint} ส่งข้อมูลในรูปแบบที่ไม่ถูกต้อง (คาดว่าเป็น array)`);
  }
  return body.map(normalizeTrafficRow);
}

export function fetchHealth() {
  return call('/health');
}

export async function fetchCameras() {
  const body = await call('/api/cameras', { needsKey: true });
  if (!Array.isArray(body)) throw invalidResponse('/api/cameras ส่งข้อมูลในรูปแบบที่ไม่ถูกต้อง');
  return body.map((camera) => {
    if (
      !camera ||
      typeof camera.camera_id !== 'string' ||
      typeof camera.camera_name !== 'string' ||
      !Number.isSafeInteger(camera.event_count) ||
      camera.event_count < 0 ||
      typeof camera.last_event_time !== 'string' ||
      !Number.isFinite(Date.parse(camera.last_event_time))
    ) {
      throw invalidResponse('/api/cameras ส่งรายการกล้องไม่ตรงกับโครงสร้างที่กำหนด');
    }
    return decorateCamera(camera);
  });
}

export async function fetchLatest(cameraId) {
  const body = await call('/api/traffic/latest', {
    needsKey: true,
    params: { camera_id: cameraId },
  });
  return body ? normalizeTrafficRow(body) : null;
}

export async function fetchLatestAll() {
  const body = await call('/api/traffic/latest/all', { needsKey: true });
  return normalizeTrafficRows(body, '/api/traffic/latest/all');
}

export async function fetchHistory({ cameraId, start, end, startDate, endDate, limit } = {}) {
  const body = await call('/api/traffic/history', {
    needsKey: true,
    params: {
      camera_id: cameraId,
      start,
      end,
      start_date: startDate,
      end_date: endDate,
      limit,
    },
  });
  return normalizeTrafficRows(body, '/api/traffic/history');
}
