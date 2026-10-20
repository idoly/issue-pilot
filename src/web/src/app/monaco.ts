import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/links/browser/links.js";
import "monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/esm/vs/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import * as jsonContribution from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import type { json } from "monaco-editor";
import { sourceLanguage } from "./source-language";

declare global { interface Window { MonacoEnvironment?: monaco.Environment } }
window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// This ESM entry exports jsonDefaults at runtime; its published declaration is empty.
const { jsonDefaults } = jsonContribution as unknown as { jsonDefaults: json.LanguageServiceDefaults };
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
