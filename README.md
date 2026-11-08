# Traffic Counting Dashboard

Dashboard แสดงจำนวน **Car / Motorcycle / People** จากกล้องจริง พร้อม **Server-side API Proxy**
เชื่อมต่อ FastAPI ที่ทำงานอยู่บน VPS โดยไม่เปิดเผย API Key แก่ฝั่ง Browser

- **ไม่มี dependencies ใดๆ** ใช้ Node.js built-in ล้วน (ไม่ต้อง `npm install`)
- รันได้ทันทีบน Windows / macOS / Linux

---

## สถาปัตยกรรม

```
Browser (public/) ── login/session + /api/* ──► server.js ── X-API-Key ──► FastAPI บน VPS
                  คอนฟิกแยกตามผู้ใช้       users.json (ไม่อยู่ใน public/)  http://43.229.79.171:8000
```

| ส่วน | ไฟล์ | หน้าที่ |
|---|---|---|
| Proxy + Static server | `server.js` | เสิร์ฟ UI และรับช่วงเรียก API พร้อมแนบ key |
| Config | `lib/config.js` | อ่าน env vars / `.env` |
| Upstream client | `lib/upstream.js` | ยิง FastAPI (GET read-only) + map ข้อผิดพลาด |
| กฎข้อมูลทดสอบ | `lib/testFlag.js` | ทำเครื่องหมาย `is_test` ทุก record |
| ข้อมูลสาธิต | `lib/demoData.js` | ข้อมูลสังเคราะห์สำหรับ `DEMO_MODE` (ปิดเป็นค่าเริ่มต้น) |
| API Client (Browser) | `public/js/apiClient.js` | เรียกเฉพาะ proxy ของเซิร์ฟเวอร์ ไม่มี key |
| UI rendering | `public/js/ui.js` | การ์ด ตาราง สถานะ loading/error/empty |
| กราฟ | `public/js/chart.js` | กราฟ SVG เขียนเอง ไม่พึ่ง CDN |
| ตัวประสาน | `public/js/app.js` | state, filter, refresh, สถานะการเชื่อมต่อ |
| Login / จัดการผู้ใช้ | `public/js/auth.js`, `lib/auth.js` | session, บัญชี, page/camera permissions, วันหมดอายุ และคอนฟิกแยกผู้ใช้ |

หน้า Overview อ่าน `GET /api/traffic/latest/all` ผ่าน Dashboard Proxy เพื่อรับเหตุการณ์ล่าสุดของแต่ละกล้อง และสะสมจุดในหน่วยความจำของแท็บตามรอบอัปเดตที่เลือก; ข้อมูลชุดนี้ไม่ถูกเก็บฝั่งเซิร์ฟเวอร์และจะหายเมื่อปิด/โหลดหน้าใหม่

หน้า Overview เริ่มต้นโดยไม่มีกราฟ ผู้ใช้เพิ่มหน้าต่างและเลือกกล้องเองได้ โดยสามารถเลือกกล้องเดียวกันซ้ำในหลายหน้าต่างได้ กราฟ realtime ใช้ข้อมูลที่ browser เก็บระหว่าง session เท่านั้น
กราฟแต่ละหน้าต่างใน Overview เลือกช่วงย้อนหลังและ Tick/การรวมข้อมูลได้แยกกัน และเลือกเปิด Car, Motorcycle หรือ People ได้อย่างอิสระ โดยกราฟและการ์ดใช้ค่า `total_car`, `total_motorcycle` และ `total_people` จาก API

