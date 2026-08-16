import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  commands: new Map<string, () => Promise<void>>(),
  menuItems: [] as unknown[],
  providers: [] as unknown[],
  editor: { openEditor: vi.fn() },
  diff: vi.fn(),
  history: vi.fn(),
  commit: vi.fn(),
  commitFile: vi.fn(),
}));

vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/event", () => {
  class Emitter<T = void> {
    readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(event: T) { for (const listener of this.listeners) listener(event); }
    dispose() { this.listeners.clear(); }
  }
  return { Emitter, Event: { None: () => ({ dispose() {} }) } };
});
vi.mock("@codingame/monaco-vscode-files-service-override", () => {
  class FileSystemProviderError extends Error {
    static create(message: string, code: string) { return Object.assign(new FileSystemProviderError(message), { code }); }
  }
  return {
    FilePermission: { Readonly: 1 },
    FileSystemProviderCapabilities: { FileReadWrite: 2, PathCaseSensitive: 4, Readonly: 8 },
    FileSystemProviderError,
    FileSystemProviderErrorCode: { FileNotFound: "FileNotFound", FileNotADirectory: "FileNotADirectory", FileWriteLocked: "FileWriteLocked", Unknown: "Unknown" },
    FileType: { File: 1 },
  };
});
vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/observableValue", () => ({
  observableValue: (_owner: unknown, value: unknown) => ({ value, get() { return this.value; }, set(next: unknown) { this.value = next; } }),
}));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/resourceTree", () => ({
  ResourceTree: class {
    readonly resources: unknown[] = [];
    clear() { this.resources.length = 0; }
    add(_uri: unknown, resource: unknown) { this.resources.push(resource); }
  },
}));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/themables", () => ({ ThemeIcon: { fromId: (id: string) => ({ id }) } }));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/base/common/uri", () => {
  const uri = (scheme: string, authority: string, path: string, query = "") => ({ scheme, authority, path, query, toString: () => `${scheme}://${authority}${path}${query ? `?${query}` : ""}` });
  return { URI: {
    file: (path: string) => uri("file", "", path),
    from: (parts: { scheme: string; authority?: string; path: string; query?: string }) => uri(parts.scheme, parts.authority ?? "", parts.path, parts.query),
    joinPath: (root: { scheme?: string; authority?: string; path: string }, path: string) => uri(root.scheme ?? "file", root.authority ?? "", `${root.path}/${path}`),
  } };
});
vi.mock("@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions", () => ({
  MenuId: { SCMTitle: "scm-title" },
  MenuRegistry: { appendMenuItem: (_menu: unknown, item: unknown) => harness.menuItems.push(item) },
}));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands", () => ({
  CommandsRegistry: { registerCommand: (id: string, command: () => Promise<void>) => harness.commands.set(id, command) },
}));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service", () => ({ IEditorService: "editor" }));
vi.mock("@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm.service", () => ({ ISCMService: "scm" }));
vi.mock("@codingame/monaco-vscode-api", () => ({
  getService: (service: string) => service === "scm" ? {
    registerSCMProvider(provider: unknown) {
      harness.providers.push(provider);
      return { input: { visible: true } };
    },
  } : harness.editor,
}));
vi.mock("monaco-editor", () => ({
  editor: { createModel: () => ({ dispose: vi.fn() }) },
  Uri: { parse: (value: string) => ({ path: value, toString: () => value }) },
}));
vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return { ...actual, loadSourceDiff: harness.diff, loadSourceHistory: harness.history, loadSourceCommit: harness.commit, loadSourceCommitFile: harness.commitFile };
});

import { registerSourceControls, SourceRevisionFileSystemProvider } from "./source-control";

const issueKey = "ISSUE-20260815-001";
const repositories = [
  { name: "web", url: "https://example.test/web.git", branch: "main", access: "write" as const },
  { name: "api", url: "https://example.test/api.git", branch: "main", access: "write" as const },
];

