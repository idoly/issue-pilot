import { applicationConfig } from "../config.ts";
import { errorDiagnostic } from "../diagnostics.ts";
import { startApi } from "./api.ts";

try {
  await startApi({ webRoot: applicationConfig.webRoot });
} catch (error) {
  // Startup failures may embed SQL parameters; log the sanitized diagnostic and exit non-zero.
  const diagnostic = errorDiagnostic(error);
  console.error(diagnostic instanceof Error ? diagnostic.message : String(diagnostic));
  process.exitCode = 1;
}
