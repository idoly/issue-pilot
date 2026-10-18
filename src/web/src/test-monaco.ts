import { sourceLanguage, sourceLanguageName } from "./app/source-language";
// Public Monaco calls used by the Solid adapters. Browser tests run the real editor.
type Position = { lineNumber: number; column: number };
class Model {
  value: string;
  language: string;
  disposed = false;
  listeners = new Set<() => void>();
  constructor(value: string, language: string) { this.value = value; this.language = language; monacoTestState.models.push(this); }
  getValue() { return this.value; }
  setValue(value: string) { this.value = value; for (const listener of this.listeners) listener(); }
  getLanguageId() { return this.language; }
  validatePosition(position: Position) {
    const lines = this.value.split("\n"), lineNumber = Math.max(1, Math.min(lines.length, position.lineNumber));
    return { lineNumber, column: Math.max(1, Math.min(lines[lineNumber - 1]!.length + 1, position.column)) };
  }
  getOffsetAt(position: Position) { return this.value.split("\n").slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1; }
  getPositionAt(offset: number) { const lines = this.value.slice(0, offset).split("\n"); return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 }; }
  dispose() { this.disposed = true; }
}
class Selection {
  startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number;
  constructor(a: number, b: number, c: number, d: number) { this.startLineNumber = a; this.startColumn = b; this.endLineNumber = c; this.endColumn = d; }
}
function createEditor(container: HTMLElement) {
  const input = document.createElement("textarea"); container.append(input);
  let model: Model | undefined;
  const contentListeners = new Set<() => void>(), positionListeners = new Set<(event: { position: Position }) => void>();
  const report = () => { if (model) for (const listener of positionListeners) listener({ position: model.getPositionAt(input.selectionEnd) }); };
  const sync = () => { input.value = model?.getValue() ?? ""; for (const listener of contentListeners) listener(); };
  let save = () => {};
  input.addEventListener("input", () => { if (model && !input.readOnly) { model.setValue(input.value); report(); } });
  for (const type of ["click", "select", "keyup"]) input.addEventListener(type, report);
  input.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } });
  const api = {
    input, disposed: false,
    setModel(next: Model) { model?.listeners.delete(sync); model = next; model.listeners.add(sync); sync(); input.setSelectionRange(0, 0); },
    updateOptions(options: { readOnly?: boolean; ariaLabel?: string }) { if (options.readOnly !== undefined) input.readOnly = options.readOnly; if (options.ariaLabel) input.setAttribute("aria-label", options.ariaLabel); },
    onDidChangeModelContent(callback: () => void) { contentListeners.add(callback); return { dispose: () => { contentListeners.delete(callback); } }; },
    onDidChangeCursorPosition(callback: (event: { position: Position }) => void) { positionListeners.add(callback); return { dispose: () => { positionListeners.delete(callback); } }; },
    addCommand(_key: number, callback: () => void) { save = callback; },
    setSelection(value: Selection) {
      if (!model) return;
      const start = model.getOffsetAt({ lineNumber: value.startLineNumber, column: value.startColumn }), end = model.getOffsetAt({ lineNumber: value.endLineNumber, column: value.endColumn });
      const changed = input.selectionStart !== start || input.selectionEnd !== end;
      input.setSelectionRange(start, end); if (changed) report();
    },
    revealPositionInCenterIfOutsideViewport(_value: Position) {},
    focus() { input.focus(); },
    dispose() { api.disposed = true; model?.listeners.delete(sync); input.remove(); },
  };
  monacoTestState.editors.push(api); return api;
}
function createDiffEditor(container: HTMLElement, options: { renderSideBySide?: boolean }) {
  const original = document.createElement("pre"), modified = document.createElement("pre");
  original.dataset.side = "original"; modified.dataset.side = "modified"; container.append(original, modified);
  let models: { original: Model; modified: Model } | undefined;
  const listeners = new Set<() => void>();
  const api = {
    container, disposed: false,
    setModel(value: { original: Model; modified: Model }) { models = value; original.textContent = value.original.getValue(); modified.textContent = value.modified.getValue(); for (const listener of listeners) listener(); },
    updateOptions(value: { renderSideBySide?: boolean }) { if (value.renderSideBySide !== undefined) container.dataset.split = String(value.renderSideBySide); },
    getLineChanges() { return models?.original.value === models?.modified.value ? [] : [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }]; },
    onDidUpdateDiff(callback: () => void) { listeners.add(callback); return { dispose: () => { listeners.delete(callback); } }; },
    dispose() { api.disposed = true; original.remove(); modified.remove(); },
  };
  api.updateOptions(options); monacoTestState.diffs.push(api); return api;
}
export const monacoTestState: { models: Model[]; editors: { input: HTMLTextAreaElement; disposed: boolean }[]; diffs: { container: HTMLElement; disposed: boolean }[] } = { models: [], editors: [], diffs: [] };
export function resetMonacoTestState() { monacoTestState.models.length = 0; monacoTestState.editors.length = 0; monacoTestState.diffs.length = 0; }
export const monacoMock = {
  createSourceModel: (path: string, text: string) => new Model(text, sourceLanguage(path, text)),
  sourceLanguage, sourceLanguageName,
  sourceEditorOptions: {},
  monaco: { editor: { create: createEditor, createDiffEditor, setModelLanguage: (model: Model, language: string) => { model.language = language; }, EndOfLinePreference: { LF: 1 } }, Selection, KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } },
};
