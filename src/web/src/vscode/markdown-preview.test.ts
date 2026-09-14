import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerEditor, registerEditorPane, createInstance, commands, executeCommand, markedParse, parseUri } = vi.hoisted(() => ({
  registerEditor: vi.fn(),
  registerEditorPane: vi.fn(),
  createInstance: vi.fn(async (ctor: new (resource: unknown) => unknown, resource: unknown) => new ctor(resource)),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executeCommand: vi.fn(),
  markedParse: vi.fn(async () => "<h1>README</h1>"),
  parseUri: vi.fn((value: string) => ({ value })),
}));

vi.mock("dompurify", () => ({ default: { sanitize: vi.fn((value: string) => value) } }));
vi.mock("marked", () => ({ marked: { parse: markedParse } }));
vi.mock("virtual:issue-pilot-markdown-preview-style", () => ({ previewCss: "" }));
vi.mock("@codingame/monaco-vscode-api", () => ({ createInstance }));
vi.mock("@codingame/monaco-vscode-workbench-service-override", () => {
  class EditorInput {
    resource: unknown;
    constructor(resource: unknown) { this.resource = resource; }
  }
  class SimpleEditorInput extends EditorInput {
    addCapability() {}
    setName() {}
    setDescription() {}
  }
  class SimpleEditorPane {}
  return {
    EditorInput,
    EditorInputCapabilities: { Readonly: 2 },
    registerEditor,
    registerEditorPane,
    RegisteredEditorPriority: { option: "option" },
    SimpleEditorInput,
    SimpleEditorPane,
  };
});
vi.mock("monaco-editor", () => ({
  Uri: {
    isUri: (value: unknown) => typeof value === "object" && value !== null && "monacoUri" in value,
    parse: (value: string) => ({ monacoUri: value, toString: () => value }),
  },
  editor: { getModel: vi.fn() },
}));
vi.mock("./extension-api", () => ({
  getIssuePilotVscodeApi: vi.fn(async () => ({
    commands: {
      executeCommand,
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => commands.set(id, handler),
    },
    Uri: { parse: parseUri },
    ViewColumn: { Beside: -2 },
  })),
}));

import * as monaco from "monaco-editor";
import { registerMarkdownPreview, registerMarkdownPreviewCommands } from "./markdown-preview";

describe("Markdown preview Workbench integration", () => {
  beforeEach(() => {
    registerEditor.mockClear();
    registerEditorPane.mockClear();
    createInstance.mockClear();
    executeCommand.mockReset().mockResolvedValue(undefined);
    markedParse.mockClear();
    parseUri.mockClear();
    commands.clear();
  });

  it("registers the native pane as an optional Markdown editor", async () => {
    registerMarkdownPreview();

    expect(registerEditorPane).toHaveBeenCalledWith(
      "issue-pilot.markdownPreview",
      "Markdown Preview",
      expect.any(Function),
      [expect.any(Function)],
    );
    expect(registerEditor).toHaveBeenCalledWith(
      "*.md",
      expect.objectContaining({ id: "issue-pilot.markdownPreview", priority: { editor: "option", diff: "option", merge: "option" } }),
      { singlePerResource: true },
      expect.objectContaining({ createEditorInput: expect.any(Function) }),
    );

    const factory = registerEditor.mock.calls[0][3] as { createEditorInput(input: { resource: unknown }): Promise<{ editor: { resource: unknown } }> };
    const resource = { path: "/README.md" };
    await expect(factory.createEditorInput({ resource })).resolves.toEqual({ editor: expect.objectContaining({ resource }) });
  });

  it("renders Markdown locally without depending on an extension-host command", async () => {
    registerMarkdownPreview();
    const Pane = registerEditorPane.mock.calls[0][2] as new () => { initialize(): HTMLElement; renderInput(input: { resource: unknown }): Promise<unknown> };
    const pane = new Pane();
    const host = pane.initialize();
    const resource = monaco.Uri.parse("file:///README.md");
    vi.mocked(monaco.editor.getModel).mockReturnValue({ getLanguageId: () => "markdown", getValue: () => "# README" } as never);

    await pane.renderInput({ resource });

    expect(markedParse).toHaveBeenCalledWith("# README");
    expect(host.shadowRoot?.querySelector("article")?.innerHTML).toBe("<h1>README</h1>");
    expect(executeCommand).not.toHaveBeenCalledWith("markdown.api.render", expect.anything());
  });

  it("opens preview commands through the public extension API", async () => {
    await registerMarkdownPreviewCommands(document.createElement("div"));
    const resource = monaco.Uri.parse("file:///issue-pilot/ISSUE-20260815-001/api/README.md");

    await commands.get("markdown.showPreviewToSide")?.(resource);

    expect(parseUri).toHaveBeenCalledWith(resource.toString());
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.openWith",
      { value: resource.toString() },
      "issue-pilot.markdownPreview",
      -2,
    );
  });
});
