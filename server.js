// Traffic Counting Dashboard — Server-side API Proxy + Static file server
// ไม่มี dependency ภายนอก ใช้เฉพาะ Node built-in
// หน้าที่: เก็บ API Key ไว้ฝั่งเซิร์ฟเวอร์ (env var) แล้วแนบ header X-API-Key ก่อนยิงไป FastAPI บน VPS
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { config } from './lib/config.js';
import { UpstreamError, fetchHealth, fetchCameras, fetchLatest, fetchLatestAll, fetchHistory } from './lib/upstream.js';
import { demoHistory, demoLatest, demoCameras } from './lib/demoData.js';
import {
  authStatus, initializeAuth, createSession, getSession, deleteSession,
  listUsers, createUser, updateUser, removeUser, savePreferences,
  canAccessCamera, permittedCameras,
} from './lib/auth.js';

const PUBLIC_DIR = path.join(config.root, 'public');
const DASHBOARD_VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, err) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'เกิดข้อผิดพลาดที่ไม่คาดคิดฝั่ง Dashboard Server';
  let upstreamStatus = null;
  let detail = null;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else if (err instanceof UpstreamError) {
    status = err.status;
    code = err.code;
    message = err.message;
    upstreamStatus = err.upstreamStatus;
    detail = err.detail;
  } else if (Number.isInteger(err?.status)) {
    status = err.status;
    code = err.code || 'REQUEST_ERROR';
    message = err.message || 'คำขอไม่สำเร็จ';
  } else {
    console.error('[error]', err);
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, {
    error: { code, message, upstreamStatus, ...(detail ? { detail } : {}) },
  });
}

function cookieToken(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split('=');
    if (name === 'td_session') return parts.join('=');
  }
  return '';
}

function sessionCookie(token, req, maxAge = 12 * 60 * 60) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `td_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
      throw new HttpError(413, 'BODY_TOO_LARGE', 'ข้อมูลคำขอมีขนาดใหญ่เกินกำหนด');
    }
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'รูปแบบ JSON ไม่ถูกต้อง');
  }
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'ต้องใช้สิทธิ admin');
}

function requirePage(user, pages) {
  if (user.role !== 'admin' && !pages.some((page) => user.pages.includes(page))) {
    throw new HttpError(403, 'PAGE_FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงหน้านี้');
  }
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'INVALID_ORIGIN', 'ไม่อนุญาตคำขอจาก origin นี้');
  }
  if (originHost !== req.headers.host) {
    throw new HttpError(403, 'INVALID_ORIGIN', 'ไม่อนุญาตคำขอจาก origin นี้');
  }
}

function requireCamera(user, cameraId) {
  if (cameraId && !canAccessCamera(user, cameraId)) {
    throw new HttpError(403, 'CAMERA_FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงกล้องที่เลือก');
  }
}

const loginAttempts = new Map();

function loginRateLimit(req) {
  const now = Date.now();
  const address = req.socket.remoteAddress || 'unknown';
  const attempts = loginAttempts.get(address) || [];
  const recent = attempts.filter((at) => now - at < 15 * 60 * 1000);
  if (recent.length >= 10) throw new HttpError(429, 'LOGIN_RATE_LIMIT', 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 15 นาที');
  recent.push(now);
  loginAttempts.set(address, recent);
}

// ---------- พารามิเตอร์ที่อนุญาต (อิงจาก openapi.json จริงเท่านั้น) ----------
// GET /api/traffic/history?camera_id=<1-64>&start=<date-time>&end=<date-time>&start_date=<date>&end_date=<date>&limit=<1-1000 default 100>
function parseHistoryParams(searchParams) {
  const out = {
    cameraId: undefined,
    start: undefined,
    end: undefined,
    startDate: undefined,
    endDate: undefined,
    limit: undefined,
  };
  const errors = [];

  const cameraId = (searchParams.get('camera_id') || '').trim();
  if (cameraId) {
    if (cameraId.length > 64) errors.push('camera_id ต้องมีความยาวไม่เกิน 64 ตัวอักษร');
    else out.cameraId = cameraId;
  }

  const startRaw = (searchParams.get('start') || '').trim();
  if (startRaw) {
    const d = new Date(startRaw);
    if (Number.isNaN(d.getTime())) errors.push('start ต้องเป็นวันเวลาที่ถูกต้อง (เช่น 2026-10-14T00:00:00Z)');
    else out.start = d.toISOString();
  }

  const endRaw = (searchParams.get('end') || '').trim();
  if (endRaw) {
    const d = new Date(endRaw);
    if (Number.isNaN(d.getTime())) errors.push('end ต้องเป็นวันเวลาที่ถูกต้อง (เช่น 2026-10-14T23:59:59Z)');
    else out.end = d.toISOString();
  }

  if (out.start && out.end && Date.parse(out.start) > Date.parse(out.end)) {
    errors.push('start ต้องไม่มากกว่า end');
  }

  for (const [param, label] of [['start_date', 'startDate'], ['end_date', 'endDate']]) {
    const raw = (searchParams.get(param) || '').trim();
    if (!raw) continue;
    const timestamp = Date.parse(`${raw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== raw) {
      errors.push(`${param} ต้องเป็นวันที่ที่ถูกต้องในรูปแบบ YYYY-MM-DD`);
    } else {
      out[label] = raw;
    }
  }

  if (out.startDate && out.endDate && out.startDate > out.endDate) {
    errors.push('start_date ต้องไม่มากกว่า end_date');
  }

  const limitRaw = (searchParams.get('limit') || '').trim();
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) errors.push('limit ต้องเป็นจำนวนเต็ม 1-1000');
    else out.limit = n;
  }

  if (errors.length) throw new HttpError(400, 'INVALID_PARAMS', errors.join('; '));
  return out;
}

