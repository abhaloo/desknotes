/**
 * Terms: explain the
 * jargon in a finished answer card.
 *
 * After the pipeline has sent a card's `turn.done`, it asks here for up to
 * three terms that appear in that card: the term, its full name when it is an
 * acronym, and what it is and does. One request per card, on its own promise:
 * nothing on the answer path waits for it, and a new turn aborts it.
 *
 * The model is DeepSeek V4.1 Flash with thinking off (answer-models.js), JSON
 * reply. Code checks every entry and fails closed: the term must appear in the
 * card, a known or already explained term is dropped, a full name that does
 * not spell the acronym (`acronymMatches`) is removed, and an explanation with
 * markup or over the word cap drops the entry. Any error, timeout or bad JSON
 * gives no entries and one error code; `explain` never rejects.
 *
 * Each validated entry is kept for the session (one glossary per session), so
 * a term reads the same every time and is never sent for explanation again.
 * The rep's known terms (known-terms.txt) are read again for every request.
 *
 * Transport: the same hardening as the other providers (provider-http.js):
 * https or loopback only, no redirects, key-free errors, capped body.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEEPSEEK, providerRequestExtras } from "./answer-models.js";
import { checkProviderUrl, providerFetch, readJsonCapped } from "./provider-http.js";
import { stripHighlights } from "../../shared/highlights.js";
import { prompt, shippedPrompt } from "./prompts.js";

/** app-preferences.json field and settings:get/set key. */
export const GLOSSARY_SETTING = "glossary";

/** Env spelling of the setting for a standalone server: 0/false/off turns it off. */
export const GLOSSARY_ENV = "GLOSSARY";

/** The rep's known terms, one per line, beside app-preferences.json. */
export const KNOWN_TERMS_FILENAME = "known-terms.txt";

/**
 * terms: entries under one card; whatWords: the explanation's word cap
 * (longer ones keep whole sentences that fit); dropWords: past this the entry
 * is dropped.
 */
export const GLOSSARY_LIMITS = Object.freeze({ terms: 3, whatWords: 25, dropWords: 35 });

export const DEFAULT_GLOSSARY_TIMEOUT_MS = 5000;
const MAX_GLOSSARY_JSON_BYTES = 64 * 1024;
/** Three short entries need about 200 tokens; thinking is off, so none go to reasoning. */
const MAX_REPLY_TOKENS = 600;
const MAX_TERM_CHARS = 60;
const MAX_FULL_NAME_CHARS = 120;
const MAX_KNOWN_TERMS = 2000;
const MAX_KNOWN_TERMS_CHARS = 64 * 1024;
const MAX_CACHED_TERMS = 500;
/**
 * Bounds on the acronym check (model text): an acronym of at most 10 letters
 * after digit expansion, a full name of at most 12 words and
 * MAX_FULL_NAME_CHARS characters. Past a bound the full name is not shown.
 */
const MAX_ACRONYM_LETTERS = 10;
const MAX_FULL_NAME_WORDS = 12;

export const GLOSSARY_PROMPT = shippedPrompt("terms/system");

/** Small words an acronym may skip ("Total Cost of Ownership" is TCO) or use ("Internet of Things" is IoT). */
const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** Markdown or HTML in model text: such an entry is not plain text. */
const MARKUP = /<\/?[a-z][^>]*>|&(?:[a-z]+|#\d+);|[`*]|\[[^\]]*\]\([^)]*\)|^(?:#|>|[-+]\s|\d+\.\s)/i;

export const DISABLED_GLOSSARY = Object.freeze({
  enabled: false,
  explain: async () => ({ terms: [], added: 0, latencyMs: 0, error: "disabled" }),
  close() {},
});

/**
 * The GLOSSARY switch: 0/false/off -> false, 1/true/on or unset -> true,
 * anything else -> null (the caller keeps the default and says so).
 */
export function parseGlossarySwitch(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
}

/* ------------------------------------------------------------- checks ---- */

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * Where `term` first appears in `text` on a word boundary, or -1. An all-caps
 * acronym ("MQTT", "S3") must match case for case; any other term matches in
 * any case.
 */
export function termIndex(term, text) {
  const needle = typeof term === "string" ? term.trim() : "";
  if (!needle) return -1;
  const allCaps = /\p{Lu}/u.test(needle) && !/\p{Ll}/u.test(needle);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, allCaps ? "u" : "iu");
  const match = pattern.exec(typeof text === "string" ? text : "");
  return match ? match.index : -1;
}

