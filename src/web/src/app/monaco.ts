import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import { jsonDefaults } from "monaco-editor/languages/features/json/register.js";
import { sourceLanguage } from "./source-language";

declare global { interface Window { MonacoEnvironment?: monaco.Environment } }
window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
jsonDefaults.setModeConfiguration({ tokens: true, diagnostics: false, completionItems: false, hovers: false, documentSymbols: false, colors: false, foldingRanges: false, selectionRanges: false, documentFormattingEdits: false, documentRangeFormattingEdits: false });
let modelId = 0;
export const createSourceModel = (path: string, text: string) => monaco.editor.createModel(text, sourceLanguage(path, text), monaco.Uri.from({ scheme: "inmemory", path: `/issue-pilot/${++modelId}/${path}` }));
// The occurrence highlighter leaves a cancelled delay unhandled when this version replaces a model.
export const sourceEditorOptions = {
  theme: "issue-pilot", automaticLayout: true, fontFamily: 'Consolas, "Droid Sans Mono", monospace', fontSize: 14, lineHeight: 19,
  minimap: { enabled: false }, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 0, bottom: 0 },
  scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 14, useShadows: false },
  renderLineHighlight: "all", renderWhitespace: "none", wordWrap: "off", glyphMargin: true, editContext: false, unicodeHighlight: { ambiguousCharacters: false },
  stickyScroll: { enabled: false }, occurrencesHighlight: "off", tabSize: 4, insertSpaces: true,
} satisfies monaco.editor.IStandaloneEditorConstructionOptions;
monaco.editor.defineTheme("issue-pilot", {
  base: "vs-dark", inherit: true,
  rules: [
    { token: "", foreground: "E6EDF3" }, { token: "comment", foreground: "8B949E" }, { token: "keyword", foreground: "FF7B72" },
    { token: "string", foreground: "A5D6FF" }, { token: "number", foreground: "79C0FF" }, { token: "type", foreground: "FFA657" },
    { token: "type.identifier", foreground: "FFA657" }, { token: "tag", foreground: "7EE787" }, { token: "attribute.name", foreground: "79C0FF" },
  ],
  colors: {
    "editor.background": "#0d1117", "editor.foreground": "#e6edf3", "editorLineNumber.foreground": "#6e7681", "editorLineNumber.activeForeground": "#e6edf3",
    "editor.selectionBackground": "#264f7880", "editor.lineHighlightBackground": "#6e76810d", "editor.lineHighlightBorder": "#00000000",
    "editorGutter.background": "#0d1117", "editorWidget.background": "#161b22", "editorWidget.border": "#30363d", "focusBorder": "#1f6feb",
    "diffEditor.insertedLineBackground": "#172a24", "diffEditor.removedLineBackground": "#2b161b", "diffEditor.insertedTextBackground": "#2ea04340", "diffEditor.removedTextBackground": "#f8514940",
  },
});
export { monaco };
