import { applicationConfig } from "../config.ts";
import { startApi } from "./api.ts";

await startApi({
  webRoot: applicationConfig.webRoot,
  listenHost: applicationConfig.runtime.application.listenHost,
});
