/**
 * The Settings line that says where each provider key came from.
 *
 * settings:get carries `keySources` = `{ NAME: "keys.env" | "environment" | null }`
 * (src/desktop/keys-file.js): the source of each key the app read at launch,
 * never the key. The rep checks it after editing keys.env and restarting:
 * "DeepSeek: keys.env · Cerebras: environment · Groq: missing · TypeSafe: missing".
 */

/** Settings order, with the name a rep knows each provider by. */
const PROVIDERS = Object.freeze([
  ["DEEPSEEK_API_KEY", "DeepSeek"],
  ["CEREBRAS_API_KEY", "Cerebras"],
  ["GROQ_API_KEY", "Groq"],
  ["TYPESAFE_API_KEY", "TypeSafe"],
]);
const SOURCES = Object.freeze(["keys.env", "environment"]);

/**
 * One line for the Settings note, or "" without `keySources`.
 * @param {Record<string, string | null> | null | undefined} keySources
 */
export function keysStatusText(keySources) {
  if (!keySources || typeof keySources !== "object") return "";
  return PROVIDERS.map(([key, name]) => `${name}: ${SOURCES.includes(keySources[key]) ? keySources[key] : "missing"}`).join(" · ");
}
