import DOMPurify from "dompurify";
import { createInstance } from "@codingame/monaco-vscode-api";
import { marked } from "marked";
import {
  EditorInput,
  EditorInputCapabilities,
  registerEditor,
  registerEditorPane,
  RegisteredEditorPriority,
  SimpleEditorInput,
  SimpleEditorPane,
} from "@codingame/monaco-vscode-workbench-service-override";
import { previewCss } from "virtual:issue-pilot-markdown-preview-style";
import * as monaco from "monaco-editor";
import { getIssuePilotVscodeApi } from "./extension-api";

const previewPaneId = "issue-pilot.markdownPreview";

function resourceName(resource: monaco.Uri): string {
  const raw = resource.path.slice(resource.path.lastIndexOf("/") + 1);
  try { return decodeURIComponent(raw); } catch { return raw; }
}

class MarkdownPreviewInput extends SimpleEditorInput {
  constructor(resource: monaco.Uri) {
    super(resource);
    this.addCapability(EditorInputCapabilities.Readonly);
    this.setName(`Preview ${resourceName(resource)}`);
    this.setDescription("Markdown Preview");
  }

  get typeId(): string { return previewPaneId; }

  override matches(other: EditorInput): boolean {
    return other instanceof MarkdownPreviewInput && other.resource?.toString() === this.resource?.toString();
  }
}

class MarkdownPreviewPane extends SimpleEditorPane {
  private content!: HTMLElement;

  constructor(group: ConstructorParameters<typeof SimpleEditorPane>[1]) {
    super(previewPaneId, group);
  }

  initialize(): HTMLElement {
    const host = document.createElement("div");
    host.className = "issue-pilot-markdown-preview";
    host.tabIndex = 0;
    host.setAttribute("aria-label", "Markdown Preview");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `${previewCss}\n:host{display:block;box-sizing:border-box;width:100%;min-height:100%;padding:24px 32px;background:#0d1117;color:#e6edf3;color-scheme:dark}.markdown-body{max-width:none;background:transparent;color:#e6edf3}`;
    this.content = document.createElement("article");
    this.content.className = "markdown-body";
    shadow.append(style, this.content);
    return host;
  }

  async renderInput(input: EditorInput): Promise<monaco.IDisposable> {
    const resource = input.resource;
    const model = resource ? monaco.editor.getModel(resource) : null;
    if (!model || model.getLanguageId() !== "markdown") {
      this.content.textContent = "Markdown source unavailable";
      return { dispose() {} };
    }
    const rendered = await marked.parse(model.getValue());
    this.content.innerHTML = DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style", "srcdoc"],
    });
    return { dispose() {} };
  }
}

export function registerMarkdownPreview(): void {
  registerEditorPane(previewPaneId, "Markdown Preview", MarkdownPreviewPane, [MarkdownPreviewInput]);
  registerEditor("*.md", {
    id: previewPaneId,
    label: "Markdown Preview",
    priority: {
      editor: RegisteredEditorPriority.option,
      diff: RegisteredEditorPriority.option,
      merge: RegisteredEditorPriority.option,
    },
  }, { singlePerResource: true }, {
    async createEditorInput(input) {
      return { editor: await createInstance(MarkdownPreviewInput, input.resource) };
    },
  });
}

async function openMarkdownPreview(resource: monaco.Uri): Promise<void> {
  const vscode = await getIssuePilotVscodeApi();
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.parse(resource.toString()),
    previewPaneId,
    vscode.ViewColumn.Beside,
  );
}

function markdownResource(container: HTMLElement, candidate?: unknown): monaco.Uri | undefined {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  if (monaco.Uri.isUri(value)) return value;
  const active = container.querySelector<HTMLElement>('.editor-group-container.active .editor-instance[data-mode-id="markdown"] .monaco-editor[data-uri]');
  const visible = active ?? container.querySelector<HTMLElement>('.editor-instance[data-mode-id="markdown"] .monaco-editor[data-uri]');
  return visible?.dataset.uri ? monaco.Uri.parse(visible.dataset.uri) : undefined;
}

export async function registerMarkdownPreviewCommands(container: HTMLElement): Promise<void> {
  const vscode = await getIssuePilotVscodeApi();
  for (const id of ["markdown.showPreview", "markdown.showPreviewToSide", "markdown.showLockedPreviewToSide", "markdown.reopenAsPreview", "markdown.togglePreview"]) {
    vscode.commands.registerCommand(id, (candidate?: unknown) => {
      const resource = markdownResource(container, candidate);
      return resource ? openMarkdownPreview(resource) : undefined;
    });
  }
}

export function registerMarkdownPreviewAction(container: HTMLElement): void {
  container.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".codicon-open-preview") : null;
    if (!target) return;
    const group = target.closest(".editor-group-container");
    const editor = group?.querySelector<HTMLElement>('.editor-instance[data-mode-id="markdown"] .monaco-editor[data-uri]');
    const value = editor?.dataset.uri;
    if (!value) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openMarkdownPreview(monaco.Uri.parse(value));
  }, true);
}
