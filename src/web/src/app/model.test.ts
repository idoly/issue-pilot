import { describe, expect, it } from "vitest";

import { folderUrl, workspaceUrl } from "./model";

const issueFolder = "/home/coder/state/workspaces/issue-20260807-004";
const repositoryFolder = `${issueFolder}/repository-id`;
const codeServer = `http://127.0.0.1:18080/?folder=${encodeURIComponent(issueFolder)}`;

describe("code-server URLs", () => {
  it("keeps the issue folder when opening the workspace", () => {
    const url = new URL(workspaceUrl(codeServer)!);
    expect(url.pathname).toBe("/code-server/");
    expect(url.searchParams.get("folder")).toBe(issueFolder);
  });

  it("targets the selected repository folder", () => {
    const url = new URL(folderUrl(codeServer, repositoryFolder)!);
    expect(url.pathname).toBe("/code-server/");
    expect(url.searchParams.get("folder")).toBe(repositoryFolder);
  });
});
