import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOW_OPACITY, clampWindowOpacity } from "../src/desktop/window-opacity.js";
import { COMMAND_CHANNELS, IPC } from "../src/desktop/ipc-gateway.js";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "desktop");
const read = (relative) => readFileSync(join(desktop, relative), "utf8");

test("the opacity range keeps every window findable: 30% to 100%, default opaque", () => {
  assert.deepEqual({ ...WINDOW_OPACITY }, { min: 0.3, max: 1, default: 1 });
  assert.equal(clampWindowOpacity(0.55), 0.55);
  assert.equal(clampWindowOpacity(0), 0.3);
  assert.equal(clampWindowOpacity(-3), 0.3);
  assert.equal(clampWindowOpacity(1.5), 1);
  assert.equal(clampWindowOpacity(0.333333), 0.33);
  for (const bad of [undefined, null, "0.5", Number.NaN, Number.POSITIVE_INFINITY, {}]) assert.equal(clampWindowOpacity(bad), 1, String(bad));
});

test("window:setOpacity is a command channel in the gateway and the preload", () => {
  assert.equal(IPC.WINDOW_SET_OPACITY, "window:setOpacity");
  assert.ok(COMMAND_CHANNELS.includes(IPC.WINDOW_SET_OPACITY));
  const preload = read("preload.cjs");
  assert.match(preload, /WINDOW_SET_OPACITY: "window:setOpacity"/);
  assert.match(preload, /IPC\.WINDOW_SET_OPACITY,/);
});

test("index.html: a labelled, no-drag range slider right after the Multi-answer checkbox", () => {
  const html = read("renderer/index.html");
  const titlebar = /<header class="titlebar[^"]*">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
  const multi = titlebar.indexOf('id="toggle-multi-answer"');
  const slider = titlebar.indexOf('id="window-opacity"');
  assert.ok(multi > 0 && slider > multi, "the slider sits in the title row, after Multi-answer");
  assert.ok(slider < titlebar.indexOf('id="btn-settings"'), "and before the Settings button");
  const tag = /<input id="window-opacity"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(tag, /type="range"/);
  assert.match(tag, /min="30"/);
  assert.match(tag, /max="100"/);
  assert.match(tag, /aria-label="Window opacity"/);
  assert.match(tag, /class="no-drag"/);
  assert.doesNotMatch(tag, /\stitle=|aria-live/);
  assert.match(html, /<label class="opacity-control no-drag">/);
  // Not control-only: the overlay's title row carries it too.
  assert.doesNotMatch(/<label class="opacity-control[^"]*"/.exec(html)?.[0] ?? "", /control-only/);
  const css = read("renderer/styles.css");
  assert.match(/\.opacity-control \{[^}]*\}/.exec(css)?.[0] ?? "", /-webkit-app-region: no-drag/);
  assert.match(/\.opacity-control input\[type="range"\] \{[^}]*\}/.exec(css)?.[0] ?? "", /-webkit-app-region: no-drag/);
});

test("app.js: live while dragging, saved on release, synced from window state", () => {
  const app = read("renderer/app.js");
  assert.match(app, /addEventListener\("input", \(\) => void sendWindowOpacity\(false\)\)/);
  assert.match(app, /addEventListener\("change", \(\) => void sendWindowOpacity\(true\)\)/);
  assert.match(app, /CH\.WINDOW_SET_OPACITY, \{ opacity: Number\(slider\.value\) \/ 100, persist \}/);
  assert.match(app, /renderWindowOpacity\(status\.windowOpacity\)/, "every window follows WINDOW_STATE_CHANGED");
  assert.match(app, /bridge\.request\(CH\.WINDOW_GET_STATE\)/, "the starting value comes from main");
});

test("main.mjs: opacity reaches every window through the presenter", () => {
  const main = read("main.mjs").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
  assert.equal((main.match(/\.setOpacity\(/g) ?? []).length, 0, "main never sets a window's opacity itself");
  assert.match(main, /getOpacity: \(\) => currentWindowOpacity\(\)/, "the presenter reads the user's value on every call");
  assert.match(main, /state\.presenter\?\.applyOpacity\(win\)/, "live updates go through the presenter's applyOpacity");
  assert.match(main, /\[state\.windows\.main, state\.windows\.overlay, \.\.\.state\.windows\.panels\]\) state\.presenter\?\.applyOpacity/);
  const presenter = read("window-presenter.js");
  assert.match(presenter, /win\.setOpacity\(getOpacity\(\)\)/, "the presenter sets the current opacity on the window");
});
