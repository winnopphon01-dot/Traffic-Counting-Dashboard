const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
if(!EDGE){console.log('NO EDGE');process.exit(1)}
const PORT = 9362;
const PROFILE = path.join(os.tmpdir(),'td_prof_axis');
const child = spawn(EDGE,['--headless=new','--disable-gpu','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','--window-size=1440,1000','about:blank'],{detached:true,stdio:'ignore'});
child.unref();
const kill=()=>{try{execSync('taskkill /PID '+child.pid+' /T /F',{stdio:'ignore'})}catch{}};
function getWsUrl(){return new Promise((resolve,reject)=>{let t=0;const tick=()=>{const req=http.get({host:'127.0.0.1',port:PORT,path:'/json/version'},(res)=>{let d='';res.on('data',(c)=>{d+=c});res.on('end',()=>{try{resolve(JSON.parse(d).webSocketDebuggerUrl)}catch(e){reject(e)}})});req.on('error',()=>{if(++t>40)reject(new Error('no devtools'));else setTimeout(tick,250)})};tick()})}
(async()=>{
  const wsUrl=await getWsUrl(); const out=[];
  const ws=new WebSocket(wsUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',()=>rej(new Error('ws')))});
  let id=0; const waiters=new Map(); const events=[]; let sessionId=null;
  ws.addEventListener('message',(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id)} else if(m.method)events.push(m)});
  const send=(method,params={})=>new Promise((res)=>{const i=++id; const msg={id:i,method,params}; if(sessionId)msg.sessionId=sessionId; waiters.set(i,res); ws.send(JSON.stringify(msg))});
  const evalJS=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); return r.result&&r.result.result?r.result.result.value:null};
  await send('Target.setDiscoverTargets',{discover:true});
  await send('Target.createTarget',{url:'about:blank'});
  await new Promise((r)=>setTimeout(r,900));
  const targets=await send('Target.getTargets');
  const page=targets.result.targetInfos.find((t)=>t.type==='page');
  const att=await send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
  sessionId=att.result.sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
  await send('Page.navigate',{url:'http://localhost:3000/#/overview'});
  await sleep(5000);
  // ดึงข้อมูลจริงจาก API ผ่าน proxy ของแอป + สถิติเวลา
  const raw = await evalJS(`(async function(){
    var r = await fetch('/api/traffic/history?limit=300');
    var j = await r.json();
    var rows = j.data || j;
    var ts = rows.map(function(x){ return Date.parse(x.event_time || x.created_at); });
    ts.sort(function(a,b){return a-b});
    var uniq = {}; ts.forEach(function(t){ uniq[t]=(uniq[t]||0)+1 });
    var keys = Object.keys(uniq).sort();
    return {
      total: rows.length,
      nanCount: ts.filter(function(t){return !isFinite(t)}).length,
      min: ts.length? new Date(ts[0]).toISOString():null,
      max: ts.length? new Date(ts[ts.length-1]).toISOString():null,
      spanMs: ts.length? ts[ts.length-1]-ts[0] : 0,
      distinct: keys.length,
      topTimes: keys.slice(-6).map(function(k){return new Date(Number(k)).toISOString()+' x'+uniq[k]}),
      sampleRaw: rows.slice(0,3).map(function(x){return {et:x.event_time, ca:x.created_at}})
    };
  })()`);
  out.push('RAW='+JSON.stringify(raw,null,1));
  // สถิติจุดที่ chart ตัวแรกกำลังถืออยู่
  const chartPts = await evalJS(`(function(){
    var wrap = document.querySelector('[data-cam-chart-wrap]');
    if(!wrap) return 'no wrap';
    var svg = wrap.querySelector('svg');
    if(!svg) return 'no svg';
    var circles = svg.querySelectorAll('circle');
    var xs = Array.from(circles).map(function(c){ return Math.round(parseFloat(c.getAttribute('cx'))); });
    xs.sort(function(a,b){return a-b});
    return { circleCount: circles.length, minX: xs[0], maxX: xs[xs.length-1], first8: xs.slice(0,8), last8: xs.slice(-8) };
  })()`);
  out.push('CIRCLES='+JSON.stringify(chartPts));
  // path bbox ทั้งหมดใน svg แรก
  const paths = await evalJS(`(function(){
    var svg = document.querySelector('[data-cam-chart-wrap] svg');
    if(!svg) return [];
    return Array.from(svg.querySelectorAll('path')).map(function(p){ var r=p.getBBox(); return (p.getAttribute('fill')||'none').slice(0,14)+' x='+Math.round(r.x)+' w='+Math.round(r.width)+' y='+Math.round(r.y)+' h='+Math.round(r.height) });
  })()`);
  out.push('PATHS='+JSON.stringify(paths,null,1));
  const errs=events.filter((e)=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map((e)=>e.params.entry.text);
  out.push('ERRORS: '+(errs.length?errs.join(' | '):'none'));
  console.log(out.join('\n'));
  ws.close(); kill(); process.exit(0);
})().catch((e)=>{console.log('FAIL: '+e.message); kill(); process.exit(1)});
