import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";

const maximumCachedEntries = issuePilotConfig.web.markdownCacheEntries;
const maximumCachedCharacters = issuePilotConfig.web.markdownCacheCharacters;
const htmlCache = new Map<string, { html: string; weight: number }>();
let cachedCharacters = 0;

function renderMarkdown(source: string): string {
  const cached = htmlCache.get(source);
  if (cached) {
    htmlCache.delete(source);
    htmlCache.set(source, cached);
    return cached.html;
  }
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
  const weight = source.length + html.length;
  if (weight > maximumCachedCharacters) return html;
  while (htmlCache.size >= maximumCachedEntries || cachedCharacters + weight > maximumCachedCharacters) {
    const oldest = htmlCache.entries().next().value as [string, { html: string; weight: number }] | undefined;
    if (!oldest) break;
    htmlCache.delete(oldest[0]);
    cachedCharacters -= oldest[1].weight;
  }
  htmlCache.set(source, { html, weight });
  cachedCharacters += weight;
  return html;
}

export function Markdown(props: { source: string; cache?: boolean; resolveLink?: (href: string) => string | null | undefined }) {
  const html = createMemo(() => {
    if (!props.resolveLink) return props.cache === false ? DOMPurify.sanitize(marked.parse(props.source, { async: false }) as string) : renderMarkdown(props.source);
    const template = document.createElement("template");
    template.innerHTML = marked.parse(props.source, { async: false }) as string;
    for (const link of template.content.querySelectorAll("a[href]")) {
      const href = props.resolveLink(link.getAttribute("href")!);
      if (href === null) link.replaceWith(...Array.from(link.childNodes));
      else if (href !== undefined) {
        link.setAttribute("href", href);
        link.setAttribute("download", "");
      }
    }
    return DOMPurify.sanitize(template.innerHTML);
  });
  return <div class="markdown markdown-body" innerHTML={html()} />;
}
