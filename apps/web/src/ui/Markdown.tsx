import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo } from "solid-js";

export function Markdown(props: { source: string }) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.source, { async: false }) as string));
  return <div class="markdown" innerHTML={html()} />;
}
