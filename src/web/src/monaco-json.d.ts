// Monaco 0.57 exports its tokenizer without declarations; registration uses the public languages API.
declare module "monaco-editor/languages/features/json/tokenization.js" {
  import type { languages } from "monaco-editor/editor/editor.api.js";
  export function createTokenizationSupport(supportComments: boolean): languages.TokensProvider;
}
