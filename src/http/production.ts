import { applicationConfig } from "../config.ts";
import { UnavailableContainerRuntime } from "../container-runtime.ts";
import { startApi } from "./api.ts";

const runtimeArguments = process.argv.slice(2);
if (runtimeArguments.length > 1 || (runtimeArguments[0] && runtimeArguments[0] !== "--container-runtime=unavailable")) throw new Error("invalid_container_runtime_argument");
const containerRuntime = runtimeArguments[0] ? new UnavailableContainerRuntime() : undefined;
await startApi({
  webRoot: applicationConfig.webRoot,
  listenHost: applicationConfig.runtime.application.listenHost,
  ...(containerRuntime ? { containerRuntime } : {}),
});