หน้า Trend เริ่มต้นโดยไม่มีกราฟเช่นกัน ผู้ใช้เพิ่มหน้าต่างและเลือกกล้อง โดยตัวเลือกวันที่เริ่มต้น/สิ้นสุด, เพิ่มกราฟ, ค้นหา และเต็มจอจัดไว้ใน topbar ระบุวันที่ค้นหา (นับวันสิ้นสุดรวมด้วยตาม UTC) แล้วกดค้นหา ระบบแบ่งคำขอ `start`/`end` เป็นช่วงละหนึ่งชั่วโมง จำกัดพร้อมกันไม่เกิน 4 คำขอ และแบ่งช่วงย่อยลงอีกเมื่อคำตอบแตะ 1,000 แถว ก่อนรวม/ตัดข้อมูลซ้ำเพื่อวาดกราฟ ช่วงย่อยหยุดที่หนึ่งนาที ซึ่งยังอาจไม่ครบหากมีข้อมูลเกิน 1,000 แถวภายในนาทีเดียว แต่ละกราฟ Trend เลือกช่วงที่แสดงย้อนหลังจากเวลาของข้อมูลล่าสุดได้ (15 นาทีถึง 1 เดือน) เลือกระยะ Tick สำหรับจัดกลุ่ม/เฉลี่ยจุดข้อมูลเป็น 10 วินาที, 1, 10, 30 นาที หรือ 1 ชั่วโมง และใช้แถบเลื่อน/ปุ่มลูกศรเลื่อนดูประวัติทีละช่วงกราฟ โดยไม่ยิงคำขอประวัติใหม่ การ์ดยอดรวมใช้แถวข้อมูลดิบชุดเดียวกันภายในช่วงกราฟที่เลือก หลังค้นหา ตารางแสดงผลประวัติทั้งหมดที่โหลดได้ เรียงเวลาใหม่ไปเก่า เลือกจำนวนแถวต่อหน้า (50–1,000) พร้อมปุ่มเปลี่ยนหน้า และส่งออก CSV ที่เปิดด้วย Excel ได้ การจัดคอลัมน์กราฟของ Trend แยกจาก Overview และบันทึกคนละค่า

หน้า Analysis (`/#/analysis`) รับไฟล์ Playlist Report ที่มีคอลัมน์คั่นด้วย `|` ในรูปแบบ `เวลาเริ่ม | ชื่อสื่อ | ระยะเวลาเล่นจริง (วินาที) | ระยะเวลาสื่อ` เวลาในรายงานที่ไม่มี timezone จะตีความเป็นเวลาไทย (Asia/Bangkok) และแปลงเป็น UTC ก่อนค้นหา ผู้ใช้ต้องเลือกกล้องก่อนคำนวณ ระบบใช้ค่า `total_car`, `total_motorcycle` และ `total_people` โดยหาค่าอ่านล่าสุดก่อน/ณ เวลาเริ่มสื่อและค่าอ่านแรก ณ/หลังเวลาสิ้นสุด แล้วแสดงผลต่างของ Car, Motorcycle และ People ต่อการเล่นสื่อแต่ละครั้ง ตารางผลลัพธ์เลือกจำนวนแถวต่อหน้าและเปลี่ยนหน้าได้ พร้อมกรองช่วงเวลาเริ่ม/สิ้นสุดและชื่อสื่อ

แต่ละหน้าต่างกราฟมีสวิตช์โหมดแยกกัน: `ค่าจริง` แสดงเส้นและ `cam-metrics` จากค่าล่าสุด ส่วน `ผลต่าง` คำนวณค่าปัจจุบันลบแถวก่อนหน้าสำหรับเส้นและตัวเลข พร้อมลูกศรขึ้นสีเขียวเมื่อเพิ่มขึ้นหรือลูกศรลงสีแดงเมื่อค่าเท่าเดิม/ลดลง; หากยังไม่มีแถวก่อนหน้าให้เปรียบเทียบ จะแสดง `—` โหมด Overview บันทึกแยกตามหน้าต่าง

ตัวกรองถูกซ่อนไว้เมื่อเปิดหน้า และเปิด/ปิดได้จากปุ่ม “ตัวกรอง” บนแถบด้านบนหรือปุ่ม ⌗ ทางซ้าย แถบสถานะการเชื่อมต่อ, latency, จำนวนแถว และรายการใหม่จะอยู่รวมใน footer

---

## ข้อกำหนด API จริง (ตรวจจาก `http://43.229.79.171:8000/openapi.json`)

