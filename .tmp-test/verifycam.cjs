// ตรวจมุมมอง overview: หน้าต่างกราฟต่อกล้อง + ตัวกรองต่อหน้าต่าง (series 3 toggle + ช่วงเวลา)
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
const PORT = 9370;
const PROFILE = path.join(os.tmpdir(),'td_prof_cam');
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
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
  await send('Target.setDiscoverTargets',{discover:true});
  await send('Target.createTarget',{url:'about:blank'});
  await sleep(900);
  const targets=await send('Target.getTargets');
  const page=targets.result.targetInfos.find((t)=>t.type==='page');
  const att=await send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
  sessionId=att.result.sessionId;
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://localhost:3000/#/overview'});
  await sleep(5000);

  const probe = `JSON.stringify((function(){
    var wins=Array.prototype.slice.call(document.querySelectorAll('.cam-win'));
    function winfo(w){
      var svg=w.querySelector('.cam-chart-wrap svg');
      var wrap=w.querySelector('.cam-chart-wrap');
      var toggles=Array.prototype.slice.call(w.querySelectorAll('[data-cam-series-key]'));
      var ranges=w.querySelectorAll('[data-cam-range]').length;
      var paths=svg?svg.querySelectorAll('path[stroke-width="2.4"]').length:0;
      return {
        id: w.getAttribute('data-cam-win'),
        toggles: toggles.length,
        togglesOn: toggles.filter(function(b){return b.classList.contains('is-on')}).map(function(b){return b.getAttribute('data-cam-series-key')}),
        ranges: ranges,
        rangeVal: (w.querySelector('[data-cam-range]')||{}).value||null,
        hasSvg: !!svg,
        svgW: svg?Number(svg.getAttribute('width')):0,
        wrapW: wrap?Math.round(wrap.clientWidth):0,
        seriesPaths: paths,
        notice: w.querySelector('.chart-notice')?w.querySelector('.chart-notice').textContent.slice(0,40):null
      };
    }
    return {
      winCount: wins.length,
      layoutCols: (document.querySelector('.monitor-grid')||{}).className,
      wins: wins.map(winfo)
    };
  })())`;
  out.push('=== BEFORE ===');
  out.push(await evalJS(probe));

  // หน้าต่างแรก: ปิด Person แล้วเลือกช่วง 6 ชม.
  out.push('=== INTERACT ===');
  out.push(await evalJS(`(function(){
    var w=document.querySelector('.cam-win');
    w.querySelector('[data-cam-series-key="person_count"]').click();
    var sel=w.querySelector('[data-cam-range]');
    sel.value='6h';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return 'clicked';
  })()`));
  await sleep(1200);
  const after = await evalJS(probe);
  out.push(after);

  // ตรวจว่าเส้นสั้นลงจริงเมื่อเลือกช่วงเวลา (จำนวนจุดใน path ลดลง)
  out.push('=== PATH LENGTH (window 1) ===');
  out.push(await evalJS(`(function(){
    var w=document.querySelector('.cam-win');
    var p=w.querySelector('.cam-chart-wrap svg path[stroke-width="2.4"]');
    return p?String(p.getAttribute('d').length):'none';
  })()`));
  await evalJS(`(function(){
    var w=document.querySelector('.cam-win');
    var sel=w.querySelector('[data-cam-range]');
    sel.value='all';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(800);
  out.push(await evalJS(`(function(){
    var w=document.querySelector('.cam-win');
    var p=w.querySelector('.cam-chart-wrap svg path[stroke-width="2.4"]');
    return p?String(p.getAttribute('d').length):'none';
  })()`));

  // มือถือ 390px
  out.push('=== MOBILE 390 ===');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:'http://localhost:3000/#/overview'});
  await sleep(5000);
  out.push(await evalJS(probe));
  out.push(await evalJS(`JSON.stringify({docW: document.documentElement.scrollWidth, winW: document.documentElement.clientWidth, cols: getComputedStyle(document.querySelector('.monitor-grid')).gridTemplateColumns})`));

  await send('Page.navigate',{url:'http://localhost:3000/#/overview'});
  await sleep(5000);
  out.push(await evalJS(probe));

  const errors = events.filter((e)=>e.method==='Runtime.exceptionThrown').map((e)=>JSON.stringify(e.params.exceptionDetails&&e.params.exceptionDetails.text||'')).slice(0,5);
  out.push('=== EXCEPTIONS ===');
  out.push(errors.length?errors.join(' | '):'none');
  console.log(out.join('\n'));
  kill();
  process.exit(0);
})().catch((e)=>{console.error('ERR',e); kill(); process.exit(1)});
