import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 10;
const PAGES = ['overview', 'trend', 'history', 'analysis'];
let usersFile;
const sessions = new Map();
let database;
let writeQueue = Promise.resolve();

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  const actual = scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUser(user) {
  const { passwordHash, preferences, ...safe } = user;
  return safe;
}

function normalizedPages(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((page) => PAGES.includes(page)))];
}

function validateUserInput(input, { requirePassword = true } = {}) {
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const role = input.role || 'user';
  if (!['admin', 'user'].includes(role)) {
    throw Object.assign(new Error('สิทธิ์บัญชีไม่ถูกต้อง'), { status: 400 });
  }
  if (input.pages !== undefined && (!Array.isArray(input.pages) || input.pages.some((page) => !PAGES.includes(page)))) {
    throw Object.assign(new Error('รายการหน้าที่อนุญาตไม่ถูกต้อง'), { status: 400 });
  }
  const pages = normalizedPages(input.pages);
  if (input.cameras !== undefined && (!Array.isArray(input.cameras) ||
    input.cameras.some((id) => typeof id !== 'string' || !id.trim() || id.trim().length > 64))) {
    throw Object.assign(new Error('รายการกล้องที่อนุญาตไม่ถูกต้อง'), { status: 400 });
  }
  const cameras = [...new Set((input.cameras || []).map((id) => id.trim()))];
  const maxGraphs = Number(input.maxGraphs);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) {
    throw Object.assign(new Error('ชื่อผู้ใช้ต้องยาว 3-64 ตัวอักษร และใช้ได้เฉพาะตัวอักษร ตัวเลข . _ @ -'), { status: 400 });
  }
  if (requirePassword && password.length < PASSWORD_MIN_LENGTH) {
    throw Object.assign(new Error(`รหัสผ่านต้องมีอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`), { status: 400 });
  }
  if (!Number.isInteger(maxGraphs) || maxGraphs < 1 || maxGraphs > 20) {
    throw Object.assign(new Error('จำนวนกราฟต้องเป็นจำนวนเต็ม 1-20'), { status: 400 });
  }
  if (input.expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
    throw Object.assign(new Error('วันหมดอายุต้องเป็นวันที่ในอนาคต'), { status: 400 });
  }
  if (role === 'user' && pages.length === 0) {
    throw Object.assign(new Error('ผู้ใช้ทั่วไปต้องได้รับสิทธิ์อย่างน้อย 1 หน้า'), { status: 400 });
  }
  return {
    username,
    password,
    role,
    pages: role === 'admin' ? PAGES : pages,
    cameras,
    maxGraphs: role === 'admin' ? 20 : maxGraphs,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

async function saveDatabase() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(usersFile), { recursive: true });
    const temporary = `${usersFile}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(database, null, 2), { mode: 0o600 });
    await fs.rename(temporary, usersFile);
  });
  return writeQueue;
}

export async function initializeAuth(config) {
  usersFile = path.join(config.root, 'data', 'users.json');
  try {
    database = JSON.parse(await fs.readFile(usersFile, 'utf8'));
    if (!database || !Array.isArray(database.users)) throw new Error('Invalid user database structure');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`ไม่สามารถอ่านฐานข้อมูลผู้ใช้ ${usersFile}: ${error.message}`);
    database = { users: [] };
  }

  if (database.users.length === 0 && config.adminUsername && config.adminPassword) {
    if (config.adminPassword.length < 12 ||
      !/^[\p{L}\p{N}_.@-]{3,64}$/u.test(config.adminUsername.trim())) {
      throw new Error('ADMIN_USERNAME ต้องยาว 3-64 ตัวอักษร และ ADMIN_PASSWORD ต้องมีอย่างน้อย 12 ตัวอักษร');
    }
    const credentials = hashPassword(config.adminPassword);
    database.users.push({
      id: randomBytes(16).toString('hex'),
      username: config.adminUsername.trim(),
      role: 'admin',
      pages: PAGES,
      cameras: [],
      maxGraphs: 20,
      expiresAt: null,
      preferences: {},
      passwordHash: credentials,
      createdAt: new Date().toISOString(),
    });
    await saveDatabase();
    console.log(`[auth] สร้างบัญชี admin เริ่มต้น "${config.adminUsername.trim()}" แล้ว`);
  }
}

export function authStatus() {
  return { setupRequired: database.users.length === 0 };
}

export function createSession(username, password) {
  const user = database.users.find((item) => item.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!user || !verifyPassword(String(password), user.passwordHash)) {
    throw Object.assign(new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'), { status: 401 });
  }
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    throw Object.assign(new Error('บัญชีนี้หมดอายุแล้ว กรุณาติดต่อผู้ดูแลระบบ'), { status: 403 });
  }
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  return { token, user: publicUser(user), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = database.users.find((item) => item.id === session.userId);
  if (!user || (user.expiresAt && Date.parse(user.expiresAt) <= Date.now())) {
    sessions.delete(token);
    return null;
  }
  return user;
}

export function deleteSession(token) {
  if (token) sessions.delete(token);
}

export function listUsers() {
  return database.users.map(publicUser);
}

export async function createUser(input) {
  const data = validateUserInput(input);
  if (database.users.some((user) => user.username.toLowerCase() === data.username.toLowerCase())) {
    throw Object.assign(new Error('มีชื่อผู้ใช้นี้อยู่แล้ว'), { status: 409 });
  }
  const { salt, hash } = hashPassword(data.password);
  const user = {
    id: randomBytes(16).toString('hex'),
    username: data.username,
    role: data.role,
    pages: data.pages,
    cameras: data.cameras,
    maxGraphs: data.maxGraphs,
    expiresAt: data.expiresAt,
    preferences: {},
    passwordHash: { salt, hash },
    createdAt: new Date().toISOString(),
  };
  database.users.push(user);
  await saveDatabase();
  return publicUser(user);
}

export async function updateUser(id, input, currentUser) {
  const user = database.users.find((item) => item.id === id);
  if (!user) throw Object.assign(new Error('ไม่พบผู้ใช้'), { status: 404 });
  const data = validateUserInput(input, { requirePassword: false });
  if (database.users.some((item) => item.id !== id && item.username.toLowerCase() === data.username.toLowerCase())) {
    throw Object.assign(new Error('มีชื่อผู้ใช้นี้อยู่แล้ว'), { status: 409 });
  }
  if (user.role === 'admin' && data.role !== 'admin' &&
    database.users.filter((item) => item.role === 'admin').length <= 1) {
    throw Object.assign(new Error('ไม่สามารถลดสิทธิ admin คนสุดท้ายได้'), { status: 400 });
  }
  if (user.id === currentUser.id && data.role !== 'admin') {
    throw Object.assign(new Error('ไม่สามารถลดสิทธิของบัญชี admin ที่กำลังใช้งานได้'), { status: 400 });
  }
  if (data.password && data.password.length < PASSWORD_MIN_LENGTH) {
    throw Object.assign(new Error(`รหัสผ่านต้องมีอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`), { status: 400 });
  }
  user.username = data.username;
  user.role = data.role;
  user.pages = data.pages;
  user.cameras = data.cameras;
  user.maxGraphs = data.maxGraphs;
  user.expiresAt = data.expiresAt;
  if (data.password) user.passwordHash = hashPassword(data.password);
  for (const [token, session] of sessions) {
    if (session.userId === id) sessions.delete(token);
  }
  await saveDatabase();
  return publicUser(user);
}

export async function removeUser(id, currentUser) {
  const userIndex = database.users.findIndex((item) => item.id === id);
  if (userIndex < 0) throw Object.assign(new Error('ไม่พบผู้ใช้'), { status: 404 });
  const user = database.users[userIndex];
  if (user.id === currentUser.id) throw Object.assign(new Error('ไม่สามารถลบบัญชีที่กำลังใช้งานได้'), { status: 400 });
  if (user.role === 'admin' && database.users.filter((item) => item.role === 'admin').length <= 1) {
    throw Object.assign(new Error('ไม่สามารถลบ admin คนสุดท้ายได้'), { status: 400 });
  }
  database.users.splice(userIndex, 1);
  for (const [token, session] of sessions) {
    if (session.userId === id) sessions.delete(token);
  }
  await saveDatabase();
}

export async function savePreferences(user, preferences) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw Object.assign(new Error('รูปแบบคอนฟิกไม่ถูกต้อง'), { status: 400 });
  }
  const maxSize = 256 * 1024;
  if (Buffer.byteLength(JSON.stringify(preferences), 'utf8') > maxSize) {
    throw Object.assign(new Error('คอนฟิกมีขนาดใหญ่เกินกำหนด'), { status: 413 });
  }
  for (const key of ['monitorWindows', 'trendWindows']) {
    if (user.role !== 'admin' && Array.isArray(preferences[key]) && preferences[key].length > user.maxGraphs) {
      throw Object.assign(new Error('account limited'), { status: 403 });
    }
  }
  user.preferences = preferences;
  await saveDatabase();
  return user.preferences;
}

export function canAccessCamera(user, cameraId) {
  return user.role === 'admin' || user.cameras.includes(String(cameraId));
}

export function permittedCameras(user, cameras) {
  return user.role === 'admin'
    ? cameras
    : cameras.filter((camera) => user.cameras.includes(String(camera.camera_id)));
}

export function allowedPages(user) {
  return user.role === 'admin' ? PAGES : user.pages;
}

export { PASSWORD_MIN_LENGTH };
