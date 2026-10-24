import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds the running OpenSuperWhisper app through its agent registry (`app.pid`, `app.executable`).
 * Returns the app executable, or nothing when the files are missing or malformed, the pid is
 * dead, or the executable is missing or not runnable.
 */
export function locateApp(agentsDir: string): string | undefined {
  try {
    const pid = readFileSync(join(agentsDir, "app.pid"), "utf8").trim();
    if (!/^[1-9]\d*$/.test(pid) || !isAlive(Number(pid))) return undefined;
    const executable = readFileSync(join(agentsDir, "app.executable"), "utf8").trim();
    if (!statSync(executable).isFile()) return undefined;
    accessSync(executable, constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
