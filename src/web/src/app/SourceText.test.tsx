import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceText } from "./SourceText";

describe("source text presentation", () => {
  afterEach(cleanup);

  it("highlights code without interpreting source markup as HTML", async () => {
    const source = 'const markup = "<script>alert(1)</script>";\n';
    const view = render(() => <SourceText path="main.ts" value={source} readonly={false} onInput={() => {}} onSave={() => {}} onPosition={() => {}} />);
    expect(screen.getByLabelText("代码内容 main.ts")).toHaveProperty("value", source);
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector(".source-highlight .hljs-keyword")?.textContent).toBe("const");
    expect(view.container.querySelector(".source-editor-highlight pre")?.textContent).toBe(source + " ");
    expect(view.container.querySelector(".source-line-gutter")?.textContent).toBe("1\n2");
  });

  it("keeps typing, cursor position and the save shortcut on the native textarea", async () => {
    const saved = vi.fn(), position = vi.fn();
    const [value, setValue] = createSignal("first\nsecond", { ownedWrite: true });
    const view = render(() => <SourceText path="notes.txt" value={value()} readonly={false} onInput={setValue} onSave={saved} onPosition={position} />);
    const input = screen.getByLabelText("代码内容 notes.txt") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "first\nchanged" } });
    await waitFor(() => expect(view.container.querySelector(".source-editor-highlight pre")?.textContent).toBe("first\nchanged "));
    input.setSelectionRange(8, 8);
    fireEvent.select(input);
    expect(position).toHaveBeenLastCalledWith(2, 3);
    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
    expect(saved).toHaveBeenCalledOnce();
  });
});