| Endpoint | พารามิเตอร์ | Response | Auth |
|---|---|---|---|
| `GET /health` | — | `{status, database, service, version}` (200/503) | ไม่ใช้ |
| `GET /api/cameras` | — | `[{camera_id, camera_name, event_count, last_event_time}]` | `X-API-Key` |
| `GET /api/traffic/latest/all` | — | `CameraCountResponse[]` — เหตุการณ์ล่าสุดของแต่ละกล้อง เรียงใหม่→เก่า | `X-API-Key` |
| `GET /api/traffic/latest` | `camera_id` (1–64, optional) | `CameraCountResponse` (object เดียว) | `X-API-Key` |
| `GET /api/traffic/history` | `camera_id`, `start`, `end` (date-time), `start_date`, `end_date` (YYYY-MM-DD, UTC calendar dates; end date inclusive), `limit` (1–1000, default 100) | `CameraCountResponse[]` เรียงใหม่→เก่า | `X-API-Key` |

`CameraCountResponse` = `{id, camera_id, camera_name, timestamp, people: {in, out}, car: {in, out}, motorcycle: {in, out}, total_people, total_car, total_motorcycle, received_at}`. `timestamp` เป็น Unix timestamp หน่วยวินาที; Dashboard แปลงเป็น UTC event time เพื่อเรียงและวาดกราฟ และแสดงเวลา `received_at` แยกในตาราง

ส่ง `start_date`/`end_date` เพื่อกรองเป็นวันปฏิทินเต็ม เช่น `GET /api/traffic/history?start_date=2026-09-16&end_date=2026-10-16`; ผลลัพธ์รวมทั้งวันเริ่มต้นและวันสิ้นสุด (UTC) และยังแบ่งดึงข้อมูลเป็นช่วงย่อยด้วยการเรียกหลายครั้งได้

เมื่อไม่ส่ง `X-API-Key` → upstream ตอบ **401 (body ว่าง)** — ฝั่ง proxy จะแปลงเป็นข้อความไทยที่อ่านได้

---

## รันบน Windows

```powershell
# 1) สร้างไฟล์ env แล้วใส่ค่า (ใส่ key เอง ห้ามวาง key ในแชท/ Git)
copy .env.example .env

# 2) start server (ไม่ต้อง npm install)
node server.js

# 3) เปิดเบราว์เซอร์
start http://localhost:3000
```

> `npm` บนเครื่องนี้ถูกบล็อก Execution Policy สำหรับ `npm.ps1` — ไม่เป็นปัญหาเพราะโปรเจกต์นี้ไม่ต้องติดตั้งอะไร
> หากต้องการใช้ npm ให้เรียกผ่าน `cmd /c npm start`

### Environment variables (ไฟล์ `.env`)

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตของ Dashboard |
| `UPSTREAM_API_BASE` | `http://43.229.79.171:8000` | Base URL ของ FastAPI |
| `UPSTREAM_API_KEY` | (ว่าง) | ค่า header `X-API-Key` — **เก็บฝั่งเซิร์ฟเวอร์เท่านั้น** |
| `DEMO_MODE` | `false` | เปิดข้อมูลทดสอบสังเคราะห์ (ทุกแถวติดป้าย TEST) |
| `FETCH_TIMEOUT_MS` | `10000` | Timeout ฝั่งเซิร์ฟเวอร์ |
| `ADMIN_USERNAME` | — | ชื่อ Admin เริ่มต้น สร้างเมื่อฐานข้อมูลผู้ใช้ยังว่าง |
| `ADMIN_PASSWORD` | — | รหัสผ่าน Admin เริ่มต้น ต้องยาวอย่างน้อย 12 ตัวอักษร |

### Login และสิทธิ์ผู้ใช้

