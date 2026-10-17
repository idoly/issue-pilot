import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import { createEffect, createMemo, createSignal } from "solid-js";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";

for (const [name, language] of Object.entries({ javascript, typescript, json, css, xml, sql, java, python, bash, yaml, markdown })) hljs.registerLanguage(name, language);
const extensions: Record<string, string> = { js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", css: "css", scss: "css", less: "css", html: "xml", xml: "xml", svg: "xml", sql: "sql", java: "java", py: "python", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown" };
const sourceLanguage = (path: string) => extensions[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plaintext";
export const sourceLanguageName = (path: string) => hljs.getLanguage(sourceLanguage(path))?.name ?? "Plain Text";
const escapedText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function SourceLine(props: { text: string; path: string }) {
  const html = createMemo(() => {
    const language = sourceLanguage(props.path);
    return language !== "plaintext" && props.text.length <= issuePilotConfig.web.sourceHighlightCharacters
      ? hljs.highlight(props.text, { language, ignoreIllegals: true }).value : escapedText(props.text || " ");
  });
  return <code class="source-highlight" innerHTML={html()} />;
}

export function SourceText(props: { path: string; value: string; readonly: boolean; reveal?: { line: number; column: number; length: number }; onInput: (value: string) => void; onSave: () => void; onPosition: (line: number, column: number) => void }) {
  let text!: HTMLTextAreaElement, paint!: HTMLPreElement, gutter!: HTMLPreElement, currentLine!: HTMLDivElement;
  const [line, setLine] = createSignal(1, { ownedWrite: true });
  const html = createMemo(() => {
    const language = sourceLanguage(props.path);
    return language !== "plaintext" && props.value.length <= issuePilotConfig.web.sourceHighlightCharacters
      ? hljs.highlight(props.value + " ", { language, ignoreIllegals: true }).value : escapedText(props.value + " ");
  });
  const numbers = createMemo(() => Array.from({ length: props.value.split("\n").length }, (_, index) => index + 1).join("\n"));
  const position = () => {
    const offset = text.selectionStart, before = text.value.slice(0, offset), current = before.split("\n").length;
    setLine(current); props.onPosition(current, offset - before.lastIndexOf("\n"));
  };
  const scroll = () => {
    paint.style.transform = `translate(${-text.scrollLeft}px, ${-text.scrollTop}px)`;
    gutter.style.transform = `translateY(${-text.scrollTop}px)`;
    currentLine.style.transform = `translateY(${-text.scrollTop}px)`;
  };
  createEffect(() => props.value, () => { queueMicrotask(() => { if (text.isConnected) { position(); scroll(); } }); });
  createEffect(() => props.reveal, target => {
    if (!target) return;
    queueMicrotask(() => {
      if (!text.isConnected) return;
      const lines = text.value.split("\n"), index = Math.max(0, Math.min(lines.length - 1, target.line - 1));
      const start = lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0) + Math.max(0, Math.min(lines[index]!.length, target.column - 1));
      text.focus(); text.setSelectionRange(start, Math.min(text.value.length, start + target.length));
      text.scrollTop = Math.max(0, index - 2) * 19;
      text.scrollLeft = Math.max(0, (target.column - 1) * 8.5 - text.clientWidth / 2);
      position(); scroll();
    });
  });
  return <div class="source-text-editor">
    <div class="source-line-gutter" aria-hidden="true"><pre ref={gutter}>{numbers()}</pre></div>
    <div class="source-editor-highlight" aria-hidden="true"><div ref={currentLine} class="source-current-line" style={{ top: `${(line() - 1) * 19}px` }} /><pre ref={paint} class="source-highlight" innerHTML={html()} /></div>
    <textarea ref={text} class="source-text" aria-label={`代码内容 ${props.path}`} value={props.value} readonly={props.readonly} spellcheck={false} autocapitalize="off" autocomplete="off" wrap="off" onScroll={scroll} onSelect={position} onClick={position} onKeyUp={position} onInput={event => { props.onInput(event.currentTarget.value); position(); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); props.onSave(); } }} />
  </div>;
}
