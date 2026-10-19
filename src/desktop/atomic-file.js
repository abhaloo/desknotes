/**
 * Crash-safe replace for main-owned settings files: write a temporary
 * sibling, then rename it over the target. Windows can refuse a rename onto
 * an existing file (EPERM/EEXIST); that case moves the old file aside first
 * and restores it if the second rename fails.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function atomicReplace(io, destination, body) {
  const directory = path.dirname(destination);
  await io.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomBytes(8).toString("hex")}.tmp`);
  await io.writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
  try {
    await moveIntoPlace(io, temporary, destination);
  } catch (error) {
    await io.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function moveIntoPlace(io, temporary, destination) {
  try {
    await io.rename(temporary, destination);
    return;
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
  }
  const backup = `${destination}.${randomBytes(4).toString("hex")}.bak`;
  await io.rename(destination, backup);
  try {
    await io.rename(temporary, destination);
  } catch (error) {
    await io.rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await io.unlink(backup).catch(() => undefined);
}
