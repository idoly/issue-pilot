import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo } from "solid-js";

import { sharedConfig } from "../../../../issue-pilot.config.ts";

const maximumCachedEntries = sharedConfig.web.markdownCacheEntries;
const maximumCachedCharacters = sharedConfig.web.markdownCacheCharacters;
// html is the sanitized rendering. linked keeps the unsanitized marked output only when it contains an href,
// so callers that rewrite links can start from it without parsing again; link-free sources need no rewrite.
interface CachedMarkdown {
  html: string;
  linked: string | null;
  weight: number;
}
const htmlCache = new Map<string, CachedMarkdown>();
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

const parse = (source: string) => marked.parse(source, { async: false }) as string;

function renderMarkdown(source: string): CachedMarkdown {
  const cached = htmlCache.get(source);
  if (cached) {
    htmlCache.delete(source);
    htmlCache.set(source, cached);
    return cached;
  }
  const parsed = parse(source);
  const html = sanitize(parsed);
  const linked = /href/i.test(parsed) ? parsed : null;
  const entry = { html, linked, weight: source.length + html.length + (linked?.length ?? 0) };
  if (entry.weight > maximumCachedCharacters) return entry;
  while (htmlCache.size >= maximumCachedEntries || cachedCharacters + entry.weight > maximumCachedCharacters) {
    const oldest = htmlCache.entries().next().value as [string, CachedMarkdown] | undefined;
    if (!oldest) break;
    htmlCache.delete(oldest[0]);
    cachedCharacters -= oldest[1].weight;
  }
  htmlCache.set(source, entry);
  cachedCharacters += entry.weight;
  return entry;
}

/** Rewrites links in unsanitized marked output; sanitization always runs afterwards on the result. */
function renderLinked(parsed: string, resolveLink: (href: string) => string | null | undefined): string {
  const template = document.createElement("template");
  template.innerHTML = parsed;
  for (const link of template.content.querySelectorAll("a[href]")) {
    const href = resolveLink(link.getAttribute("href")!);
    if (href === null) link.replaceWith(...Array.from(link.childNodes));
    else if (href !== undefined) {
      link.setAttribute("href", href);
      link.setAttribute("download", "");
    }
  }
  return sanitize(template.innerHTML);
}

export function Markdown(props: { source: string; cache?: boolean; resolveLink?: (href: string) => string | null | undefined }) {
  const html = createMemo(() => {
    const resolveLink = props.resolveLink;
    if (props.cache === false) {
      const parsed = parse(props.source);
      return resolveLink ? renderLinked(parsed, resolveLink) : sanitize(parsed);
    }
    // The parse and the sanitized link-free rendering are cached by source; only content that actually
    // contains links is rewritten for the current resolver and sanitized again.
    const entry = renderMarkdown(props.source);
    return resolveLink && entry.linked !== null ? renderLinked(entry.linked, resolveLink) : entry.html;
  });
  return <div class="markdown markdown-body" innerHTML={html()} />;
}