export function termInText(term, text) {
  return termIndex(term, text) >= 0;
}

/**
 * The letters an acronym spells, lowercase; several when a digit is
 * ambiguous; null when `term` is not an acronym (it needs two capitals, or a
 * capital and a digit). A plural ("APIs") is spelled without its "s". A digit
 * after a letter repeats it (S3, EC2, W3C), and a 2 may also read "to" (P2P).
 */
function acronymSpellings(term) {
  let raw = String(term ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
  if (/^[\p{Lu}\p{N}]{2,}s$/u.test(raw)) raw = raw.slice(0, -1);
  const capitals = (raw.match(/\p{Lu}/gu) ?? []).length;
  const digits = (raw.match(/\p{N}/gu) ?? []).length;
  if (capitals < 1 || capitals + digits < 2 || raw.length > MAX_ACRONYM_LETTERS) return null;
  let spellings = [""];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\p{L}/u.test(ch)) {
      spellings = spellings.map((spelling) => spelling + ch.toLowerCase());
      continue;
    }
    const count = Number(ch);
    const previous = raw[i - 1];
    if (!previous || !/\p{L}/u.test(previous) || !(count >= 2)) return null;
    const repeat = previous.toLowerCase().repeat(count - 1);
    spellings = spellings.flatMap((spelling) => (count === 2 ? [spelling + repeat, `${spelling}t`] : [spelling + repeat]));
  }
  return spellings[0].length > MAX_ACRONYM_LETTERS ? null : spellings;
}

/**
 * Does `letters` spell `words` (each its letters and digits, lowercase)? Every
 * word that is not a minor word gives its first letter as the next acronym
 * letter (a minor word may be skipped), and may then give further letters
 * from anywhere later inside it, in order ("Hypertext" gives h, t; "Database"
 * d, b). Within a word the earliest match of a letter is always the best one,
 * so the search is memoized on (letter, word, position in the word) and its
 * cost is polynomial in the bounded input: model text can never stall the
 * event loop the answers stream on.
 */
function spells(letters, words) {
  const memo = new Map();
  // at < 0: word `w` not started; otherwise its initial is taken and its
  // letters before `at` are passed.
  const visit = (i, w, at) => {
    const key = (i * (words.length + 1) + w) * (MAX_FULL_NAME_CHARS + 2) + at + 1;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let found = false;
    if (at < 0) {
      if (w === words.length) found = i === letters.length;
      else {
        const word = words[w];
        found = (word.minor && visit(i, w + 1, -1)) || (i < letters.length && letters[i] === word.text[0] && visit(i + 1, w, 1));
      }
    } else {
      found = visit(i, w + 1, -1);
      const next = i < letters.length ? words[w].text.indexOf(letters[i], at) : -1;
      if (!found && next >= 0) found = visit(i + 1, w, next + 1);
    }
    memo.set(key, found);
    return found;
  };
  return visit(0, 0, -1);
}

/**
 * True when `fullName` is a possible expansion of the acronym `term`, by the
 * standard acronym rule: the full name splits into words on whitespace and
 * "/" only (a hyphenated word such as "Time-Series" is one word), and the
 * acronym's letters are, in order, each content word's initial plus any
 * letters taken later from inside that word (see `spells`). A full name that
 * only repeats the term is not one, and one past a bound
 * (MAX_ACRONYM_LETTERS, MAX_FULL_NAME_WORDS, MAX_FULL_NAME_CHARS) is refused
 * unchecked.
 */
export function acronymMatches(term, fullName) {
  const spellings = acronymSpellings(term);
  if (!spellings) return false;
  const name = String(fullName ?? "");
  if (name.length > MAX_FULL_NAME_CHARS) return false;
  const words = name
    .split(/[\s/]+/u)
    .map((part) => part.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase())
    .filter(Boolean)
    .map((text) => ({ text, minor: MINOR_WORDS.has(text) }));
  if (words.length === 0 || words.length > MAX_FULL_NAME_WORDS) return false;
  if (words.map((word) => word.text).join("") === String(term).replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase()) return false;
  return spellings.some((letters) => spells(letters, words));
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The explanation as shown, or null to drop the entry: plain text only, at
 * most GLOSSARY_LIMITS.whatWords words. A longer one keeps the whole
 * sentences that fit, and a first sentence that does not fit stays whole
 * (nothing is cut mid-sentence); past GLOSSARY_LIMITS.dropWords it is dropped.
 */
export function cleanWhat(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || MARKUP.test(text)) return null;
  const count = wordCount(text);
  if (count <= GLOSSARY_LIMITS.whatWords) return text;
  if (count > GLOSSARY_LIMITS.dropWords) return null;
  const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u);
  let kept = "";
  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (wordCount(next) > GLOSSARY_LIMITS.whatWords) break;
    kept = next;
  }
  return kept || sentences[0];
}

