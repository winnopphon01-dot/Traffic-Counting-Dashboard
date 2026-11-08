// Diagnostic: dump overview view state (standalone)
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
const PORT = 9361;
const PROFILE = path.join(os.tmpdir(),'td_prof_diag');
const child = spawn(EDGE,['--headless=new','--disable-gpu','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','--window-size=1440,1000','about:blank'],{detached:true,stdio:'ignore'});
child.unref();
const kill=()=>{try{execSync('taskkill /PID '+child.pid+' /T /F',{stdio:'ignore'})}catch{}};
function getWsUrl(){return new Promise((resolve,reject)=>{let t=0;const tick=()=>{const req=http.get({host:'127.0.0.1',port:PORT,path:'/json/version'},(res)=>{let d='';res.on('data',(c)=>{d+=c});res.on('end',()=>{try{resolve(JSON.parse(d).webSocketDebuggerUrl)}catch(e){reject(e)}})});req.on('error',()=>{if(++t>40)reject(new Error('no devtools'));else setTimeout(tick,250)})};tick()})}
(async()=>{
  const wsUrl=await getWsUrl();
  const ws=new WebSocket(wsUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',()=>rej(new Error('ws')))});
  let id=0; const waiters=new Map(); const events=[]; let sessionId=null;
  ws.addEventListener('message',(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiters.has(m.id)){waiters.get(m.id)(m);waiters.delete(m.id)} else if(m.method)events.push(m)});
  const send=(method,params={})=>new Promise((res)=>{const i=++id; const msg={id:i,method,params}; if(sessionId)msg.sessionId=sessionId; waiters.set(i,res); ws.send(JSON.stringify(msg))});
  const evalJS=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result&&r.result.exceptionDetails){return 'EXC: '+r.result.exceptionDetails.text} return r.result&&r.result.result?r.result.result.value:null};
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
  await sleep(6000);
  const probe = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(300);
    const secs = [...document.querySelectorAll('[data-view]')];
    const mon = document.getElementById('cameraWindows');
    return {
      sections: secs.map(e=>({id:e.id, hidden:e.hidden})),
      monLen: mon ? mon.innerHTML.length : -1,
      monText: mon ? mon.innerText.slice(0,300) : 'NO EL',
      winCount: document.querySelectorAll('[data-cam-win]').length,
      wrapCount: document.querySelectorAll('[data-cam-chart-wrap]').length,
      svgInWin: document.querySelectorAll('[data-cam-win] svg').length,
      tableRows: document.querySelectorAll('tbody tr').length,
      bannerVisible: [...document.querySelectorAll('.banner')].filter(b=>!b.hidden).map(b=>b.className),
      testNotice: (document.getElementById('testNotice')||{}).innerText?.slice(0,140),
      monitorChip: (document.getElementById('monitorChip')||{}).innerText,
      storage: Object.keys(localStorage)
    };
  })()`;
  const r = await send('Runtime.evaluate',{expression:probe,returnByValue:true,awaitPromise:true});
  const v = r.result && r.result.result ? r.result.result.value : r.result;
  console.log('DIAG=' + JSON.stringify(v, null, 1));
  const logs = events.filter(e=>e.method==='Log.entryAdded').map(e=>e.params.entry.level+': '+e.params.entry.text.slice(0,160));
  console.log('LOG_ENTRIES=' + JSON.stringify(logs.slice(0,10)));
  kill(); process.exit(0);
})().catch(e=>{console.log('FATAL '+e.message); kill(); process.exit(1)});
