import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MAX_AGENT_MESSAGE_CHARS } from "../domain/contracts.ts";
import { registerIssuePilotExtension, type IssuePilotExtensionOptions } from "./extension.ts";

export default function issuePilotRpcExtension(pi: ExtensionAPI): void {
  const configFile = process.env.ISSUE_PILOT_RUNTIME_CONFIG;
  if (!configFile) throw new Error("issue_pilot_runtime_config_not_found");
  const options = JSON.parse(readFileSync(configFile, "utf8")) as IssuePilotExtensionOptions;
  registerIssuePilotExtension(pi, options);
  pi.registerCommand("issue-user", {
    handler: async (encoded) => {
      const message = Buffer.from(encoded.trim(), "base64url").toString("utf8");
      if (!message.trim() || message.length > MAX_AGENT_MESSAGE_CHARS) throw new Error("invalid_issue_user_message");
      pi.appendEntry("issue-pilot-user", { message });
    },
  });
}