describe("VS Code readonly Source Control provider", () => {
  beforeEach(() => {
    harness.commands.clear();
    harness.menuItems.length = 0;
    harness.providers.length = 0;
    harness.editor.openEditor.mockReset();
    harness.diff.mockReset();
    harness.history.mockReset();
    harness.commit.mockReset();
    harness.commitFile.mockReset();
  });

  it("projects structured diff resources without exposing mutation commands", async () => {
    harness.history.mockResolvedValue({ commits: [{ hash: "a".repeat(40), shortHash: "a".repeat(8), parents: ["b".repeat(40)], author: "Fixture User", date: "2026-08-15T00:00:00.000Z", subject: "Fix agreement export" }], truncated: false });
    harness.commit.mockResolvedValue({ files: [{ status: "modified", path: "src/form.ts", previousPath: null }], truncated: false });
    harness.commitFile.mockResolvedValue({
      file: { status: "modified", path: "src/form.ts", previousPath: null },
      before: { path: "src/form.ts", revision: "b".repeat(40), content: "before" },
      after: { path: "src/form.ts", revision: "a".repeat(40), content: "after" },
    });
    harness.diff
      .mockResolvedValueOnce({
        files: [
          { status: "modified", path: "src/form.ts", previousPath: null },
          { status: "deleted", path: "src/old.ts", previousPath: null },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({ files: [], truncated: false });

    const revisionContent = new SourceRevisionFileSystemProvider();
    await registerSourceControls(issueKey, repositories, `/issue-pilot/${issueKey}`, revisionContent);

    expect(harness.diff).toHaveBeenNthCalledWith(1, issueKey, "web");
    expect(harness.diff).toHaveBeenNthCalledWith(2, issueKey, "api");
    expect(harness.providers).toHaveLength(2);
    const web = harness.providers[0] as {
      groups: Array<{ resources: Array<{ open(preserveFocus: boolean): Promise<void>; decorations: { tooltip: string } }> }>;
      count: { value: number };
      historyProvider: { get(): { provideHistoryItems(options: { limit: number }): Promise<Array<{ subject: string; displayId: string }>>; provideHistoryItemChanges(id: string): Promise<Array<{ uri: { path: string }; originalUri?: { path: string; toString(): string }; modifiedUri?: { path: string; toString(): string } }>> } };
    };
    expect(web.count.value).toBe(2);
    expect(web.groups[0]!.resources.map((resource) => resource.decorations.tooltip)).toEqual(["修改: src/form.ts", "删除: src/old.ts"]);

    await web.groups[0]!.resources[0]!.open(false);
    expect(harness.editor.openEditor).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ path: `/issue-pilot/${issueKey}/web/src/form.ts` }),
      options: { preserveFocus: false, pinned: true },
    }));
    await web.groups[0]!.resources[1]!.open(false);
    expect(harness.editor.openEditor).toHaveBeenCalledTimes(1);
    const history = await web.historyProvider.get().provideHistoryItems({ limit: 20 });
    expect(history).toEqual([expect.objectContaining({ subject: "Fix agreement export", displayId: "aaaaaaaa" })]);
    expect(harness.history).toHaveBeenCalledWith(issueKey, "web");
    const changes = await web.historyProvider.get().provideHistoryItemChanges("a".repeat(40));
    expect(changes).toEqual([expect.objectContaining({
      uri: expect.objectContaining({ path: `/issue-pilot/${issueKey}/web/src/form.ts` }),
      originalUri: expect.objectContaining({ path: `/${issueKey}/web/src/form.ts` }),
      modifiedUri: expect.objectContaining({ path: `/${issueKey}/web/src/form.ts` }),
    })]);
    expect(harness.commit).toHaveBeenCalledWith(issueKey, "web", "a".repeat(40));
    const content = await revisionContent.readFile(changes[0]!.modifiedUri! as never);
    expect(new TextDecoder().decode(content)).toBe("after");
    await revisionContent.readFile(changes[0]!.modifiedUri! as never);
    expect(harness.commitFile).toHaveBeenCalledTimes(1);
    expect(harness.commitFile).toHaveBeenCalledWith(issueKey, "web", "a".repeat(40), "src/form.ts");
    await expect(revisionContent.writeFile(changes[0]!.modifiedUri! as never, new Uint8Array(), {} as never)).rejects.toThrow("source_read_only");
    await expect(revisionContent.mkdir(changes[0]!.modifiedUri! as never)).rejects.toThrow("source_read_only");
    await expect(revisionContent.delete(changes[0]!.modifiedUri! as never, {} as never)).rejects.toThrow("source_read_only");
    await expect(revisionContent.rename(changes[0]!.modifiedUri! as never, changes[0]!.modifiedUri! as never, {} as never)).rejects.toThrow("source_read_only");
    expect([...harness.commands.keys()]).toEqual(["issue-pilot.sourceControl.refresh"]);
    expect(harness.menuItems).toHaveLength(1);
  });
});
