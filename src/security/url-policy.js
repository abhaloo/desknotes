/**
 * Endpoint policy for every outbound connection that carries a credential or
 * call content (provider API keys, the realtime JWT, transcripts, audio,
 * screenshots).
 *
 * WHY: a plaintext hop to a remote host hands the bearer key and the live
 * call to anyone on the path. Loopback is exempt because the embedded server
 * and local test doubles never leave the machine. Credentials embedded in a
 * URL are refused because URLs end up in logs, error messages and the
 * renderer's status surfaces.
 *
 * Pure and dual-runtime (Bun server, Electron main): WHATWG `URL` only.
 */

/** @param {unknown} hostname */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return false;
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "::1") return true;
  // 127.0.0.0/8, dotted-quad only (no "127.evil.com" style tricks).
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

function parse(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function check(raw, { secure, plain }) {
  const url = parse(raw);
  if (!url) return { ok: false, reason: "invalid_url" };
  if (url.protocol !== secure && url.protocol !== plain) return { ok: false, reason: "unsupported_scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (url.protocol === plain && !isLoopbackHost(url.hostname)) return { ok: false, reason: "insecure_scheme" };
  url.hash = "";
  return { ok: true, url: url.href.replace(/\/+$/, "") };
}

/**
 * Provider (LLM / STT / vision) base URL: https, or http to loopback.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function checkProviderUrl(raw) {
  return check(raw, { secure: "https:", plain: "http:" });
}

/**
 * Realtime socket URL: wss, or ws to loopback.
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function checkRealtimeUrl(raw) {
  return check(raw, { secure: "wss:", plain: "ws:" });
}

/** Same scheme + host + port. Unparseable input is never "same". */
export function sameOrigin(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y || x.origin === "null" || y.origin === "null") return false;
  return x.origin === y.origin;
}

const MIN_SECRET_LENGTH = 6;

/**
 * Strip secrets out of text bound for logs or error messages. Values shorter
 * than MIN_SECRET_LENGTH are ignored: they are not real keys, and redacting
 * them would mangle ordinary words.
 */
export function redactSecrets(text, secrets = []) {
  let out = typeof text === "string" ? text : text == null ? "" : String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
