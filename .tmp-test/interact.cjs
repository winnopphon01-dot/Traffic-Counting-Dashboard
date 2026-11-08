const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
const PORT = 9360;
const PROFILE = path.join(os.tmpdir(),'td_prof_it');
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
  await sleep(4500);

  const info = await evalJS(`JSON.stringify((function(){
    var wins=Array.prototype.slice.call(document.querySelectorAll('.cam-window'));
    return { winCount: wins.length, perWindow: wins.map(function(w){ return {
      id: w.getAttribute('data-cam'),
      ranges: w.querySelectorAll('select[data-role="range"]').length,
      toggles: w.querySelectorAll('button[data-series-key]').length,
      svg: w.querySelectorAll('svg').length,
      togglesOn: Array.prototype.slice.call(w.querySelectorAll('button[data-series-key].is-on')).map(function(b){return b.getAttribute('data-series-key')})
    };})};
  })())`);
  console.log('BEFORE:', info);

  await evalJS(`(function(){
    var w=document.querySelector('.cam-window');
    w.querySelector('button[data-series-key="person_count"]').click();
    var sel=w.querySelector('select[data-role="range"]');
    sel.value='6h';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(1200);

  const after = await evalJS(`JSON.stringify((function(){
    var w=document.querySelector('.cam-window');
    return {
      togglesOn: Array.prototype.slice.call(w.querySelectorAll('button[data-series-key].is-on')).map(function(b){return b.getAttribute('data-series-key')}),
      range: w.querySelector('select[data-role="range"]').value,
      strokePaths: w.querySelectorAll('path[stroke-width="2.4"]').length,
      hoverDots: w.querySelectorAll('.hover-dots circle').length
    };
  })())`);
  console.log('AFTER EDIT WIN1:', after);

  const win2 = await evalJS(`JSON.stringify((function(){
    var w=document.querySelectorAll('.cam-window')[1];
    return {
      id: w.getAttribute('data-cam'),
      togglesOn: Array.prototype.slice.call(w.querySelectorAll('button[data-series-key].is-on')).map(function(b){return b.getAttribute('data-series-key')}),
      range: w.querySelector('select[data-role="range"]').value
    };
  })())`);
  console.log('WIN2 UNCHANGED:', win2);

  await evalJS(`(function(){ document.getElementById('refreshBtn').click(); return true; })()`);
  await sleep(3500);
  const afterRefresh = await evalJS(`JSON.stringify((function(){
    var w=document.querySelector('.cam-window');
    return {
      togglesOn: Array.prototype.slice.call(w.querySelectorAll('button[data-series-key].is-on')).map(function(b){return b.getAttribute('data-series-key')}),
      range: w.querySelector('select[data-role="range"]').value,
      strokePaths: w.querySelectorAll('path[stroke-width="2.4"]').length
    };
  })())`);
  console.log('AFTER REFRESH:', afterRefresh);

  const errs = events.filter(function(e){return (e.method==='Log.entryAdded'&&e.params.entry.level==='error')||e.method==='Runtime.exceptionThrown'}).map(function(e){return e.params.entry?e.params.entry.text:e.params.exceptionDetails.text});
  console.log('ERRORS:', errs.length?errs:'none');
  ws.close(); kill(); process.exit(0);
})().catch((e)=>{console.error('FATAL',e); kill(); process.exit(1);});
