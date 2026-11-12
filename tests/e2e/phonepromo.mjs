// Landscape promo image with three phone screenshots (for galleries that use
// 16:9-ish images), as WebP in two widths.
//
//   node tests/e2e/phonepromo.mjs <shots dir with phone-*.jpg> <out prefix>
//   → <out prefix>-800.webp, <out prefix>-1440.webp

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [dir, out] = process.argv.slice(2);
const img = (n) => `data:image/jpeg;base64,${readFileSync(join(dir, `phone-${n}.jpg`)).toString("base64")}`;
const html = `<!doctype html><style>
html,body{margin:0;width:1440px;height:868px;overflow:hidden}
body{background:radial-gradient(900px 500px at 20% 0%,rgba(252,238,10,.22),transparent 60%),radial-gradient(800px 600px at 100% 100%,rgba(255,42,109,.28),transparent 60%),linear-gradient(140deg,#140f28,#07060f);display:flex;align-items:center;justify-content:center;gap:34px;font-family:Segoe UI,sans-serif}
.ph{width:250px;border-radius:44px;padding:11px;background:linear-gradient(160deg,#2c2645,#0c0a17);box-shadow:0 0 0 1px rgba(255,255,255,.16),0 50px 110px -30px #000,0 0 80px -30px #05d9e8;position:relative}
.ph img{display:block;width:100%;border-radius:34px}
.ph:nth-child(2){transform:translateY(-30px) scale(1.07);box-shadow:0 0 0 1px rgba(255,255,255,.2),0 60px 120px -30px #000,0 0 90px -24px #fcee0a}
.ph:nth-child(1){transform:rotate(-4deg)}.ph:nth-child(3){transform:rotate(4deg)}
</style><div class="ph"><img src="${img("nav")}"></div><div class="ph"><img src="${img("chat")}"></div><div class="ph"><img src="${img("qr")}"></div>`;
const b = await chromium.launch({ headless: true });
for (const w of [1440, 800]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 868 }, deviceScaleFactor: w / 1440 });
  await p.setContent(html);
  await p.waitForTimeout(300);
  const png = await p.screenshot();
  const webp = await p.evaluate(async (src) => {
    const i = new Image();
    i.src = src;
    await i.decode();
    const c = document.createElement("canvas");
    c.width = i.width;
    c.height = i.height;
    c.getContext("2d").drawImage(i, 0, 0);
    return c.toDataURL("image/webp", 0.86).split(",")[1];
  }, `data:image/png;base64,${png.toString("base64")}`);
  writeFileSync(`${out}-${w}.webp`, Buffer.from(webp, "base64"));
  await p.close();
}
await b.close();
console.log("promo written");
