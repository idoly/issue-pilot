import { issuePilotConfig } from "../../../../issue-pilot.config.ts";

const extensions: Record<string, string> = { js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", css: "css", scss: "css", less: "css", html: "html", xml: "xml", svg: "xml", sql: "sql", java: "java", py: "python", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown" };
const names: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", json: "JSON", css: "CSS", html: "HTML", xml: "XML", sql: "SQL", java: "Java", python: "Python", shell: "Bash", yaml: "YAML", markdown: "Markdown", plaintext: "Plain Text" };
export const sourceLanguage = (path: string, text: string) => text.length > issuePilotConfig.web.sourceHighlightCharacters ? "plaintext" : extensions[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext";
export const sourceLanguageName = (path: string) => names[extensions[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext"]!;
