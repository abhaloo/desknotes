import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FORBIDDEN_SENDER,
  capturePermissionPolicy,
  forbiddenDebugSwitches,
  guardIpcHandler,
  hardenWebContents,
  isAllowedPage,
  isTrustedRendererUrl,
  isTrustedSender,
  lockDownSession,
} from "../src/desktop/web-hardening.js";

const rendererDir = join(process.cwd(), "src", "desktop", "renderer");
const indexPath = join(rendererDir, "index.html");
const capturePath = join(process.cwd(), "src", "desktop", "capture", "capture.html");
const indexUrl = pathToFileURL(indexPath).href;
const captureUrl = pathToFileURL(capturePath).href;

function fakeContents() {
  const handlers = {};
  return {
    handlers,
    windowOpen: null,
    on(event, fn) {
      handlers[event] = fn;
    },
    setWindowOpenHandler(fn) {
      this.windowOpen = fn;
    },
  };
}

function navEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function fakeSession() {
  const calls = {};
  return {
    calls,
    setPermissionRequestHandler(fn) {
      calls.request = fn;
    },
    setPermissionCheckHandler(fn) {
      calls.check = fn;
    },
    webRequest: {
      onBeforeRequest(fn) {
        calls.before = fn;
      },
    },
  };
}

test("only the app's own index.html (any query) is a trusted renderer URL", () => {
  assert.equal(isTrustedRendererUrl(`${indexUrl}?mode=overlay`, rendererDir), true);
  assert.equal(isTrustedRendererUrl(indexUrl, rendererDir), true);
  assert.equal(isTrustedRendererUrl("https://evil.example.com/", rendererDir), false);
  assert.equal(isTrustedRendererUrl(pathToFileURL(join(rendererDir, "app.js")).href, rendererDir), false);
  assert.equal(isTrustedRendererUrl(pathToFileURL(join(rendererDir, "..", "evil.html")).href, rendererDir), false);
  assert.equal(isTrustedRendererUrl("file:///C:/Windows/Temp/index.html", rendererDir), false);
  assert.equal(isTrustedRendererUrl("data:text/html,hi", rendererDir), false);
  assert.equal(isTrustedRendererUrl(captureUrl, rendererDir), false, "the capture page is not an IPC peer");
  assert.equal(isTrustedRendererUrl(undefined, rendererDir), false);
});

test("isAllowedPage matches exact file paths only", () => {
  assert.equal(isAllowedPage(`${captureUrl}?x=1`, [capturePath]), true);
  assert.equal(isAllowedPage(indexUrl, [capturePath]), false);
  assert.equal(isAllowedPage("https://evil.example.com/", [indexPath, capturePath]), false);
  assert.equal(isAllowedPage("file://evil-host/share/index.html", [indexPath]), false, "UNC/remote file hosts refused");
});

test("navigation, redirects, webviews and popups away from the window's own page are blocked", () => {
  const contents = fakeContents();
  hardenWebContents(contents, { pages: [indexPath] });

  const evil = navEvent();
  contents.handlers["will-navigate"](evil, "https://evil.example.com/");
  assert.equal(evil.prevented, true);

  const self = navEvent();
  contents.handlers["will-navigate"](self, `${indexUrl}?mode=control`);
  assert.equal(self.prevented, false, "reloading the app's own page stays allowed");

  const sideways = navEvent();
  contents.handlers["will-navigate"](sideways, captureUrl);
  assert.equal(sideways.prevented, true, "an app window may not become the capture page");

  const redirect = navEvent();
  contents.handlers["will-redirect"](redirect, "https://evil.example.com/");
  assert.equal(redirect.prevented, true);

  const frame = navEvent();
  contents.handlers["will-frame-navigate"]({ ...frame, url: "https://evil.example.com/", preventDefault: frame.preventDefault.bind(frame) });
  assert.equal(frame.prevented, true, "subframe navigation is pinned too");

  const webview = navEvent();
  contents.handlers["will-attach-webview"](webview, {}, {});
  assert.equal(webview.prevented, true);

  assert.deepEqual(contents.windowOpen({ url: "https://evil.example.com/" }), { action: "deny" });
  assert.deepEqual(contents.windowOpen({ url: indexUrl }), { action: "deny" });
});

test("the default session denies every permission and every non-local request", () => {
  const session = fakeSession();
  lockDownSession(session);
  let granted = null;
  session.calls.request({}, "media", (ok) => (granted = ok));
  assert.equal(granted, false);
  assert.equal(session.calls.check({}, "clipboard-read"), false);

  const decide = (url) => {
    let out = null;
    session.calls.before({ url }, (verdict) => (out = verdict));
    return out;
  };
  assert.deepEqual(decide(indexUrl), { cancel: false });
  assert.deepEqual(decide("devtools://devtools/bundled/x.html"), { cancel: false });
  assert.deepEqual(decide("data:image/png;base64,AAAA"), { cancel: false });
  assert.deepEqual(decide("https://evil.example.com/beacon?t=transcript"), { cancel: true });
  assert.deepEqual(decide("ws://127.0.0.1:8787"), { cancel: true });
  assert.deepEqual(decide("not a url"), { cancel: true });
});

