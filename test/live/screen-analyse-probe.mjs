/**
 * Live probe: drives the REAL app (electron src/desktop/main.mjs) over CDP,
 * clicks #btn-screen like a user, and captures the toast/result.
 *
 * Usage: bun test/live/screen-analyse-probe.mjs [--with-session] [--exe <path>]
 * Exit 0 = analysis succeeded; exit 1 = red (the user's "analyse screen isn't working").
 */
import { spawn } from "node:child_process";

const WITH_SESSION = process.argv.includes("--with-session");
const EXE = (() => {
  const i = process.argv.indexOf("--exe");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const PORT = 9333;
import { existsSync } from "node:fs";
const electronExe = ["node_modules/electron/dist/electron.exe", "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "node_modules/electron/dist/electron"].find((p) => existsSync(p));
const electron = EXE ?? electronExe ?? "electron";

const app = spawn(electron, ["src/desktop/main.mjs", `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, CAPTURE_BACKEND: process.env.CAPTURE_BACKEND ?? "simulated" },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      return await res.json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error("devtools endpoint never came up");
}

async function connect(wsUrl) {
  const { default: WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.on("open", () =>
      resolve({
        eval: (expression) =>
          new Promise((res) => {
            id += 1;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
          }),
        close: () => ws.close(),
      }),
    );
    ws.on("error", reject);
  });
}

const value = (msg) => msg?.result?.result?.value;

try {
  await sleep(3000); // app boot
  const list = await targets();
  const control = list.find((t) => t.url.includes("mode=control"));
  if (!control) throw new Error(`control window not found in: ${list.map((t) => t.url).join(", ")}`);
  const cdp = await connect(control.webSocketDebuggerUrl);

  if (WITH_SESSION) {
    console.log("[probe] starting session (simulated capture)...");
    await cdp.eval(`document.getElementById("toggle-capture").click()`);
    await sleep(4000);
  }

  console.log("[probe] clicking Analyse screen...");
  await cdp.eval(`document.getElementById("btn-screen").click()`);
  const toast = value(await cdp.eval(`document.querySelector(".toast")?.textContent ?? ""`)) ?? "";
  let card = "";
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    card = value(await cdp.eval(`document.querySelector("#screen-cards .screen-card")?.textContent ?? ""`)) ?? "";
    if (card) break;
  }
  const sessionState = value(await cdp.eval(`JSON.stringify(window.__probeState ?? null)`)) ?? "null";
  console.log(`[probe] toast: ${JSON.stringify(toast)}`);
  console.log(`[probe] card: ${JSON.stringify(card.slice(0, 120))}`);
  console.log(`[probe] mode: ${WITH_SESSION ? "with-session" : "no-session"}`);

  cdp.close();
  app.kill();

  const failed = !card || /analysis failed|unavailable|start a session/i.test(card) || (!card && /error/i.test(toast));
  console.log(failed ? `[probe] RED: analyse screen did not work (toast=${JSON.stringify(toast)} card=${JSON.stringify(card.slice(0, 60))})` : `[probe] GREEN: ${toast}`);
  process.exit(failed ? 1 : 0);
} catch (error) {
  app.kill();
  console.error("[probe] harness error:", error.message);
  process.exit(2);
}
