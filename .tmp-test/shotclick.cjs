const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
if(!EDGE){console.log('NO EDGE');process.exit(1)}
const PORT = 9351;
const PROFILE = path.join(os.tmpdir(),'td_prof_shot');
const PNG = process.argv[2] || path.join(os.tmpdir(),'td_shot.png');
const URL = process.argv[3] || 'http://localhost:3000/#/overview';
const W = process.argv[4] || 1440;
const H = process.argv[5] || 900;
const child = spawn(EDGE,['--headless=new','--disable-gpu','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','--window-size='+W+','+H,'about:blank'],{detached:true,stdio:'ignore'});
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
  await send('Emulation.setDeviceMetricsOverride',{width:Number(W),height:Number(H),deviceScaleFactor:1,mobile:false});
  const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
  await send('Page.navigate',{url:URL});
  await sleep(5000);
  if (process.env.TD_CLICK) {
    await evalJS("(function(){var b=document.querySelector(process.env.TD_CLICK); if(b){b.click();} return !!b;})()");
    await sleep(1200);
  }
  if (process.env.TD_TF) {
    await evalJS("(function(){var s=document.getElementById('candleTf'); if(s){s.value=process.env.TD_TF; s.dispatchEvent(new Event('change',{bubbles:true}));} return !!s;})()");
    await sleep(1200);
  }
  const dump = await evalJS(`(function(){
    var grid=document.getElementById('cameraWindows');
    var wrap=document.querySelector('.cam-chart-wrap');
    var svg=document.querySelector('.cam-chart-wrap svg');
    var win=document.querySelector('.cam-win');
    function b(e){ if(!e) return null; var r=e.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} }
    var paths = svg ? Array.from(svg.querySelectorAll('path[fill="none"]')).map(function(p){var r=p.getBBox(); return Math.round(r.x)+','+Math.round(r.width)+'x'+Math.round(r.height)}) : [];
    return {
      gridClass: grid ? grid.className : null,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
      win: b(win), wrap: b(wrap), svgBox: b(svg),
      viewBox: svg ? svg.getAttribute('viewBox') : null,
      svgW: svg ? svg.getAttribute('width') : null,
      svgH: svg ? svg.getAttribute('height') : null,
      preserve: svg ? svg.getAttribute('preserveAspectRatio') : null,
      cssW: svg ? getComputedStyle(svg).width : null,
      cssH: svg ? getComputedStyle(svg).height : null,
      paths: paths,
      winCount: document.querySelectorAll('.cam-win').length
    };
  })()`);
  out.push('DUMP='+JSON.stringify(dump,null,1));
  const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  if(shot.result && shot.result.data) fs.writeFileSync(PNG, Buffer.from(shot.result.data,'base64'));
  const errs=events.filter((e)=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map((e)=>e.params.entry.text);
  out.push('ERRORS: '+(errs.length?errs.join(' | '):'none'));
  console.log(out.join('\n'));
  ws.close(); kill(); process.exit(0);
})().catch((e)=>{console.log('FAIL: '+e.message); kill(); process.exit(1)});