test("the capture partition grants screen capture to the capture page only", () => {
  const session = fakeSession();
  lockDownSession(session, { allowPermission: capturePermissionPolicy([capturePath]) });
  const ask = (permission, url) => {
    let out = null;
    session.calls.request({ getURL: () => url }, permission, (ok) => (out = ok), { requestingUrl: url });
    return out;
  };
  assert.equal(ask("media", captureUrl), true);
  assert.equal(ask("display-capture", captureUrl), true);
  assert.equal(ask("media", indexUrl), false, "another page in this partition gets nothing");
  assert.equal(ask("notifications", captureUrl), false);
  assert.equal(ask("clipboard-read", captureUrl), false);
  assert.equal(session.calls.check({ getURL: () => captureUrl }, "media", captureUrl, {}), true);
  assert.equal(session.calls.check({ getURL: () => indexUrl }, "media", indexUrl, {}), false);
});

test("IPC from a frame other than the app's top-level page is refused", async () => {
  const top = { url: `${indexUrl}?mode=overlay`, parent: null };
  assert.equal(isTrustedSender({ senderFrame: top }, rendererDir), true);
  assert.equal(isTrustedSender({ senderFrame: { url: "https://evil.example.com/", parent: null } }, rendererDir), false);
  assert.equal(isTrustedSender({ senderFrame: { url: indexUrl, parent: top } }, rendererDir), false, "subframes are untrusted");
  assert.equal(isTrustedSender({ senderFrame: null }, rendererDir), false);
  assert.equal(isTrustedSender({}, rendererDir), false);

  let ran = 0;
  const guarded = guardIpcHandler(async (_event, payload) => ((ran += 1), { ok: true, value: payload }), { rendererDir });
  assert.deepEqual(await guarded({ senderFrame: top }, 7), { ok: true, value: 7 });
  const refused = await guarded({ senderFrame: { url: "https://evil.example.com/", parent: null } }, 7);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, FORBIDDEN_SENDER);
  assert.equal(ran, 1);
});

test("a channel may widen trust to a named second page, and only that page", async () => {
  const practiceUrl = pathToFileURL(join(rendererDir, "practice.html")).href;
  const both = ["index.html", "practice.html"];
  // Default: the practice page is not an IPC peer.
  assert.equal(isTrustedRendererUrl(practiceUrl, rendererDir), false);
  assert.equal(isTrustedSender({ senderFrame: { url: practiceUrl, parent: null } }, rendererDir), false);
  // Widened: practice.html and index.html, nothing else, top-level only.
  assert.equal(isTrustedRendererUrl(practiceUrl, rendererDir, both), true);
  assert.equal(isTrustedRendererUrl(indexUrl, rendererDir, both), true);
  assert.equal(isTrustedRendererUrl(captureUrl, rendererDir, both), false);
  assert.equal(isTrustedRendererUrl(pathToFileURL(join(rendererDir, "..", "practice.html")).href, rendererDir, both), false);
  const top = { url: practiceUrl, parent: null };
  assert.equal(isTrustedSender({ senderFrame: { url: practiceUrl, parent: top } }, rendererDir, both), false, "subframes are untrusted");

  let ran = 0;
  const handler = async () => ((ran += 1), { ok: true, value: null });
  const narrow = guardIpcHandler(handler, { rendererDir });
  const wide = guardIpcHandler(handler, { rendererDir, trustedPages: both });
  assert.equal((await narrow({ senderFrame: top })).error.code, FORBIDDEN_SENDER);
  assert.deepEqual(await wide({ senderFrame: top }), { ok: true, value: null });
  assert.equal(ran, 1);
});

test("debug and sandbox-weakening switches are detected on argv or the command line", () => {
  const none = forbiddenDebugSwitches({ argv: ["app.exe", "--user-data-dir=x"], hasSwitch: () => false });
  assert.deepEqual(none, []);
  assert.deepEqual(forbiddenDebugSwitches({ argv: ["app.exe", "--remote-debugging-port=9222"], hasSwitch: () => false }), [
    "remote-debugging-port",
  ]);
  assert.deepEqual(forbiddenDebugSwitches({ argv: ["app.exe", "--REMOTE-DEBUGGING-PIPE"], hasSwitch: () => false }), [
    "remote-debugging-pipe",
  ]);
  for (const sw of ["inspect", "inspect-brk", "inspect-port", "js-flags", "no-sandbox", "disable-web-security", "remote-allow-origins"]) {
    assert.deepEqual(forbiddenDebugSwitches({ argv: [`--${sw}=1`] }), [sw], sw);
    assert.deepEqual(forbiddenDebugSwitches({ argv: [], hasSwitch: (name) => name === sw }), [sw], `${sw} via hasSwitch`);
  }
  // Values that merely mention a switch are not switches.
  assert.deepEqual(forbiddenDebugSwitches({ argv: ["--user-data-dir=--remote-debugging-port"] }), []);
});

test("every page ships a CSP that also closes base-uri, form-action, frames and plugins", async () => {
  const { readFileSync } = await import("node:fs");
  for (const page of [indexPath, capturePath, join(rendererDir, "practice.html")]) {
    const html = readFileSync(page, "utf8");
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html.replace(/\s*\n\s*/g, " "))?.[1] ?? "";
    for (const directive of ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"]) {
      assert.ok(csp.includes(directive), `${page}: ${directive}`);
    }
    assert.ok(!/unsafe-(inline|eval)/.test(csp), `${page}: no unsafe-inline/eval`);
  }
});
