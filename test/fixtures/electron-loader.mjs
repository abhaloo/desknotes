/** Module resolve hook: `import ... from "electron"` -> the fake shell surface. */
const FAKE = new URL("./fake-electron.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: FAKE, shortCircuit: true };
  return nextResolve(specifier, context);
}
