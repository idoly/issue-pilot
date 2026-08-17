import { beforeEach, describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => {
  class ProviderError extends Error {
    static create(message: string, code: string) { return new ProviderError(message, code); }
    constructor(message: string, readonly code: string) { super(message); }
  }
  return {
    FilePermission: { Readonly: 1 },
    FileSystemProviderCapabilities: { FileReadWrite: 2, PathCaseSensitive: 4, Readonly: 8 },
    FileSystemProviderError: ProviderError,
    FileSystemProviderErrorCode: {
      FileNotFound: "EntryNotFound",
      FileNotADirectory: "EntryNotADirectory",
      FileIsADirectory: "EntryIsADirectory",
      FileTooLarge: "EntryTooLarge",
      FileWriteLocked: "EntryWriteLocked",
      Unavailable: "Unavailable",
      Unknown: "Unknown",
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  };
});

vi.mock("@codingame/monaco-vscode-files-service-override", () => vscode);
vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return { ...actual, loadSourceTree: vi.fn(), loadSourceFile: vi.fn(), saveSourceFile: vi.fn() };
});

import { loadSourceFile, loadSourceTree, saveSourceFile } from "../data/client";
import { SourceFileSystemProvider } from "./source-file-system";

const issueKey = "ISSUE-20260815-001";
const repository = { name: "orders", url: "https://git.example.test/orders.git", branch: "main", access: "read" as const };
const uri = (path: string) => ({ path }) as never;

function provider() {
  return new SourceFileSystemProvider(issueKey, [repository]);
}

describe("VS Code source filesystem", () => {
  beforeEach(() => {
    vi.mocked(loadSourceTree).mockReset();
    vi.mocked(loadSourceFile).mockReset();
    vi.mocked(saveSourceFile).mockReset();
  });

  it("projects Source API trees and files into a readonly VS Code workspace", async () => {
    vi.mocked(loadSourceTree).mockResolvedValue({
      path: "",
      entries: [
        { name: "src", path: "src", type: "directory", size: null },
        { name: "README.md", path: "README.md", type: "file", size: 8 },
      ],
      truncated: false,
    });
    vi.mocked(loadSourceFile).mockResolvedValue({ path: "README.md", content: "# Orders", size: 8, sha256: "a".repeat(64) });
    const filesystem = provider();

    expect(filesystem.capabilities & vscode.FileSystemProviderCapabilities.Readonly).not.toBe(0);
    await expect(filesystem.readdir(uri(`/issue-pilot/${issueKey}`))).resolves.toEqual([["orders", vscode.FileType.Directory]]);
    await expect(filesystem.readdir(uri(`/issue-pilot/${issueKey}/orders`))).resolves.toEqual([
      ["src", vscode.FileType.Directory],
      ["README.md", vscode.FileType.File],
    ]);
    await expect(filesystem.stat(uri(`/issue-pilot/${issueKey}/orders/README.md`))).resolves.toEqual({
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 8,
      permissions: vscode.FilePermission.Readonly,
    });
    await expect(filesystem.readFile(uri(`/issue-pilot/${issueKey}/orders/README.md`))).resolves.toEqual(new TextEncoder().encode("# Orders"));
    expect(loadSourceTree).toHaveBeenCalledWith(issueKey, "orders", "");
    expect(loadSourceFile).toHaveBeenCalledWith(issueKey, "orders", "README.md");
  });

  it("saves existing files in development repositories and refreshes source control", async () => {
    const writable = new SourceFileSystemProvider(issueKey, [{ ...repository, access: "write" }]);
    const resource = uri(`/issue-pilot/${issueKey}/orders/README.md`);
    vi.mocked(loadSourceTree).mockResolvedValue({ path: "", entries: [{ name: "README.md", path: "README.md", type: "file", size: 8 }], truncated: false });
    vi.mocked(loadSourceFile).mockResolvedValue({ path: "README.md", content: "# Orders", size: 8, sha256: "a".repeat(64) });
    vi.mocked(saveSourceFile).mockResolvedValue({ path: "README.md", content: "# Updated", size: 9, sha256: "b".repeat(64) });
    const onWrite = vi.fn();
    writable.setOnWrite(onWrite);

    expect(writable.capabilities & vscode.FileSystemProviderCapabilities.Readonly).toBe(0);
    await expect(writable.stat(uri(`/issue-pilot/${issueKey}/orders`))).resolves.toEqual({ type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 });
    await writable.readFile(resource);
    await writable.writeFile(resource, new TextEncoder().encode("# Updated"), { create: false, overwrite: true, unlock: false, atomic: false });

    expect(saveSourceFile).toHaveBeenCalledWith(issueKey, "orders", "README.md", "# Updated", "a".repeat(64));
    expect(onWrite).toHaveBeenCalledOnce();
  });

  it("does not issue a file request when the parent tree proves the file is absent", async () => {
    vi.mocked(loadSourceTree).mockResolvedValue({ path: "", entries: [], truncated: false });
    const filesystem = provider();

    await expect(filesystem.readFile(uri(`/issue-pilot/${issueKey}/orders/missing.ts`))).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.FileNotFound });
    expect(loadSourceFile).not.toHaveBeenCalled();
  });

  it("fails closed on truncated trees and every filesystem mutation", async () => {
    vi.mocked(loadSourceTree).mockResolvedValue({ path: "", entries: [], truncated: true });
    const filesystem = provider();
    const root = uri(`/issue-pilot/${issueKey}/orders`);

    await expect(filesystem.readdir(root)).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.Unavailable });
    await expect(filesystem.writeFile(uri(`/issue-pilot/${issueKey}/orders/new.ts`), new Uint8Array(), { create: true, overwrite: false, unlock: false, atomic: false })).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.FileWriteLocked });
    await expect(filesystem.mkdir(uri(`/issue-pilot/${issueKey}/orders/new`))).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.FileWriteLocked });
    await expect(filesystem.delete(root, { recursive: true, useTrash: false, atomic: false })).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.FileWriteLocked });
    await expect(filesystem.rename(root, uri(`/issue-pilot/${issueKey}/orders-renamed`), { overwrite: false })).rejects.toMatchObject({ code: vscode.FileSystemProviderErrorCode.FileWriteLocked });
  });
});
