const t = `
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(4000);
  const r = {};
  r.sectionCount = document.querySelectorAll('[data-view]').length;
  r.visibleSections = [...document.querySelectorAll('[data-view]')].filter(e=>!e.hidden).map(e=>e.id);
  r.monitorHTMLlen = (document.getElementById('cameraWindows')||{}).innerHTML?.length ?? -1;
  r.monitorText = (document.getElementById('cameraWindows')||{}).innerText?.slice(0,300) ?? 'NO EL';
  r.winCount = document.querySelectorAll('[data-cam-win]').length;
  r.chartWrapCount = document.querySelectorAll('[data-cam-chart-wrap]').length;
  r.svgCount = document.querySelectorAll('[data-cam-chart-wrap] svg').length;
  r.tableRows = document.querySelectorAll('tbody tr').length;
  r.toolbarText = (document.querySelector('.toolbar')||{}).innerText?.slice(0,300);
  r.chartState = document.getElementById('chartState')?.className;
  r.tableState = document.getElementById('tableState')?.className;
  r.banners = [...document.querySelectorAll('.banner')].filter(b=>!b.hidden).map(b=>b.className);
  r.testNoticeText = document.getElementById('testNotice')?.innerText?.slice(0,150);
  r.storage = Object.keys(localStorage);
  r.errors = window.__errs || 'none';
  return r;
})()
`;
module.exports = { t };
