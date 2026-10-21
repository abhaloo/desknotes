/**
 * Shared hardening for the optional HTTP providers (answerer, vision; ASR in
 * phase 2). Each provider call carries a bearer key plus call content, so:
 *
 * - the endpoint must pass `checkProviderUrl` (https, or loopback http);
 * - redirects are never followed: a 30x to another origin (or a downgrade to
 *   http) would replay the bearer key and the payload somewhere unvetted;
 * - errors are rebuilt with the key redacted, so a runtime that echoes the
 *   request into its error text cannot leak it into logs or the wire;
 * - response bodies are read with a byte cap, so a hostile or broken provider
 *   cannot balloon server memory.
 */
import { checkProviderUrl, redactSecrets, sameOrigin } from "../../security/url-policy.js";

export { checkProviderUrl };

/** Non-streaming JSON bodies (chat completion, vision) are small. */
export const MAX_PROVIDER_JSON_BYTES = 1024 * 1024;

/**
 * A provider-specific key wins. Otherwise the shared LLM key is only reused
 * when the provider inherits the LLM base URL or sits on the same origin:
 * pointing ASR_BASE_URL at another vendor must not ship the LLM key there.
 * @param {{explicitKey?: string, baseUrl?: string, fallback?: {baseUrl?: string, apiKey?: string}}} options
 */
export function scopedApiKey({ explicitKey, baseUrl, fallback = {} } = {}) {
  if (explicitKey) return explicitKey;
  if (!baseUrl) return fallback.apiKey;
  return sameOrigin(baseUrl, fallback.baseUrl) ? fallback.apiKey : undefined;
}

/**
 * `fetch` with redirects disabled and a key-free error surface.
 * @param {string} url
 * @param {RequestInit} init
 * @param {{apiKey?: string, fetchImpl?: Function}} [options]
 */
export async function providerFetch(url, init, { apiKey, fetchImpl = globalThis.fetch } = {}) {
  try {
    return await fetchImpl(url, { ...init, redirect: "error" });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // Rebuild instead of mutating: the original may carry the key in its
    // message, stack or `cause`.
    throw new Error(`provider request failed: ${redactSecrets(String(error?.message ?? error), [apiKey])}`);
  }
}

/**
 * A provider HTTP failure that keeps the status, so callers can tell a
 * transient 5xx (worth retrying) from a refusal (402 out of credit, 401 bad
 * key, 403 paywalled model) that another attempt cannot fix. A provider that
 * sends `x-should-retry: false` is obeyed over the status class: Cerebras
 * answers a billing-gated key with 402 and that header.
 * @param {string} label
 * @param {Response} response
 */
export function httpStatusError(label, response) {
  const status = Number(response?.status) || 0;
  const hint = String(response?.headers?.get?.("x-should-retry") ?? "").toLowerCase();
  const error = new Error(`${label} HTTP ${status}`);
  error.status = status;
  error.retryable = hint === "false" ? false : status === 429 || status >= 500;
  return error;
}

/**
 * Read a JSON body with a byte cap. Throws on overflow or invalid JSON.
 * @param {Response} response
 * @param {number} [maxBytes]
 */
export async function readJsonCapped(response, maxBytes = MAX_PROVIDER_JSON_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("provider response too large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("provider response too large");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("provider response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
