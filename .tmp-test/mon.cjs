const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p)=>fs.existsSync(p));
if(!EDGE){ console.log('NO EDGE'); process.exit(1); }
const PORT = 9371;
const PROFILE = path.join(os.tmpdir(),'td_prof_mon');
const URL = process.argv[2] || 'http://localhost:3000/#/overview';
const W = +(process.argv[3] || 1440);
const H = +(process.argv[4] || 950);
const child = spawn(EDGE, ['--headless=new','--disable-gpu','--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','--window-size='+W+','+H,'about:blank'], {detached:true, stdio:'ignore'});
child.unref();
const kill=()=>{ try{ execSync('taskkill /PID '+child.pid+' /T /F',{stdio:'ignore'}); }catch{} };

const PROBE = [
  'JSON.stringify((function(){',
  '  var g = document.getElementById("cameraWindows");',
  '  var cs = g ? getComputedStyle(g) : null;',
  '  var wins = [];',
  '  if (g) {',
  '    Array.prototype.forEach.call(g.children, function(x){',
  '      var svg = x.querySelector("svg");',
  '      var wrap = x.querySelector(".cam-chart-wrap");',
  '      var on = [];',
  '      Array.prototype.forEach.call(x.querySelectorAll("[data-series-key].is-on"), function(b){ on.push(b.getAttribute("data-series-key")); });',
  '      var off = [];',
  '      Array.prototype.forEach.call(x.querySelectorAll("[data-series-key]:not(.is-on)"), function(b){ off.push(b.getAttribute("data-series-key")); });',
  '      var sel = x.querySelector("select");',
  '      var p = svg ? svg.querySelector("path[fill=none]") : null;',
  '      var bb = p ? p.getBBox() : null;',
  '      wins.push({',
  '        hasSel: !!sel,',
  '        selVal: sel ? sel.value : null,',
  '        on: on.join("+"),',
  '        off: off.join("+"),',
  '        svgW: svg ? Math.round(svg.getBoundingClientRect().width) : null,',
  '        wrapW: wrap ? Math.round(wrap.clientWidth) : null,',
  '        span: bb ? [Math.round(bb.x), Math.round(bb.x + bb.width)] : null,',
  '        vbW: svg ? +svg.getAttribute("viewBox").split(" ")[2] : null,',
  '        testBadge: !!x.querySelector(".badge-test")',
  '      });',
  '    });',
  '  }',
  '  return {',
  '    gridCols: cs ? cs.gridTemplateColumns : null,',
  '    nWins: wins.length,',
  '    wins: wins,',
  '    docW: document.documentElement.scrollWidth,',
  '    vw: window.innerWidth,',
  '    railBottom: (function(){ var r=document.querySelector(".rail"); var b=r?r.getBoundingClientRect():null; return b?[Math.round(b.y),Math.round(b.height)]:null })()',
  '  };',
  '})()'
].join('\n');

function getWsUrl(){ return new Promise((resolve,reject)=>{ let t=0; const tick=()=>{ const req=http.get({host:'127.0.0.1',port:PORT,path:'/json/version'},(res)=>{ let d=''; res.on('data',(c)=>{d+=c}); res.on('end',()=>{ try{ resolve(JSON.parse(d).webSocketDebuggerUrl) }catch(e){ reject(e) } }) }); req.on('error',()=>{ if(++t>60) reject(new Error('no devtools')); else setTimeout(tick,250) }) }; tick() }) }

(async()=>{
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res,rej)=>{ ws.addEventListener('open',res); ws.addEventListener('error',()=>rej(new Error('ws'))) });
  let id=0; const waiters=new Map(); let sessionId=null; const errs=[];
  ws.addEventListener('message',(ev)=>{ const m=JSON.parse(ev.data); if(m.id&&waiters.has(m.id)){ waiters.get(m.id)(m); waiters.delete(m.id) } else if(m.method){ if(m.method==='Log.entryAdded'&&m.params.entry.level==='error') errs.push(m.params.entry.text); if(m.method==='Runtime.exceptionThrown') errs.push(m.params.exceptionDetails&&m.params.exceptionDetails.text) } });
  const send=(method,params={})=>new Promise((res)=>{ const i=++id; const msg={id:i,method,params}; if(sessionId) msg.sessionId=sessionId; waiters.set(i,res); ws.send(JSON.stringify(msg)) });
  const evalJS=async(expr)=>{ const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result&&r.result.exceptionDetails){ errs.push('EVAL: '+r.result.exceptionDetails.text); return null } return r.result&&r.result.result?r.result.result.value:null };

  await send('Target.setDiscoverTargets',{discover:true});
  await send('Target.createTarget',{url:'about:blank'});
  await new Promise((r)=>setTimeout(r,1000));
  const targets = await send('Target.getTargets');
  const page = targets.result.targetInfos.find((t)=>t.type==='page');
  const att = await send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
  sessionId = att.result.sessionId;
  await new Promise((r)=>setTimeout(r,400));
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate',{url:URL});
  await new Promise((r)=>setTimeout(r,8000));

  const before = JSON.parse(await evalJS(PROBE) || '{}');
  console.log('URL '+URL+' @'+W+'px');
  console.log('  gridCols: '+before.gridCols);
  console.log('  nWins: '+before.nWins+'  docW/vw: '+before.docW+'/'+before.vw+'  rail: '+JSON.stringify(before.railBottom));
  before.wins.forEach(function(w,i){ console.log('   ['+i+'] sel='+w.hasSel+'('+w.selVal+') on='+w.on+' off='+w.off+' svgW='+w.svgW+' wrapW='+w.wrapW+' span='+JSON.stringify(w.span)+'/'+w.vbW+' test='+w.testBadge) });

  // interaction: ปิด VEHICLE ในหน้าต่างแรก แล้วตรวจว่าเส้นเหลือ 2
  const first = before.wins[0];
  if (first && first.hasSel) {
    await evalJS('(function(){ var w=document.getElementById("cameraWindows").children[0]; var b=w.querySelector("[data-series-key=\"vehicle_count\"]"); if(b) b.click(); return 1 })()');
    await new Promise((r)=>setTimeout(r,1200));
    const afterOff = JSON.parse(await evalJS(PROBE) || '{}');
    console.log('  after toggling VEHICLE off in win[0]: on='+afterOff.wins[0].on+' off='+afterOff.wins[0].off);
    // เปลี่ยนช่วงเวลาเป็น 1 ชม.
    await evalJS('(function(){ var w=document.getElementById("cameraWindows").children[0]; var s=w.querySelector("select"); if(s){ s.value="1h"; s.dispatchEvent(new Event("change",{bubbles:true})) } return 1 })()');
    await new Promise((r)=>setTimeout(r,1200));
    const afterRange = JSON.parse(await evalJS(PROBE) || '{}');
    console.log('  after range=1h in win[0]: selVal='+afterRange.wins[0].selVal+' span='+JSON.stringify(afterRange.wins[0].span)+'/'+afterRange.wins[0].vbW);
    console.log('  other win unaffected: selVal='+afterRange.wins[1].selVal+' on='+afterRange.wins[1].on);
  }

  const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const png = path.join(os.tmpdir(),'mon_'+W+'.png');
  if(shot.result&&shot.result.data) fs.writeFileSync(png, Buffer.from(shot.result.data,'base64'));
  console.log('  PNG '+png);
  console.log('  ERRORS: '+(errs.length?errs.slice(0,5).join(' | '):'none'));
  ws.close(); kill(); process.exit(0);
})().catch((e)=>{ console.log('FAIL: '+e.message); kill(); process.exit(1) });