function cleanTerm(value) {
  if (typeof value !== "string") return null;
  const term = value.replace(/\s+/g, " ").trim();
  if (!term || term.length > MAX_TERM_CHARS || /[<>`*]/.test(term)) return null;
  return term;
}

function cleanFullName(value, term) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || /^(?:null|none|n\/a)$/i.test(name) || name.length > MAX_FULL_NAME_CHARS || MARKUP.test(name)) return null;
  return acronymMatches(term, name) ? name : null;
}

/**
 * The model's entries that pass every check, at most GLOSSARY_LIMITS.terms,
 * in the model's order: `{term, full_name: string|null, what}`. `known` and
 * `explained` terms are dropped (case-insensitive), as is a repeat.
 */
export function validateEntries(raw, { text = "", known = [], explained = [] } = {}) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const taken = new Set([...known, ...explained].map((term) => String(term).toLowerCase()));
  for (const item of raw) {
    if (out.length >= GLOSSARY_LIMITS.terms) break;
    if (!item || typeof item !== "object") continue;
    const term = cleanTerm(item.term);
    if (!term || taken.has(term.toLowerCase()) || !termInText(term, text)) continue;
    const what = cleanWhat(item.what);
    if (!what) continue;
    taken.add(term.toLowerCase());
    out.push({ term, full_name: cleanFullName(item.full_name ?? item.fullName, term), what });
  }
  return out;
}

/** The wire shape: `full_name` only when there is one. */
function wireEntry(entry) {
  return entry.full_name ? { term: entry.term, full_name: entry.full_name, what: entry.what } : { term: entry.term, what: entry.what };
}

/**
 * The block for one card: the new entries, then cached entries whose term is
 * in the card, each group in order of first appearance in the card, at most
 * GLOSSARY_LIMITS.terms.
 */
export function composeTerms({ fresh = [], cache = [], text = "" } = {}) {
  const inCard = (entries) =>
    [...entries]
      .map((entry) => ({ entry, at: termIndex(entry.term, text) }))
      .filter(({ at }) => at >= 0)
      .sort((a, b) => a.at - b.at)
      .map(({ entry }) => entry);
  const out = [];
  const seen = new Set();
  for (const entry of [...inCard(fresh), ...inCard(cache)]) {
    const key = entry.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wireEntry(entry));
    if (out.length >= GLOSSARY_LIMITS.terms) break;
  }
  return out;
}

/* -------------------------------------------------------- known terms ---- */

/** One term per line; blank lines and lines starting with `#` are skipped. */
export function parseKnownTerms(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const seen = new Set();
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const term = line.trim();
    if (!term || term.startsWith("#") || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
    if (out.length >= MAX_KNOWN_TERMS) break;
  }
  return out;
}

/** The file now; missing or unreadable reads as no known terms. */
export async function readKnownTerms(filePath, { readFileImpl = readFile } = {}) {
  if (typeof filePath !== "string" || !filePath) return [];
  try {
    return parseKnownTerms(String(await readFileImpl(filePath, "utf8")).slice(0, MAX_KNOWN_TERMS_CHARS));
  } catch {
    return [];
  }
}

/** Create the file empty when it is missing; an existing file is never touched. */
export async function ensureKnownTermsFile(filePath, { writeFileImpl = writeFile, mkdirImpl = mkdir } = {}) {
  try {
    await mkdirImpl(dirname(filePath), { recursive: true });
    await writeFileImpl(filePath, "", { flag: "wx" });
    return { created: true, error: null };
  } catch (error) {
    if (error?.code === "EEXIST") return { created: false, error: null };
    return { created: false, error: String(error?.code ?? error?.message ?? error) };
  }
}

/* ---------------------------------------------------------- transport ---- */

/** The chat body: the fixed prompt, the terms to skip, then the card. */
export function buildGlossaryRequest({ baseUrl, model, text, skip = [] } = {}) {
  const skipList = skip.length > 0 ? skip.map((term) => `- ${term}`).join("\n") : "(none)";
  return {
    ...providerRequestExtras(baseUrl),
    model,
    temperature: 0,
    max_tokens: MAX_REPLY_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompt("terms/system") },
      { role: "user", content: prompt("terms/user", { skip: skipList, card: text }) },
    ],
  };
}

/** The reply's `terms` array (the JSON object may sit inside a fence), or null. */
export function parseGlossaryReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(parsed?.terms) ? parsed.terms : null;
  } catch {
    return null;
  }
}

