/**
 * Button handlers for the opt-in WASAPI probe page.
 *
 * Load only binds clicks. Catalog and qualification start inside the click
 * handler, so opening the page does not record the microphone.
 */

export function createProbeController({ startCatalog, startQualification } = {}) {
  let started = false;
  return {
    get started() {
      return started;
    },
    start(kind) {
      if (kind !== "catalog" && kind !== "qualification") {
        throw new Error(`Unknown probe case: ${kind}`);
      }
      started = true;
      if (kind === "catalog") return startCatalog?.();
      return startQualification?.();
    },
  };
}

export function bindProbe(document, controller) {
  document.getElementById("start-catalog").addEventListener("click", () => controller.start("catalog"));
  document.getElementById("start-qualification").addEventListener("click", () => controller.start("qualification"));
  return controller;
}

function report(kind) {
  const status = globalThis.document?.getElementById("probe-status");
  if (!status) return;
  status.textContent = kind === "catalog"
    ? "Catalog requested. Device listing does not start recording."
    : "Qualification requested. Recording starts only after this click.";
}

const page = globalThis.document;
if (page?.getElementById?.("start-catalog") && page.getElementById("start-qualification")) {
  bindProbe(page, createProbeController({
    startCatalog: () => report("catalog"),
    startQualification: () => report("qualification"),
  }));
}
