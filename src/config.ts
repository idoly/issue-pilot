import path from "node:path";
import { fileURLToPath } from "node:url";

import { issuePilotConfig } from "../issue-pilot.config.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const stateRoot = path.resolve(projectRoot, issuePilotConfig.state.directory);

export const applicationConfig = Object.freeze({
  ...issuePilotConfig,
  stateRoot,
  databaseFile: path.resolve(stateRoot, issuePilotConfig.state.databaseFile),
});
