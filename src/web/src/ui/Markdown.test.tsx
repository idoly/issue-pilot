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
});
