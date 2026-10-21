/**
 * What the overlay says when an answer does not arrive.
 *
 * The server sends `error` frames the user never sees otherwise: the turn
 * closes with no text, so a silent failure reads as "the app ignored me". The
 * frame carries the provider's own words ("answerer: chat endpoint HTTP 402"),
 * which say nothing to a rep mid-call, so each known refusal becomes one short
 * sentence naming what to do about it. An unknown failure keeps its message:
 * a mystery string is still better than silence.
 *
 * Session-dead codes (`session_ended`, `session_not_found`) are skipped here:
 * the realtime client already latched the session, and its own state line is
 * the message that matters.
 */

const SILENT_CODES = Object.freeze(["session_ended", "session_not_found"]);

/** First match wins: a status is more specific than the text around it. */
const HINTS = Object.freeze([
  {
    // answerer.js noAnswerModelError: live mode has no demo answers to fall back on.
    pattern: /no answer model is set up/i,
    text: "No answer model is set up. Add a DeepSeek or Cerebras key in Settings > Edit keys…, then restart the app.",
  },
  {
    pattern: /\b402\b|payment_required|payment required/i,
    text: "The answer model is out of credit. Check its billing, or pick another answer model in Settings.",
  },
  {
    pattern: /\b403\b|forbidden|paywall/i,
    text: "The answer model refuses this account. Pick another answer model in Settings.",
  },
  {
    pattern: /\b401\b|unauthorized|invalid api key|incorrect api key/i,
    text: "The answer model rejected the API key. Check the key for this answer model.",
  },
  {
    pattern: /\b429\b|rate.?limit|too many requests|quota/i,
    text: "The answer model is rate-limited right now. Wait a moment, then speak again.",
  },
  {
    pattern: /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|provider request failed/i,
    text: "No connection to the answer model. Check the network, then speak again.",
  },
]);

const FALLBACK_TEXT = "No answer came back from the answer model. Speak again to retry.";

/**
 * One short line for the toast, or "" when the frame needs no message.
 * @param {{code?: string, message?: string}} [data] the `error` frame's data
 */
export function answerErrorText(data = {}) {
  const code = String(data?.code ?? "");
  if (SILENT_CODES.includes(code)) return "";
  const message = String(data?.message ?? "");
  const hint = HINTS.find((entry) => entry.pattern.test(message));
  return hint ? hint.text : FALLBACK_TEXT;
}

/** Shown while the server retries a failed generation itself. */
export const ANSWER_RETRY_TEXT = "The answer model faltered. Retrying now.";