1. กำหนด `ADMIN_USERNAME` และ `ADMIN_PASSWORD` ใน `.env` ก่อนเริ่มระบบครั้งแรก รหัสผ่าน Admin ต้องยาวอย่างน้อย 12 ตัวอักษร
2. ผู้ใช้และค่าตั้งต้นจะถูกเก็บใน `data/users.json` ซึ่งอยู่นอกโฟลเดอร์ที่เว็บเสิร์ฟและถูก ignore โดย Git; สำรองไฟล์นี้อย่างปลอดภัย
3. Admin เปิด **จัดการผู้ใช้** เพื่อสร้าง/แก้ไข/ลบบัญชี กำหนดสิทธิ์หน้า (ภาพรวม, แนวโน้ม, ประวัติ, วิเคราะห์ Playlist), กล้องที่เข้าถึงได้, วันหมดอายุ และจำนวนกราฟต่อหน้า Overview/Trend สำหรับผู้ใช้ทั่วไป (1–20)
4. Admin เข้าได้ทุกหน้าและทุกกล้องโดยไม่จำกัดจำนวนกราฟ; บัญชีผู้ใช้ทั่วไปเห็นเฉพาะหน้ากับกล้องที่ได้รับอนุญาต การจำกัดกล้องถูกตรวจซ้ำที่ API
5. รหัสผ่านบัญชีถูกจัดเก็บเป็น salted scrypt hash; session ใช้ cookie `HttpOnly` และหมดอายุหลัง 12 ชั่วโมง การรีสตาร์ตเซิร์ฟเวอร์ทำให้ session เดิมออกจากระบบ
6. คอนฟิก Dashboard เช่น layout, กล้อง, ลำดับหน้าต่าง, series, tick, ช่วงเวลา และขนาดกราฟ ถูกบันทึกฝั่งเซิร์ฟเวอร์แยกตามผู้ใช้

การกำหนด `ADMIN_USERNAME`/`ADMIN_PASSWORD` ภายหลังจะไม่เขียนทับฐานข้อมูลที่สร้างไว้แล้ว หากต้องการเปลี่ยนรหัส admin ให้แก้บัญชีจากหน้าจัดการผู้ใช้ ห้ามลบ `data/users.json` บนระบบที่มีบัญชีใช้งานอยู่

## Proxy endpoints ที่ Browser เห็น

- `POST /api/auth/login` · `GET /api/auth/me` · `POST /api/auth/logout` — เข้าสู่ระบบ/ตรวจ session/ออกจากระบบ
- `GET /api/user/preferences` · `PUT /api/user/preferences` — อ่าน/บันทึกคอนฟิกของบัญชีที่เข้าสู่ระบบ
- `/api/admin/users` และ `/api/admin/users/:id` — จัดการบัญชี เฉพาะ Admin
- `GET /api/meta` — สถานะ proxy (มี key หรือยัง, เปิด demo หรือไม่) **ไม่ส่ง key ออก**
- `GET /api/traffic/live` — proxy ภายในที่เรียก `GET /api/traffic/latest/all` บน FastAPI
- `GET /api/health` — ผ่านไปยัง API จริงโดยไม่ใช้ key
- `GET /api/cameras` · `GET /api/traffic/latest/all` · `GET /api/traffic/latest?camera_id=` · `GET /api/traffic/history?camera_id=&start=&end=&start_date=&end_date=&limit=` — ผ่านไปยัง API จริงพร้อมแนบ key
- API Dashboard ต้องเข้าสู่ระบบ ยกเว้น endpoint login/session; endpoints จัดการบัญชีจำกัดเฉพาะ Admin

## หน้าจอของ Dashboard (4 มุมมอง สลับด้วย rail ซ้าย / URL hash)