function parseCameraParam(searchParams) {
  const cameraId = (searchParams.get('camera_id') || '').trim();
  if (!cameraId) return undefined;
  if (cameraId.length > 64) throw new HttpError(400, 'INVALID_PARAMS', 'camera_id ต้องมีความยาวไม่เกิน 64 ตัวอักษร');
  return cameraId;
}

// ---------- Handlers ----------
async function handleMeta(res) {
  sendJson(res, 200, {
    upstream: config.upstreamBase,
    apiKeyConfigured: Boolean(config.apiKey),
    demoMode: config.demoMode,
    serverTime: new Date().toISOString(),
    version: DASHBOARD_VERSION,
  });
}

async function handleHealth(res) {
  // /health ไม่ต้องใช้ key — ยิง upstream จริงเสมอเพื่อสะท้อนสถานะเชื่อมต่อที่แท้จริง
  const body = await fetchHealth();
  sendJson(res, 200, {
    ...(body && typeof body === 'object' ? body : { status: 'unknown' }),
    upstream: config.upstreamBase,
    checkedAt: new Date().toISOString(),
  });
}

async function handleCameras(res, user) {
  let real = [];
  let upstreamFailed = false;
  try {
    real = await fetchCameras();
  } catch (err) {
    if (!config.demoMode) throw err;
    // ในโหมด demo ยอมให้ล้มเหลวได้ (ยังแสดงกล้อง demo ได้) แต่แจ้งผู้ใช้ผ่าน header
    upstreamFailed = true;
  }
  const demo = config.demoMode ? demoCameras() : [];
  const merged = permittedCameras(user, [...real, ...demo])
    .sort((a, b) => String(a.camera_id).localeCompare(String(b.camera_id)));
  sendJson(res, 200, merged, {
    ...(config.demoMode ? { 'X-Demo-Mode': '1' } : {}),
    ...(upstreamFailed ? { 'X-Upstream-Error': '1' } : {}),
  });
}

