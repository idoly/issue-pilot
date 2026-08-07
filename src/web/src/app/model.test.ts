import { describe, expect, it } from "vitest";

import { workspaceUrl } from "./model";

const issueFolder = "/home/coder/state/workspaces/issue-20260807-004";
const codeServer = `http://127.0.0.1:18080/?folder=${encodeURIComponent(issueFolder)}`;

describe("code-server URLs", () => {
  it("keeps the issue folder when opening the workspace", () => {
    const url = new URL(workspaceUrl(codeServer)!);
    expect(url.pathname).toBe("/code-server/");
    expect(url.searchParams.get("folder")).toBe(issueFolder);
  });
});
