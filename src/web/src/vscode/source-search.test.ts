import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/uri", () => ({
  URI: {
    file: (path: string) => ({ path, toString: () => `file://${path}` }),
  },
}));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors", () => ({ SyncDescriptor: class {} }));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search", () => {
  class FileMatch {
    readonly results: unknown[] = [];
    constructor(readonly resource: unknown) {}
  }
  class OneLineRange {
    constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endColumn: number) {}
  }
  class TextSearchMatch {
    constructor(readonly preview: string, readonly range: OneLineRange, readonly previewOptions: unknown) {}
  }
  return {
    FileMatch,
    OneLineRange,
    TextSearchMatch,
    SearchCompletionExitCode: { Normal: 0 },
    SearchProviderType: { file: 0, text: 1 },
    TextSearchCompleteMessageType: { Warning: 2 },
  };
});
vi.mock("@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service", () => ({ ISearchService: { toString: () => "search" } }));
vi.mock("@codingame/monaco-vscode-search-service-override", () => ({ default: () => ({}) }));
vi.mock("@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService", () => ({ SearchService: class {} }));
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

function query(overrides: Record<string, unknown> = {}) {
  return {
    contentPattern: { pattern: "agreementNo", isRegExp: false, isCaseSensitive: false, isWordMatch: true },
    folderQueries: [
      { folder: { path: `/issue-pilot/${issueKey}/web` } },
      { folder: { path: `/issue-pilot/${issueKey}/api/src` } },
    ],
    previewOptions: { matchLines: 1, charsPerLine: 120 },
    maxResults: 10,
    ...overrides,
  } as never;
}

describe("VS Code Source API search provider", () => {
  beforeEach(() => vi.mocked(searchSource).mockReset());

  it("reports budgeted literal matches per file and preserves repository roots", async () => {
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
    const progress: Array<{ resource: { path: string }; results: unknown[] }> = [];
    const result = await new SourceSearchProvider(issueKey, repositories).textSearch(query(), (item) => progress.push(item as never));

    expect(searchSource).toHaveBeenNthCalledWith(1, issueKey, "web", "agreementNo", { caseSensitive: false, wordMatch: true }, expect.any(AbortSignal));
    expect(searchSource).toHaveBeenNthCalledWith(2, issueKey, "api", "agreementNo", { caseSensitive: false, wordMatch: true }, expect.any(AbortSignal));
    expect(progress.map((file) => [file.resource.path, file.results.length])).toEqual([
      [`/issue-pilot/${issueKey}/web/src/form.ts`, 2],
      [`/issue-pilot/${issueKey}/api/src/Query.java`, 1],
    ]);
    expect(result.results).toHaveLength(2);
    expect(result.limitHit).toBe(true);
  });

  it("rejects regular expressions without issuing a Source API request", async () => {
    const result = await new SourceSearchProvider(issueKey, repositories).textSearch(query({
      contentPattern: { pattern: ".*", isRegExp: true, isCaseSensitive: true, isWordMatch: false },
    }));

    expect(searchSource).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.messages).toEqual([expect.objectContaining({ text: "Issue Pilot代码搜索只支持纯文本" })]);
  });
});