async function handleLatest(res, searchParams, user) {
  const cameraId = parseCameraParam(searchParams);
  requireCamera(user, cameraId);
  const candidates = [];

  if (config.demoMode) {
    const demoRow = demoLatest(cameraId);
    if (demoRow) candidates.push(demoRow);
  }

  if (config.apiKey) {
    const realRow = await fetchLatest(cameraId);
    if (realRow) candidates.push(realRow);
  } else if (!config.demoMode) {
    // ไม่มี key และไม่ได้เปิด demo → แจ้งชัดเจนแทนการยิงแล้วโดน 401 เงียบๆ
    await fetchLatest(cameraId); // จะ throw UpstreamError(API_KEY_NOT_CONFIGURED) เสมอ
  }

  candidates.sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  const row = candidates.find((candidate) => canAccessCamera(user, candidate.camera_id)) ?? null;
  sendJson(res, 200, row, config.demoMode ? { 'X-Demo-Mode': '1' } : {});
}

async function handleLive(res, user) {
  let realRows = [];
  let upstreamFailed = false;
  try {
    realRows = await fetchLatestAll();
  } catch (err) {
    if (!config.demoMode) throw err;
    upstreamFailed = true;
  }
  const demoRows = config.demoMode
    ? demoCameras().map((camera) => demoLatest(camera.camera_id)).filter(Boolean)
    : [];
  const rows = permittedCameras(user, [...realRows, ...demoRows])
    .sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  sendJson(res, 200, rows, {
    'X-Record-Count': String(rows.length),
    ...(config.demoMode ? { 'X-Demo-Mode': '1' } : {}),
    ...(upstreamFailed ? { 'X-Upstream-Error': '1' } : {}),
  });
}

async function handleHistory(res, searchParams, user) {
  const params = parseHistoryParams(searchParams);
  requireCamera(user, params.cameraId);
  const limit = params.limit ?? 100; // default ตามสเปกจริง
  const rows = [];

  if (config.demoMode) {
    rows.push(...demoHistory({
      ...params,
      start: params.start || (params.startDate ? `${params.startDate}T00:00:00.000Z` : undefined),
      end: params.end || (params.endDate ? `${params.endDate}T23:59:59.999Z` : undefined),
      limit: 1000,
    }));
  }

  if (config.apiKey) {
    rows.push(...(await fetchHistory(params)));
  } else if (!config.demoMode) {
    await fetchHistory(params); // จะ throw UpstreamError(API_KEY_NOT_CONFIGURED) เสมอ
  }

  const visibleRows = permittedCameras(user, rows);
  visibleRows.sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  const out = visibleRows.slice(0, limit);

  sendJson(res, 200, out, {
    'X-Record-Count': String(out.length),
    ...(config.demoMode ? { 'X-Demo-Mode': '1' } : {}),
  });
}

