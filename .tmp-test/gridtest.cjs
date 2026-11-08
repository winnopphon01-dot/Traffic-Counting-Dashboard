const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.log('NO EDGE'); process.exit(1); }

const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), 'td_prof_grid');
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1000', 'about:blank',
], { detached: true, stdio: 'ignore' });
child.unref();
const kill = () => { try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch {} };

function getWsUrl() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d).webSocketDebuggerUrl); } catch (e) { reject(e); } });
      });
      req.on('error', () => { if (++tries > 40) reject(new Error('no devtools')); else setTimeout(tick, 250); });
    };
    tick();
  });
}

(async () => {
  const wsUrl = await getWsUrl();
  const out = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
  let id = 0;
  const waiters = new Map();
  const events = [];
  let sessionId = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const msg = { id: i, method, params };
    if (sessionId) msg.sessionId = sessionId;
    waiters.set(i, res);
    ws.send(JSON.stringify(msg));
  });
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.createTarget', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 900));
  const targets = await send('Target.getTargets');
  const page = targets.result.targetInfos.find((t) => t.type === 'page');
  const att = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  sessionId = att.result.sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errs = () => events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text);

  await send('Page.navigate', { url: 'http://localhost:3000/#/trend' });
  await sleep(4500);
  out.push('[trend] svg=' + (await evalJS("!!document.querySelector('#chartWrap svg')")) + ' chip="' + await evalJS("document.getElementById('chartInfo').textContent") + '"');
  out.push('  seriesPaths=' + await evalJS("document.querySelectorAll('#chartWrap svg path[fill=\"none\"]').length") + ' toggles=' + await evalJS("document.querySelectorAll('[data-series-key]').length"));
  await evalJS("document.querySelector('[data-series-key=person_count]').click()");
  await sleep(300);
  out.push('  [person OFF] paths=' + await evalJS("document.querySelectorAll('#chartWrap svg path[fill=\"none\"]').length") + ' pressed=' + await evalJS("document.querySelector('[data-series-key=person_count]').getAttribute('aria-pressed')"));
  await evalJS("document.querySelector('[data-series-key=vehicle_count]').click()");
  await sleep(300);
  out.push('  [veh OFF too] paths=' + await evalJS("document.querySelectorAll('#chartWrap svg path[fill=\"none\"]').length") + ' wrapHidden=' + await evalJS("document.getElementById('chartWrap').hidden"));
  await evalJS("document.querySelector('[data-series-key=vehicle_count]').click()");
  await evalJS("document.querySelector('[data-series-key=person_count]').click()");
  await sleep(300);
  out.push('  [all back] paths=' + await evalJS("document.querySelectorAll('#chartWrap svg path[fill=\"none\"]').length"));

  for (const r of ['1h', '6h', '1d', '7d', '30d', 'all']) {
    await evalJS("(function(){var s=document.getElementById('chartRange'); s.value='" + r + "'; s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await sleep(250);
    out.push('  [range=' + r + '] chip="' + await evalJS("document.getElementById('chartInfo').textContent") + '" svg=' + await evalJS("!!document.querySelector('#chartWrap svg')") + ' stateHidden=' + await evalJS("document.getElementById('chartState').hidden"));
  }

  for (const c of ['1', '2', '3']) {
    await evalJS("(function(){var l=document.getElementById('layoutCols'); l.value='" + c + "'; l.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await sleep(350);
    out.push('  [cols=' + c + '] main="' + await evalJS("document.querySelector('.container').className") + '" svgW=' + await evalJS("document.querySelector('#chartWrap svg').getAttribute('width')") + ' svgH=' + await evalJS("document.querySelector('#chartWrap svg').getAttribute('height')"));
  }

  await send('Page.navigate', { url: 'http://localhost:3000/#/overview' });
  await sleep(3000);
  out.push('[overview] shown=' + await evalJS("Array.from(document.querySelectorAll('[data-view]')).filter(function(e){return !e.hidden}).map(function(e){return e.id}).join(',')"));
  out.push('  svgH=' + await evalJS("document.querySelector('#chartWrap svg').getAttribute('height')") + ' cols=' + await evalJS("document.querySelector('.container').className"));

  await send('Page.navigate', { url: 'http://localhost:3000/#/history' });
  await sleep(2000);
  out.push('[history] shown=' + await evalJS("Array.from(document.querySelectorAll('[data-view]')).filter(function(e){return !e.hidden}).map(function(e){return e.id}).join(',')") + ' rows=' + await evalJS("document.querySelectorAll('#historyBody tr').length") + ' svg=' + await evalJS("!!document.querySelector('#tableSection svg')"));

  out.push('ERRORS: ' + (errs().length ? errs().join(' | ') : 'none'));
  console.log(out.join('\n'));
  ws.close();
  kill();
  process.exit(0);
})().catch((e) => { console.log('FAIL: ' + e.message); kill(); process.exit(1); });
