/**
 * Renderer-thread paint cost of streamed answers and transcript lanes, old vs
 * new (F11), in a real Chromium renderer with the overlay stylesheet.
 *
 *   node_modules/electron/dist/electron bench/electron-render.mjs
 *
 * Output: stdout and bench/results/electron-render.txt (ms of renderer time
 * spent painting an 800-token answer / 600 transcripts on a 60-line lane).
 */
import { app, BrowserWindow } from "electron";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results", "electron-render.txt");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, "");
const out = (line) => {
  console.log(line);
  appendFileSync(OUT, `${line}\n`);
};

app.whenReady().then(async () => {
  // Offscreen rendering: a real compositor and requestAnimationFrame without
  // putting a window on screen.
  const win = new BrowserWindow({ show: false, width: 420, height: 700, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadFile(join(HERE, "render", "render.html"));
  for (let i = 0; i < 50 && (await win.webContents.executeJavaScript("document.title")) !== "ready"; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  out(`electron ${process.versions.electron}: renderer ms spent painting (lower is better)`);
  for (let rep = 0; rep < 2; rep++) {
    const results = await win.webContents.executeJavaScript("runRenderBench()");
    for (const [name, ms] of Object.entries(results)) out(`  run ${rep + 1}  ${name}: ${ms} ms`);
  }
  win.destroy();
  app.quit();
});