/**
 * @param {{apiKey?: string, baseUrl?: string, model?: string, timeoutMs?: number,
 *   knownTermsPath?: string|null, fetchImpl?: Function, readFileImpl?: Function,
 *   log?: Function, now?: Function}} [options]
 * @returns {{enabled: boolean, explain: (args: {text: string, signal?: AbortSignal}) =>
 *   Promise<{terms: object[], added: number, latencyMs: number, error: string|null}>, close: () => void}}
 *   Without a key, or on a refused URL, the glossary is off (DISABLED_GLOSSARY).
 */
export function createGlossary({
  apiKey,
  baseUrl = DEEPSEEK.baseUrl,
  model = DEEPSEEK.models.flash,
  timeoutMs = DEFAULT_GLOSSARY_TIMEOUT_MS,
  knownTermsPath = null,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  log,
  now = Date.now,
} = {}) {
  const logger = typeof log === "function" ? log : () => {};
  if (!apiKey) return DISABLED_GLOSSARY;
  const endpoint = checkProviderUrl(baseUrl);
  if (!endpoint.ok) {
    logger({ type: "glossary.provider_insecure_url", reason: endpoint.reason });
    return DISABLED_GLOSSARY;
  }
  const url = `${String(endpoint.url).replace(/\/+$/, "")}/chat/completions`;
  const cache = new Map(); // lowercase term -> entry, oldest first
  const inflight = new Set(); // AbortControllers
  let closed = false;

  function remember(entry) {
    cache.set(entry.term.toLowerCase(), entry);
    while (cache.size > MAX_CACHED_TERMS) cache.delete(cache.keys().next().value);
  }

  async function explain({ text, signal } = {}) {
    const started = now();
    const result = (terms, error, added = 0) => ({ terms, added, latencyMs: now() - started, error });
    if (closed) return result([], "closed");
    const card = stripHighlights(text).trim();
    if (!card) return result([], "empty");
    const controller = new AbortController();
    inflight.add(controller);
    let timedOut = false;
    // Not unref'd, like the judge's: short-lived and always cleared.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    const stopped = () => (closed ? "closed" : timedOut ? "timeout" : "aborted");
    try {
      const known = knownTermsPath ? await readKnownTerms(knownTermsPath, { readFileImpl }) : [];
      if (controller.signal.aborted) return result([], stopped());
      const explained = [...cache.values()].map((entry) => entry.term);
      // Only the skip terms this card mentions: the rest cannot be picked anyway.
      const lower = card.toLowerCase();
      const skip = [...new Map([...known, ...explained].map((term) => [term.toLowerCase(), term])).values()].filter((term) =>
        lower.includes(term.toLowerCase()),
      );
      const response = await providerFetch(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(buildGlossaryRequest({ baseUrl: endpoint.url, model, text: card, skip })),
          signal: controller.signal,
        },
        { apiKey, fetchImpl },
      );
      if (!response.ok) return result([], `http_${response.status}`);
      const raw = parseGlossaryReply(await readJsonCapped(response, MAX_GLOSSARY_JSON_BYTES));
      if (!raw) return result([], "bad_json");
      const fresh = validateEntries(raw, { text: card, known, explained });
      for (const entry of fresh) remember(entry);
      return result(composeTerms({ fresh, cache: cache.values(), text: card }), null, fresh.length);
    } catch (error) {
      // Codes only: a provider message may echo the request.
      if (controller.signal.aborted) return result([], stopped());
      if (error instanceof SyntaxError) return result([], "bad_json");
      return result([], /too large/.test(String(error?.message)) ? "too_large" : "request_failed");
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  function close() {
    closed = true;
    for (const controller of inflight) controller.abort();
    inflight.clear();
    cache.clear();
  }

  return { enabled: true, explain, close };
}
