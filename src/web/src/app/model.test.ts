import { describe, expect, it } from "vitest";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { workspaceUrl } from "./model";

const runtimeWorkspace = "/home/coder/state/issues/issue-20260807-004/runtime/issue-20260807-004.code-workspace";
const codeServer = new URL(issuePilotConfig.runtime.codeServer.publicUrl);
codeServer.searchParams.set("workspace", runtimeWorkspace);

describe("code-server URLs", () => {
  it("keeps the Issue multi-root runtime manifest when proxying code-server", () => {
    const url = new URL(workspaceUrl(codeServer.toString())!);
    expect(url.pathname).toBe("/code-server/");
    expect(url.searchParams.get("workspace")).toBe(runtimeWorkspace);
  });
});