// ---------- Static files ----------
const NOT_FOUND_HTML = `<!doctype html><html lang="th"><meta charset="utf-8">
<title>ไม่พบหน้า</title><body style="font-family:system-ui;background:#0f1420;color:#e6ebf5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>404</h1><p>ไม่พบหน้าที่ร้องขอ</p><a href="/" style="color:#3b82f6">กลับหน้า Dashboard</a></div></body></html>`;

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(403, 'FORBIDDEN', 'ไม่อนุญาตให้เข้าถึงไฟล์นอกโฟลเดอร์ public');
  }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html')) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(NOT_FOUND_HTML);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'ไม่พบไฟล์ที่ร้องขอ');
    }
    throw err;
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) requireSameOrigin(req);
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      loginRateLimit(req);
      const body = await readJson(req);
      const session = createSession(body.username, body.password);
      loginAttempts.delete(req.socket.remoteAddress || 'unknown');
      sendJson(res, 200, { user: session.user, expiresAt: session.expiresAt }, {
        'Set-Cookie': sessionCookie(session.token, req),
      });
    } else if (pathname === '/api/auth/logout' && req.method === 'POST') {
      deleteSession(cookieToken(req));
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, 0) });
    } else if (pathname === '/api/auth/me' && (req.method === 'GET' || req.method === 'HEAD')) {
      const user = getSession(cookieToken(req));
      sendJson(res, 200, { authenticated: Boolean(user), setupRequired: authStatus().setupRequired, user: user ? {
        id: user.id, username: user.username, role: user.role, pages: user.role === 'admin'
          ? ['overview', 'trend', 'history', 'analysis', 'users'] : user.pages,
        cameras: user.cameras, maxGraphs: user.maxGraphs,
      } : null });
    } else if (pathname.startsWith('/api/')) {
      const user = getSession(cookieToken(req));
      if (!user) throw new HttpError(authStatus().setupRequired ? 503 : 401,
        authStatus().setupRequired ? 'AUTH_NOT_CONFIGURED' : 'UNAUTHENTICATED',
        authStatus().setupRequired
          ? 'กรุณากำหนด ADMIN_USERNAME และ ADMIN_PASSWORD ในไฟล์ .env แล้วเริ่มเซิร์ฟเวอร์ใหม่'
          : 'กรุณาเข้าสู่ระบบใหม่');

      if (pathname === '/api/user/preferences' && req.method === 'GET') {
        sendJson(res, 200, user.preferences || {});
      } else if (pathname === '/api/user/preferences' && req.method === 'PUT') {
        const preferences = await savePreferences(user, await readJson(req));
        sendJson(res, 200, preferences);
      } else if (pathname === '/api/admin/users' && req.method === 'GET') {
        requireAdmin(user);
        sendJson(res, 200, listUsers());
      } else if (pathname === '/api/admin/users' && req.method === 'POST') {
        requireAdmin(user);
        sendJson(res, 201, await createUser(await readJson(req)));
      } else if (pathname.startsWith('/api/admin/users/')) {
        requireAdmin(user);
        const id = decodeURIComponent(pathname.slice('/api/admin/users/'.length));
        if (req.method === 'PUT') sendJson(res, 200, await updateUser(id, await readJson(req), user));
        else if (req.method === 'DELETE') {
          await removeUser(id, user);
          sendJson(res, 200, { ok: true });
        } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'ไม่รองรับ method นี้');
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/api/meta') await handleMeta(res);
        else if (pathname === '/api/health') await handleHealth(res);
        else if (pathname === '/api/cameras') await handleCameras(res, user);
        else if (pathname === '/api/traffic/latest') {
          requirePage(user, ['overview', 'trend']);
          await handleLatest(res, url.searchParams, user);
        } else if (pathname === '/api/traffic/live') {
          requirePage(user, ['overview']);
          await handleLive(res, user);
        } else if (pathname === '/api/traffic/history') {
          requirePage(user, ['trend', 'history', 'analysis']);
          await handleHistory(res, url.searchParams, user);
        }
        else throw new HttpError(404, 'NOT_FOUND', 'ไม่พบ endpoint ที่ร้องขอ');
      } else {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'ไม่รองรับ method นี้');
      }
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
    } else {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'รองรับเฉพาะ GET');
    }
  } catch (err) {
    sendError(res, err);
  } finally {
    res.on('finish', () => {
      const where = url ? url.pathname : req.url;
      console.log(`${new Date().toISOString()} ${req.method} ${where} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ผิดพลาด] พอร์ต ${config.port} ถูกใช้งานแล้ว — แก้ PORT ในไฟล์ .env แล้วลองใหม่\n`);
    process.exit(1);
  }
  console.error('[ผิดพลาด] เซิร์ฟเวอร์ล้มเหลว:', err);
  process.exit(1);
});

await initializeAuth(config);

server.listen(config.port, () => {
  const line = '─'.repeat(64);
  console.log(line);
  console.log(' Traffic Counting Dashboard');
  console.log(` URL         : http://localhost:${config.port}`);
  console.log(` Upstream    : ${config.upstreamBase}`);
  console.log(
    ` API Key     : ${config.apiKey ? 'ตั้งค่าแล้ว (เก็บฝั่งเซิร์ฟเวอร์ ไม่ส่งถึง browser)' : 'ยังไม่ได้ตั้งค่า — แก้ UPSTREAM_API_KEY ใน .env'}`,
  );
  console.log(` DEMO_MODE   : ${config.demoMode ? 'เปิด (ข้อมูลทดสอบทุกแถวติดป้าย TEST)' : 'ปิด'}`);
  console.log(line);
});

function shutdown() {
  console.log('\nกำลังปิดเซิร์ฟเวอร์...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
