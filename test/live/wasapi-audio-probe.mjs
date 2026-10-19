/**
 * Opt-in Electron entry for the WASAPI probe.
 *
 * `npm run test:audio:live -- --case catalog|qualification` opens the page.
 * `--app dist/win-unpacked/DeskNotes.exe` launches that packaged executable
 * with no test preload. Neither path records on process start.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_CASES = Object.freeze(["catalog", "qualification"]);

export function parseProbeArgs(argv) {
  const args = { caseName: "catalog", app: null, diagnostics: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--case") {
      args.caseName = requiredValue(argv, index, "--case");
      index += 1;
    } else if (token === "--app") {
      args.app = requiredValue(argv, index, "--app");
      index += 1;
    } else if (token === "--diagnostics") {
      args.diagnostics = requiredValue(argv, index, "--diagnostics");
      index += 1;
    }
  }
  if (!PROBE_CASES.includes(args.caseName)) {
    throw new Error(`Unknown probe case: ${args.caseName}`);
  }
  return args;
}

export function packagedAppSteps(appPath) {
  return [
    `Launch ${appPath} normally. Do not inject a preload and do not run the executable as Node.`,
    "Open the control window. The app does not start the microphone until you press Start.",
    "Case catalog: open the device selectors and read the input and output names and endpoint IDs. Listing does not start recording.",
    "Case qualification: select output A, press Start, and play the known A signal only through A. Confirm system capture contains A and not B.",
    "Select output B, press Start, and play the known B signal only through B. Confirm system capture contains B and not A.",
    "Select output A explicitly. Change the Windows default playback device to B. Confirm capture stays on A.",
    "Export diagnostics from the app and pass that file with --diagnostics. This probe does not start the microphone by itself.",
  ];
}

export function isDirectProbe(argv = process.argv, moduleUrl = import.meta.url) {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

async function main() {
  const args = parseProbeArgs(process.argv);
  if (args.diagnostics) await scoreDiagnostics(args.diagnostics);
  if (args.app) {
    await launchPackagedApp(args.app);
    return;
  }
  if (!process.versions.electron) {
    process.stderr.write("Run this probe with Electron, or pass --app dist/win-unpacked/DeskNotes.exe.\n");
    process.exitCode = 1;
    return;
  }
  const { app, BrowserWindow } = await import("electron");
  const htmlPath = fileURLToPath(new URL("./wasapi-audio-probe.html", import.meta.url));
  await app.whenReady();
  const window = new BrowserWindow({
    width: 480,
    height: 640,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await window.loadFile(htmlPath, { query: { case: args.caseName } });
}

async function scoreDiagnostics(filePath) {
  const { qualifyEvidence } = await import("./audio-evidence.js");
  const raw = await readFile(filePath, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) {
    throw new Error("Diagnostics file is too large to score.");
  }
  const result = qualifyEvidence(JSON.parse(raw));
  process.stdout.write(`${JSON.stringify({
    qualified: result.qualified,
    failures: result.failures,
    headphones: result.headphones,
    speakers: result.speakers,
  }, null, 2)}\n`);
}

async function launchPackagedApp(appPath) {
  const { access } = await import("node:fs/promises");
  for (const step of packagedAppSteps(appPath)) process.stdout.write(`${step}\n`);
  try {
    await access(appPath);
  } catch {
    process.stderr.write(`Packaged app not found: ${appPath}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(appPath, [], { stdio: "inherit", windowsHide: false });
  await new Promise((resolve) => {
    child.once("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

if (isDirectProbe()) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
