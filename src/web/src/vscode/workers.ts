import extensionHostWorker from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker";
import extensionHostWorkerUrl from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url";
import cssWorker from "@codingame/monaco-vscode-standalone-css-language-features/worker?worker";
import htmlWorker from "@codingame/monaco-vscode-standalone-html-language-features/worker?worker";
import jsonWorker from "@codingame/monaco-vscode-standalone-json-language-features/worker?worker";
import typescriptWorker from "@codingame/monaco-vscode-standalone-typescript-language-features/worker?worker";
import textmateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

window.MonacoEnvironment = {
  getWorkerUrl(_moduleId, label) {
    return label === "extensionHostWorkerMain" ? extensionHostWorkerUrl : undefined;
  },
  getWorkerOptions(_moduleId, label) {
    return label === "extensionHostWorkerMain" ? { type: "module", name: label } : undefined;
  },
  getWorker(_moduleId, label) {
    if (label === "extensionHostWorkerMain") return new extensionHostWorker();
    if (label === "TextMateWorker") return new textmateWorker();
    if (label === "typescript" || label === "javascript") return new typescriptWorker();
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    return new editorWorker();
  },
};