| ปุ่ม rail | URL | เนื้อหา |
|---|---|---|
| ▦ ภาพรวม (ค่าเริ่มต้น) | `/#/overview` | แถบบนมีปุ่มเพิ่มกราฟและตัวเลือกเค้าโครง 1/2/3 คอลัมน์ + การ์ดสรุป 3 ใบ + **หน้าต่างกราฟที่จัดแถวตามขนาดอัตโนมัติ**; ย่อ/ขยายการ์ดได้ทั้งกว้างและสูง และกราฟใหม่ใช้ขนาดตามการ์ดล่าสุด โดยย้ายลงแถวถัดไปเมื่อพื้นที่ไม่พอ แถบย้อนหลังเลื่อนทีละช่วงกราฟพร้อมปุ่ม ‹/› |
| ◔ แนวโน้ม | `/#/trend` | เพิ่มกราฟและเลือกกล้อง ค้นหาช่วงประวัติ เลื่อนกราฟดูประวัติทีละช่วงกราฟ ดูการ์ดสรุป 3 ใบและตารางผลลัพธ์ที่กำหนดจำนวนแถว/ส่งออก CSV ได้; เค้าโครงแยกจาก Overview |
| ☰ ประวัติ | `/#/history` | ตารางประวัติเฉพาะเพจ พร้อมจำนวนรายการ **ไม่มีกราฟคู่** |
| ▤ วิเคราะห์ Playlist | `/#/analysis` | นำเข้ารายงาน Playlist เลือกกล้อง แล้วคำนวณผลต่างของตัวนับสะสมในช่วงเวลาเล่นสื่อ |
| ⌕ ตัวกรอง | — | เปิด/ปิดตัวกรองจากด้านบน; ปุ่ม ⌗ ทางซ้ายใช้สลับได้เช่นกัน (ไม่แสดงใน Trend) |

> เปิดลิงก์ตรงๆ เช่น `http://localhost:3000/#/history` เข้าหน้าประวัติได้เลย (deep-link รองรับ)
> หน้าต่างกล้องและกราฟย่อใช้แถวที่ "เห็นได้" ตามนโยบายข้อ 10 เดียวกับกราฟใหญ่
> ส่วนที่เพิ่งถูก unhidden จะถูกวาดใหม่ทันที (กราฟที่อยู่ใน `hidden` มี `clientWidth = 0`)

ข้อมูลทุกแถวที่ API ส่งกลับจะถูกรวมในกราฟและการ์ดสรุป โดยไม่แสดงป้ายหรือคำเตือนข้อมูลทดสอบบนหน้าจอ

## ความปลอดภัย

- `UPSTREAM_API_KEY` อ่านจาก environment เท่านั้น ไม่ถูกส่ง/แสดงใน JavaScript ฝั่ง Browser
- `.env` อยู่ใน `.gitignore` และ `.env.example` ไม่มี secret จริง
- Dashboard API ต้องมี session; cookie เป็น `HttpOnly`/`SameSite=Lax`; รหัสผ่านใน `data/users.json` เป็น salted scrypt hash และไฟล์ถูก ignore โดย Git
- จำกัด login ไม่เกิน 10 ครั้งต่อ IP ใน 15 นาที; account ที่หมดอายุใช้งานไม่ได้
- ก่อนใช้งานผ่านเครือข่ายจริง ควรให้บริการผ่าน HTTPS และจำกัดการเข้าถึงพอร์ตด้วย firewall/reverse proxy
- ติดต่อกับ VPS แบบ **GET read-only** — ไม่แก้ไข/ลบ FastAPI, PostgreSQL หรือ Docker ใดๆ
- ไม่มีการเขียนข้อมูลกลับ (ไม่ใช้ `POST /api/traffic`)

## ตรวจสอบ

```powershell
node --check server.js        # syntax ฝั่งเซิร์ฟเวอร์
node --check public/js/app.js # syntax ฝั่ง UI
# หลังรัน server:
Invoke-WebRequest http://localhost:3000/api/meta
Invoke-WebRequest http://localhost:3000/api/health
Invoke-WebRequest http://localhost:3000/api/cameras
```

## Troubleshooting

| อาการ | สาเหตุ/วิธีแก้ |
|---|---|
| `API_KEY_NOT_CONFIGURED` (503) | ยังไม่ใส่ `UPSTREAM_API_KEY` ใน `.env` แล้วรีสตาร์ท |
| `UPSTREAM_UNAUTHORIZED` (502/401) | key ไม่ถูกต้อง — ตรวจค่าใน `.env` |
| `UPSTREAM_UNREACHABLE` | VPS/เครือข่ายเข้าไม่ถึง `43.229.79.171:8000` |
| พอร์ตถูกใช้งานแล้ว | เปลี่ยน `PORT` ใน `.env` |
"# Traffic-Counting-Dashboard" 
