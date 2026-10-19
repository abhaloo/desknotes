/**
 * Renderer containment for the desktop shell (Electron security checklist:
 * limit navigation, deny new windows and webviews, deny permissions, validate
 * IPC senders, refuse debug switches in shipped builds).
 *
 * WHY: the preload exposes the session/capture commands to whatever page the
 * window shows. If injected content or a bug ever navigates a window (or
 * opens a popup or a subframe), that page would inherit the bridge and could
 * start capture or read transcripts. Pinning every window to its own page,
 * and refusing IPC from any other frame, closes that path even if the CSP is
 * later loosened.
 *
 * PURE: no `electron` import (unit-testable under bun). main.mjs passes in
 * the real webContents/session objects.
 */
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "./ipc-error-codes.js";

export const FORBIDDEN_SENDER = ErrorCode.FORBIDDEN_SENDER;

function samePath(a, b) {
  const x = normalize(resolve(a));
  const y = normalize(resolve(b));
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function filePathOf(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Local files only: file://host/... is a UNC/remote share.
  if (parsed.protocol !== "file:" || parsed.host !== "") return null;
  try {
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

/** True when `url` is file://<one of pages> (query string allowed). */
export function isAllowedPage(url, pages = []) {
  const path = filePathOf(url);
  return path !== null && pages.some((page) => samePath(path, page));
}

/** The renderer page every IPC channel trusts unless a channel widens it. */
export const DEFAULT_TRUSTED_PAGES = Object.freeze(["index.html"]);

/**
 * True only for file://<rendererDir>/<one of trustedPages> (query string
 * allowed). The default is the app's own index.html; a channel that a second
 * static page needs (the practice window's practice:* calls) names it
 * explicitly, so that page never gains the rest of the bridge.
 */
export function isTrustedRendererUrl(url, rendererDir, trustedPages = DEFAULT_TRUSTED_PAGES) {
  return isAllowedPage(url, trustedPages.map((name) => resolve(rendererDir, name)));
}

/** IPC sender check: one of the trusted pages, top-level frame only. */
export function isTrustedSender(event, rendererDir, trustedPages = DEFAULT_TRUSTED_PAGES) {
  const frame = event?.senderFrame;
  if (!frame || frame.parent) return false;
  return isTrustedRendererUrl(frame.url, rendererDir, trustedPages);
}

/**
 * Wrap an `ipcMain.handle` listener. Refusals use the gateway's envelope
 * shape so the preload rejects them like any other coded failure.
 * `trustedPages` (file names in `rendererDir`) defaults to index.html only.
 */
export function guardIpcHandler(handler, { rendererDir, trustedPages = DEFAULT_TRUSTED_PAGES, log } = {}) {
  return async (event, payload) => {
    if (!isTrustedSender(event, rendererDir, trustedPages)) {
      log?.({ type: "ipc.forbidden_sender" });
      return { ok: false, error: { code: FORBIDDEN_SENDER, message: "IPC sender is not the app renderer" } };
    }
    return handler(event, payload);
  };
}

/**
 * Attach to every webContents (app "web-contents-created"). `pages` is the
 * set of files this contents may show: the app windows get index.html (the
 * default session also allows practice.html, and the practice window narrows
 * itself to practice.html alone), the hidden capture window gets capture.html,
 * nothing gets anything else. Listeners stack: a second call on the same
 * contents can only narrow what the first allows.
 */
export function hardenWebContents(contents, { pages = [], log } = {}) {
  const pin = (event, url) => {
    if (isAllowedPage(url, pages)) return;
    event.preventDefault();
    log?.({ type: "navigation.blocked" });
  };
  contents.on("will-navigate", pin);
  contents.on("will-redirect", pin);
  // Electron >= 25: one event per frame navigation, main frame included.
  contents.on("will-frame-navigate", (details) => pin(details, details?.url));
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log?.({ type: "webview.blocked" });
  });
  // No app page ever needs a second browsing context.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Permission policy for the hidden capture partition: its own page may use
 * screen capture (getDisplayMedia), nothing else, and no other page may.
 */
export function capturePermissionPolicy(capturePages) {
  const allowed = new Set(["media", "display-capture"]);
  return (permission, url) => allowed.has(permission) && isAllowedPage(url, capturePages);
}

const LOCAL_SCHEMES = new Set(["file:", "data:", "blob:", "devtools:", "chrome-devtools:"]);

/**
 * Deny every permission unless `allowPermission(permission, url)` says
 * otherwise (the renderer captures nothing itself: audio and screen capture
 * run in main or in the capture partition), and cancel any non-local
 * request, so a page that slips past the CSP still cannot beacon out.
 */
export function lockDownSession(session, { allowPermission = () => false } = {}) {
  const urlOf = (contents, fallback) => {
    try {
      return contents?.getURL?.() || fallback || "";
    } catch {
      return fallback || "";
    }
  };
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(allowPermission(permission, details?.requestingUrl || urlOf(contents))));
  });
  // `requestingOrigin` for file:// is just "file:///"; the page URL is what identifies it.
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    Boolean(allowPermission(permission, urlOf(contents, requestingOrigin))),
  );
  session.webRequest?.onBeforeRequest((details, callback) => {
    let scheme = "";
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      /* unparseable: cancel */
    }
    callback({ cancel: !LOCAL_SCHEMES.has(scheme) });
  });
}

/**
 * Chromium/Node switches that open a debugger or weaken isolation. Fuses
 * cover Node's --inspect and NODE_OPTIONS, but not Chromium's remote
 * debugging (CDP on loopback, reachable by every local user) or --no-sandbox.
 */
export const FORBIDDEN_SWITCHES = Object.freeze([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-allow-origins",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "js-flags",
  "no-sandbox",
  "disable-web-security",
]);

/** @returns {string[]} the forbidden switches present on argv or the Chromium command line */
export function forbiddenDebugSwitches({ argv = [], hasSwitch = () => false } = {}) {
  const onArgv = new Set();
  for (const arg of argv) {
    const match = /^--([a-z0-9-]+)(?:=|$)/i.exec(String(arg));
    if (match) onArgv.add(match[1].toLowerCase());
  }
  return FORBIDDEN_SWITCHES.filter((name) => {
    if (onArgv.has(name)) return true;
    try {
      return Boolean(hasSwitch(name));
    } catch {
      return false;
    }
  });
}
