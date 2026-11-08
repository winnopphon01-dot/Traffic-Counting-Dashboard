// โหลดค่า configuration จาก environment variable
// รองรับทั้งการส่งผ่าน shell (set/ $env) และไฟล์ .env (อ่านเองเพื่อไม่บังคับต้องใช้ --env-file)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));

function get(key, fallback) {
  const fromProcess = process.env[key];
  const v = fromProcess !== undefined && fromProcess !== '' ? fromProcess : fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
}

function getBool(key, fallback) {
  const v = get(key, undefined);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function getInt(key, fallback) {
  const n = Number.parseInt(String(get(key, ''), ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = Object.freeze({
  root: ROOT,
  port: getInt('PORT', 3000),
  upstreamBase: String(get('UPSTREAM_API_BASE', 'http://43.229.79.171:8000')).replace(/\/+$/, ''),
  apiKey: String(get('UPSTREAM_API_KEY', '')),
  demoMode: getBool('DEMO_MODE', false),
  fetchTimeoutMs: getInt('FETCH_TIMEOUT_MS', 10000),
  adminUsername: String(get('ADMIN_USERNAME', '')),
  adminPassword: String(get('ADMIN_PASSWORD', '')),
});
