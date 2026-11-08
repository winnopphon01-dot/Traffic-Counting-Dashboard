const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://localhost:3000/#/overview", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const wins = [...document.querySelectorAll("[data-cam-win]")];
    return wins.map((w) => {
      const wrap = w.querySelector("[data-cam-chart-wrap]");
      const svg = wrap ? wrap.querySelector("svg") : null;
      const rect = wrap ? wrap.getBoundingClientRect() : null;
      let bbox = null;
      if (svg) {
        const paths = [...svg.querySelectorAll("path[stroke]")];
        if (paths.length) {
          let minX = Infinity, maxX = -Infinity;
          for (const p of paths) {
            const b = p.getBBox();
            if (!isFinite(b.x)) continue;
            minX = Math.min(minX, b.x);
            maxX = Math.max(maxX, b.x + b.width);
          }
          bbox = [Math.round(minX), Math.round(maxX)];
        }
      }
      return {
        cam: w.getAttribute("data-cam-win"),
        winW: Math.round(w.getBoundingClientRect().width),
        wrapW: rect ? Math.round(rect.width) : null,
        svgW: svg ? svg.getAttribute("width") : null,
        svgViewBox: svg ? svg.getAttribute("viewBox") : null,
        cssW: svg ? svg.getBoundingClientRect().width : null,
        cssH: svg ? svg.getBoundingClientRect().height : null,
        pathBBox: bbox,
      };
    });
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });