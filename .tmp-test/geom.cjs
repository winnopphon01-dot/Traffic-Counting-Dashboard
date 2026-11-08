const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
if(!EDGE){console.log('NO EDGE');process.exit(1)}
const PORT = 9344;
const PROFILE = path.join(os.tmpdir(),'td_prof_geom');
const child = spawn(EDGE,['--headless=new','--disable-gpu','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','--window-size=1440,1000','about:blank'],{detached:true,stdio:'ignore'});
child.unref();
const kill=()=>{try{execSync('taskkill /PID '+child.pid+' /T /F',{stdio:'ignore'})}catch{}}
function getWsUrl(){return new Promise((resolve,reject)=>{let t=0;const tick=()=>{const req=http.get({host:'127.0.0.1',port:PORT,path:'/json/version'},(res)=>{let d='';res.on('data',(c)=>{d+=c});res.on('end',()=>{try{resolve(JSON.parse(d).webSocketDebuggerUrl)}catch(e){reject(e)}})});req.on('error',()=>{if(++t>40)reject(new Error('no devtools'));else setTimeout(tick,250)})};tick()})}
const box=(sel)=>"(function(){var e=document.querySelector('"+sel+"'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height),cw:e.clientWidth,sw:e.scrollWidth};})()";
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
 const errs=()=>events.filter((e)=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map((e)=>e.params.entry.text);
 await send('Page.navigate',{url:'http://localhost:3000/#/overview'});
 await sleep(4500);
 const probe=async(label)=>{
  out.push('=== '+label+' ===');
  for(const sel of ['.main','.container','#cameraWindows','.cam-win','.cam-chart-wrap','.cam-chart-wrap svg']) out.push('  '+sel+' = '+JSON.stringify(await evalJS(box(sel))));
  out.push('  monitorGrid.cols = '+await evalJS("getComputedStyle(document.getElementById('cameraWindows')).gridTemplateColumns"));
  out.push('  camWin.count='+await evalJS("document.querySelectorAll('.cam-win').length")+' svg.count='+await evalJS("document.querySelectorAll('.cam-chart-wrap svg').length"));
  out.push('  svg.widths='+await evalJS("Array.from(document.querySelectorAll('.cam-chart-wrap svg')).map(function(s){return s.getAttribute('width')+'x'+s.getAttribute('height')}).join(' ')"));
 };
 await probe('cols=2 default');
 for(const c of ['1','3']){ await evalJS("(function(){var l=document.getElementById('layoutCols'); l.value='"+c+"'; l.dispatchEvent(new Event('change',{bubbles:true}));})()"); await sleep(400); await probe('cols='+c); }
 out.push('=== controls ===');
 out.push('  camToggle='+await evalJS("document.querySelectorAll('[data-cam-series-key]').length")+' camRange='+await evalJS("document.querySelectorAll('[data-cam-range]').length"));
 const cam0=await evalJS("document.querySelector('.cam-win')&&document.querySelector('.cam-win').getAttribute('data-cam-win')");
 out.push('  firstCam='+cam0);
 if(cam0){ await evalJS("document.querySelector('[data-cam-win-key=\"'+cam0+'\"][data-cam-series-key=person_count]').click()"); await sleep(300);
  out.push('  [person OFF cam0] paths='+await evalJS("document.querySelector('[data-cam-chart-wrap=\"'+cam0+'\"]').querySelectorAll('path[fill=\"none\"]').length"));
  await evalJS("(function(){var s=document.querySelector('[data-cam-win-key=\"'+cam0+'\"][data-cam-range]'); s.value='1h'; s.dispatchEvent(new Event('change',{bubbles:true}));})()"); await sleep(300);
  out.push('  [range=1h cam0] val='+await evalJS("document.querySelector('[data-cam-win-key=\"'+cam0+'\"][data-cam-range]').value"));
 }
 out.push('ERRORS: '+(errs().length?errs().join(' | '):'none'));
 console.log(out.join('\n')); ws.close(); kill(); process.exit(0);
})().catch((e)=>{console.log('FAIL: '+e.message); kill(); process.exit(1)});
