import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
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
    const resolve = props.resolveLink;
    const renderer = new Renderer();
    const defaultLink = renderer.link;
    renderer.link = function (token) {
      const href = resolve(token.href);
      if (href === null) return this.parser.parseInline(token.tokens);
      const rendered = defaultLink.call(this, href === undefined ? token : { ...token, href });
      return href === undefined ? rendered : rendered.replace("<a ", "<a download ");
    };
    return DOMPurify.sanitize(marked.parse(props.source, { async: false, renderer }) as string);
  });
  return <div class="markdown markdown-body" innerHTML={html()} />;
}
