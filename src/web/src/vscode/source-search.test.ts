import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./extension-api", () => ({ getIssuePilotVscodeApi: vi.fn() }));
vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return { ...actual, searchSource: vi.fn() };
});

import { searchSource } from "../data/client";
import { SourceSearchProvider } from "./source-search";

const issueKey = "ISSUE-20260815-001";
const repositories = [
  { name: "web", url: "https://example.test/web.git", branch: "main", access: "read" as const },
  { name: "api", url: "https://example.test/api.git", branch: "main", access: "read" as const },
];
class Range {
  constructor(readonly startLine: number, readonly startColumn: number, readonly endLine: number, readonly endColumn: number) {}
}
const vscode = {
  Range,
  TextSearchCompleteMessageType: { Warning: 2 },
  Uri: { file: (path: string) => ({ path, toString: () => `file://${path}` }) },
};
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};
const query = { pattern: "agreementNo", isRegExp: false, isCaseSensitive: false, isWordMatch: true };
const options = (folder: string) => ({ folder: { path: folder }, maxResults: 10 });

describe("VS Code Source API text search extension", () => {
  beforeEach(() => vi.mocked(searchSource).mockReset());

  it("reports budgeted literal matches with source and preview ranges", async () => {
    vi.mocked(searchSource)
      .mockResolvedValueOnce({
        matches: [
          { path: "src/form.ts", line: 4, column: 10, preview: "const agreementNo = value" },
          { path: "src/form.ts", line: 8, column: 5, preview: "agreementNo: input" },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        matches: [
          { path: "src/Query.java", line: 12, column: 3, preview: "String agreementNo;" },
          { path: "docs/ignored.md", line: 1, column: 1, preview: "agreementNo" },
        ],
        truncated: true,
      });
    const progress: Array<{ uri: { path: string }; ranges: Range; preview: { matches: Range } }> = [];
    const provider = new SourceSearchProvider(issueKey, repositories, vscode as never);
    const web = await provider.provideTextSearchResults(query, options(`/issue-pilot/${issueKey}/web`) as never, { report: (item) => progress.push(item as never) }, token as never);
    const api = await provider.provideTextSearchResults(query, options(`/issue-pilot/${issueKey}/api/src`) as never, { report: (item) => progress.push(item as never) }, token as never);

    expect(searchSource).toHaveBeenNthCalledWith(1, issueKey, "web", "agreementNo", { caseSensitive: false, wordMatch: true }, expect.any(AbortSignal));
    expect(searchSource).toHaveBeenNthCalledWith(2, issueKey, "api", "agreementNo", { caseSensitive: false, wordMatch: true }, expect.any(AbortSignal));
    expect(progress.map((match) => match.uri.path)).toEqual([
      `/issue-pilot/${issueKey}/web/src/form.ts`,
      `/issue-pilot/${issueKey}/web/src/form.ts`,
      `/issue-pilot/${issueKey}/api/src/Query.java`,
    ]);
    expect(progress[0]).toEqual(expect.objectContaining({
      ranges: new Range(3, 9, 3, 20),
      preview: expect.objectContaining({ matches: new Range(0, 6, 0, 17) }),
    }));
    expect(web.limitHit).toBe(false);
    expect(api.limitHit).toBe(true);
  });

  it("rejects regular expressions without issuing a Source API request", async () => {
    const result = await new SourceSearchProvider(issueKey, repositories, vscode as never).provideTextSearchResults(
      { ...query, pattern: ".*", isRegExp: true },
      options(`/issue-pilot/${issueKey}/web`) as never,
      { report() {} },
      token as never,
    );

    expect(searchSource).not.toHaveBeenCalled();
    expect(result).toEqual({ limitHit: false, message: expect.objectContaining({ text: "Issue Pilot代码搜索只支持纯文本" }) });
  });
});
