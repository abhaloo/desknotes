/**
 * Electron-level screenshot cost: how long a screenshot takes and how long it
 * blocks the MAIN process (which also runs the VAD gate, the audio uplink and
 * the token relay), for the old thumbnail path vs the off-main grabber.
 *
 *   node_modules/electron/dist/electron bench/electron-screen.mjs
 *
 * Needs a real display. Results go to stdout and bench/results/electron-screen.txt
 * (Electron's stdout is not always visible on Windows).
 */
import { app, BrowserWindow, desktopCapturer, session } from "electron";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreenCapture } from "../src/vision/index.js";
import { createScreenGrabber } from "../src/desktop/screen-grabber.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "results", "electron-screen.txt");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, "");
const out = (line) => {
  console.log(line);
  appendFileSync(OUT, `${line}\n`);
};

/** Max event-loop delay seen while `fn` runs (5 ms probe). */
async function measure(fn) {
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 5);
    last = t;
  }, 5);
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  clearInterval(probe);
  return { ms, lag: Math.max(worst, 0), value };
}

app.whenReady().then(async () => {
  // A visible-window stand-in so the grabber's lifetime rules behave as in the app.
  const anchor = new BrowserWindow({ show: false, width: 200, height: 100 });
  out(`electron ${process.versions.electron}, ${process.platform}`);

  const thumb = new ScreenCapture({ desktopCapturer, maxWidth: 1920, jpegQuality: 85 });
  for (let i = 0; i < 3; i++) {
    const r = await measure(() => thumb.capture({}));
    out(`thumbnail path #${i + 1}: ${r.ms.toFixed(0)} ms, main blocked up to ${r.lag.toFixed(0)} ms, ${(r.value?.bytes.length / 1024).toFixed(0)} KB`);
  }

  const grabber = createScreenGrabber({
    BrowserWindow,
    desktopCapturer,
    session,
    app,
    pagePath: join(HERE, "..", "src", "desktop", "capture", "capture.html"),
    log: (m) => out(`  grabber: ${m}`),
  });
  const w = await measure(() => grabber.warm());
  out(`grabber warm (session start): ${w.ms.toFixed(0)} ms, main blocked up to ${w.lag.toFixed(0)} ms, ok=${w.value}`);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const r = await measure(() => grabber.capture({}));
    out(`grabber #${i + 1}: ${r.ms.toFixed(0)} ms, main blocked up to ${r.lag.toFixed(0)} ms, ${(r.value?.bytes.length / 1024).toFixed(0)} KB ${r.value?.width}x${r.value?.height}`);
  }
  grabber.close();
  anchor.destroy();
  app.quit();
});
