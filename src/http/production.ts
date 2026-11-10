import { lstat, mkdir, realpath } from "node:fs/promises";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { applicationConfig } from "../config.ts";
import { errorDiagnostic } from "../diagnostics.ts";

async function enableLocalCompileCache(): Promise<void> {
  if (process.env.NODE_DISABLE_COMPILE_CACHE === "1" || getCompileCacheDir()) return;
  const xdg = process.env.XDG_CACHE_HOME;
  const directory = join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "issue-pilot", "node-compile-cache");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && (await realpath(directory)) === directory) enableCompileCache(directory);
  } catch {
    // Compiled modules are disposable. A missing or unusable cache must not block startup.
  }
}

try {
  await enableLocalCompileCache();
  const { startApi } = await import("./api.ts");
  await startApi({ webRoot: applicationConfig.webRoot });
} catch (error) {
  // Startup failures may embed SQL parameters; log the sanitized diagnostic and exit non-zero.
  const diagnostic = errorDiagnostic(error);
  console.error(diagnostic instanceof Error ? diagnostic.message : String(diagnostic));
  process.exitCode = 1;
}
