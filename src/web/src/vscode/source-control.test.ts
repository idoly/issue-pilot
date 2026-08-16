import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class Uri {
    constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = "") {}
    static file(path: string) { return new Uri("file", "", path); }
    static from(parts: { scheme: string; authority?: string; path: string; query?: string }) { return new Uri(parts.scheme, parts.authority ?? "", parts.path, parts.query); }
    static joinPath(root: Uri, child: string) { return new Uri(root.scheme, root.authority, `${root.path}/${child}`); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ""}`; }
  }
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); };
    fire(event: T) { for (const listener of this.listeners) listener(event); }
    dispose() { this.listeners.clear(); }
  }
  class Disposable {
    constructor(private readonly operation: () => void) {}
    dispose() { this.operation(); }
  }
  class FileSystemError extends Error {
    static FileNotFound(message?: string) { return Object.assign(new FileSystemError(message), { code: "FileNotFound" }); }
    static FileNotADirectory(message?: string) { return Object.assign(new FileSystemError(message), { code: "FileNotADirectory" }); }
    static NoPermissions(message?: string) { return Object.assign(new FileSystemError(message), { code: "NoPermissions" }); }
  }
  class ThemeIcon { constructor(readonly id: string) {} }

  const commands = new Map<string, () => Promise<void>>();
  const controls: Array<{ id: string; label: string; rootUri: Uri; inputBox: { visible: boolean }; count?: number; historyProvider?: unknown; groups: Array<{ id: string; label: string; resourceStates: unknown[]; contextValue?: string; hideWhenEmpty?: boolean }> }> = [];
  const fileSystemProviders: Array<{ scheme: string; provider: unknown; options: unknown }> = [];
  const vscode = {
    Disposable,
    EventEmitter,
    FilePermission: { Readonly: 1 },
    FileSystemError,
    FileType: { File: 1 },
    ThemeIcon,
    Uri,
    commands: { registerCommand: (id: string, command: () => Promise<void>) => { commands.set(id, command); return new Disposable(() => commands.delete(id)); } },
    workspace: {
      registerFileSystemProvider(scheme: string, provider: unknown, options: unknown) {
        fileSystemProviders.push({ scheme, provider, options });
        return new Disposable(() => undefined);
      },
    },
    scm: {
      createSourceControl(id: string, label: string, rootUri: Uri) {
        const sourceControl = {
          id,
          label,
          rootUri,
          inputBox: { visible: true },
          count: undefined as number | undefined,
          historyProvider: undefined as unknown,
          groups: [] as Array<{ id: string; label: string; resourceStates: unknown[]; contextValue?: string; hideWhenEmpty?: boolean }>,
          createResourceGroup(groupId: string, groupLabel: string) {
            const group = { id: groupId, label: groupLabel, resourceStates: [] as unknown[] };
            sourceControl.groups.push(group);
            return group;
          },
        };
        controls.push(sourceControl);
        return sourceControl;
      },
    },
  };
  return { commands, controls, fileSystemProviders, vscode, diff: vi.fn(), history: vi.fn(), commit: vi.fn(), commitFile: vi.fn() };
});

vi.mock("./extension-api", () => ({
  sourceControlRefreshCommand: "issue-pilot.sourceControl.refresh",
  getIssuePilotVscodeApi: async () => harness.vscode,
}));
vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return { ...actual, loadSourceDiff: harness.diff, loadSourceHistory: harness.history, loadSourceCommit: harness.commit, loadSourceCommitFile: harness.commitFile };
});

import { registerSourceControls } from "./source-control";

const issueKey = "ISSUE-20260815-001";
const repositories = [
  { name: "web", url: "https://example.test/web.git", branch: "main", access: "write" as const },
  { name: "api", url: "https://example.test/api.git", branch: "main", access: "write" as const },
];

describe("VS Code readonly Source Control extension", () => {
  beforeEach(() => {
    harness.commands.clear();
    harness.controls.length = 0;
    harness.fileSystemProviders.length = 0;
    harness.diff.mockReset();
    harness.history.mockReset();
    harness.commit.mockReset();
    harness.commitFile.mockReset();
  });

  it("projects diff, history, and revision files through the public vscode API", async () => {
    harness.history.mockResolvedValue({ commits: [{ hash: "a".repeat(40), shortHash: "a".repeat(8), parents: ["b".repeat(40)], author: "Fixture User", date: "2026-08-15T00:00:00.000Z", subject: "Fix agreement export" }], truncated: false });
    harness.commit.mockResolvedValue({ files: [{ status: "modified", path: "src/form.ts", previousPath: null }], truncated: false });
    harness.commitFile.mockResolvedValue({
      file: { status: "modified", path: "src/form.ts", previousPath: null },
      before: { path: "src/form.ts", revision: "b".repeat(40), content: "before" },
      after: { path: "src/form.ts", revision: "a".repeat(40), content: "after" },
    });
    harness.diff
      .mockResolvedValueOnce({ files: [{ status: "modified", path: "src/form.ts", previousPath: null }, { status: "deleted", path: "src/old.ts", previousPath: null }], truncated: false })
      .mockResolvedValueOnce({ files: [], truncated: false });

    await registerSourceControls(issueKey, repositories, `/issue-pilot/${issueKey}`);

    expect(harness.diff).toHaveBeenNthCalledWith(1, issueKey, "web");
    expect(harness.diff).toHaveBeenNthCalledWith(2, issueKey, "api");
    expect(harness.controls).toHaveLength(2);
    const web = harness.controls[0]!;
    expect(web.inputBox.visible).toBe(false);
    expect(web.count).toBe(2);
    const resources = web.groups[0]!.resourceStates as Array<{ resourceUri: { path: string }; command?: { command: string }; decorations: { tooltip: string } }>;
    expect(resources.map((resource) => resource.decorations.tooltip)).toEqual(["修改: src/form.ts", "删除: src/old.ts"]);
    expect(resources[0]).toEqual(expect.objectContaining({ resourceUri: expect.objectContaining({ path: `/issue-pilot/${issueKey}/web/src/form.ts` }), command: expect.objectContaining({ command: "vscode.open" }) }));
    expect(resources[1]!.command).toBeUndefined();

    const historyProvider = web.historyProvider as { provideHistoryItems(options: { limit: number }): Promise<Array<{ subject: string; displayId: string }>>; provideHistoryItemChanges(id: string): Promise<Array<{ uri: { path: string }; originalUri?: { path: string }; modifiedUri?: { path: string; toString(): string } }>> };
    const history = await historyProvider.provideHistoryItems({ limit: 20 });
    expect(history).toEqual([expect.objectContaining({ subject: "Fix agreement export", displayId: "aaaaaaaa" })]);
    const changes = await historyProvider.provideHistoryItemChanges("a".repeat(40));
    expect(changes).toEqual([expect.objectContaining({
      uri: expect.objectContaining({ path: `/issue-pilot/${issueKey}/web/src/form.ts` }),
      originalUri: expect.objectContaining({ path: `/${issueKey}/web/src/form.ts` }),
      modifiedUri: expect.objectContaining({ path: `/${issueKey}/web/src/form.ts` }),
    })]);

    expect(harness.fileSystemProviders).toEqual([expect.objectContaining({ scheme: "issue-pilot-commit", options: { isCaseSensitive: true, isReadonly: true } })]);
    const revisionContent = harness.fileSystemProviders[0]!.provider as { readFile(uri: unknown): Promise<Uint8Array>; writeFile(): never; createDirectory(): never; delete(): never; rename(): never };
    expect(new TextDecoder().decode(await revisionContent.readFile(changes[0]!.modifiedUri!))).toBe("after");
    await revisionContent.readFile(changes[0]!.modifiedUri!);
    expect(harness.commitFile).toHaveBeenCalledTimes(1);
    expect(() => revisionContent.writeFile()).toThrow("source_read_only");
    expect(() => revisionContent.createDirectory()).toThrow("source_read_only");
    expect(() => revisionContent.delete()).toThrow("source_read_only");
    expect(() => revisionContent.rename()).toThrow("source_read_only");
    expect([...harness.commands.keys()]).toEqual(["issue-pilot.sourceControl.refresh"]);
  });
});
