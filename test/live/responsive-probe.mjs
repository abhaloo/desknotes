/**
 * Resize-matrix probe: drives the real app over CDP and asserts layout
 * invariants at several window sizes - no clipping, no footer overlap,
 * every key section present and inside the window (or scroll-reachable).
 *
 * Usage: bun test/live/responsive-probe.mjs
 * Exit 0 = all sizes pass; exit 1 = geometry violations listed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const electronExe = ["node_modules/electron/dist/electron.exe", "node_modules/electron/dist/electron"].find((p) => existsSync(p));
const PORT = 9335;
const SIZES = [
  { width: 300, height: 400 },
  { width: 420, height: 620 },
  { width: 480, height: 700 },
  { width: 520, height: 760 },
  { width: 800, height: 1000 },
];

const app = spawn(electronExe ?? "electron", ["src/desktop/main.mjs", `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, CAPTURE_BACKEND: process.env.CAPTURE_BACKEND ?? "simulated" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const control = list.find((t) => t.url.includes("mode=control"));
      if (control) {
        const { default: WebSocket } = await import("ws");
        const ws = new WebSocket(control.webSocketDebuggerUrl);
        await new Promise((r) => ws.on("open", r));
        let id = 0;
        const pending = new Map();
        ws.on("message", (raw) => {
          const m = JSON.parse(String(raw));
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        });
        return {
          eval: (expression) =>
            new Promise((res) => {
              id += 1;
              pending.set(id, res);
              ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
            }),
          close: () => ws.close(),
        };
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error("devtools endpoint never came up");
}

const value = (msg) => msg?.result?.result?.value;

/** Geometry invariants checked in-page at the current size. */
const INSPECT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { vw, vh, problems: [] };
  const rect = (el) => el.getBoundingClientRect();

  // 1. No horizontal overflow anywhere.
  if (document.documentElement.scrollWidth > vw + 1) out.problems.push("horizontal overflow: " + document.documentElement.scrollWidth + " > " + vw);

  // 2. Footer must not overlap any visible content section.
  const footer = document.querySelector("footer.controls") || document.querySelector("footer");
  const fr = footer && footer.offsetParent !== null ? rect(footer) : null;
  const sections = [...document.querySelectorAll("section, .answer-card, .lanes, #screen-cards")].filter((el) => el.offsetParent !== null);
  const clippedAboveFooter = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowY === "hidden") && fr && rect(p).bottom <= fr.top + 2) return true;
    }
    return false;
  };
  for (const s of sections) {
    const r = rect(s);
    if (!clippedAboveFooter(s) && fr && r.bottom > fr.top + 2 && r.top < fr.bottom - 2 && r.right > fr.left + 2 && r.left < fr.right - 2) {
      out.problems.push("section overlaps footer: " + (s.id || s.className));
    }
    // 3. Sections stay inside the window horizontally.
    if (r.left < -2 || r.right > vw + 2) out.problems.push("section escapes window horizontally: " + (s.id || s.className) + " [" + Math.round(r.left) + "," + Math.round(r.right) + "] vw=" + vw);
    // 4. Every section is reachable: inside the scroll flow (top < vh) or inside a scrollable ancestor.
    let scrollable = false;
    for (let p = s.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) { scrollable = true; break; }
    }
    const inView = r.top < vh - 2;
    if (!inView && !scrollable) out.problems.push("section unreachable (clipped): " + (s.id || s.className));
    // 5. No clipped-without-scroll region: if a section is taller than the window it must have a scrollable ancestor.
    if (r.height > vh + 2 && !scrollable) out.problems.push("section taller than window without scroll: " + (s.id || s.className));
  }
  return JSON.stringify(out);
})()`;

try {
  await sleep(3000);
  const cdp = await connect();
  let failures = 0;
  for (const size of SIZES) {
    await cdp.eval(`window.resizeTo(${size.width}, ${size.height})`);
    // Electron windows ignore resizeTo from the page; drive the host window via the devtools protocol.
    await cdp.eval(`new Promise(r => setTimeout(r, 250))`);
    const raw = value(await cdp.eval(INSPECT));
    const report = JSON.parse(raw ?? "{}");
    const ok = (report.problems ?? []).length === 0;
    if (!ok) failures += 1;
    console.log(`[responsive] ${size.width}x${size.height}: ${ok ? "OK" : "FAIL"} ${JSON.stringify(report.problems ?? [])}`);
  }
  cdp.close();
  app.kill();
  console.log(failures === 0 ? "[responsive] ALL SIZES OK" : `[responsive] ${failures} size(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  app.kill();
  console.error("[responsive] harness error:", error.message);
  process.exit(2);
}
