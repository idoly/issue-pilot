import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";

const maximumCachedEntries = issuePilotConfig.web.markdownCacheEntries;
const maximumCachedCharacters = issuePilotConfig.web.markdownCacheCharacters;
const htmlCache = new Map<string, { html: string; weight: number }>();
let cachedCharacters = 0;

// Issue and agent text may contain raw HTML. Keep rendering inert: no forms or controls to spoof,
// no inline styles to cover the UI, and no predictable ids to shadow modal labels.
const sanitizeOptions = {
  FORBID_TAGS: ["form", "input", "button", "select", "textarea", "label", "dialog", "iframe", "video", "audio", "object", "embed"],
  FORBID_ATTR: ["style", "formaction"],
  SANITIZE_NAMED_PROPS: true,
};
const sanitize = (html: string) => {
  const cleaned = DOMPurify.sanitize(html, sanitizeOptions) as string;
  // External links open in a new tab so Agent output never navigates the application away.
  // Resolve every href so protocol-relative and mixed-case forms are handled too.
  if (!/href=/i.test(cleaned)) return cleaned;
  const template = document.createElement("template");
  template.innerHTML = cleaned;
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let url: URL;
    try {
      url = new URL(link.getAttribute("href")!, window.location.href);
    } catch {
      continue;
    }
    if (url.origin === window.location.origin) continue;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return template.innerHTML;
};

function renderMarkdown(source: string): string {
  const cached = htmlCache.get(source);
  if (cached) {
    htmlCache.delete(source);
    htmlCache.set(source, cached);
    return cached.html;
  }
  const html = sanitize(marked.parse(source, { async: false }) as string);
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
    if (!props.resolveLink) return props.cache === false ? sanitize(marked.parse(props.source, { async: false }) as string) : renderMarkdown(props.source);
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
    return sanitize(template.innerHTML);
  });
  return <div class="markdown markdown-body" innerHTML={html()} />;
}
