import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monacoTestState } from "../test-monaco";
import { SourceText } from "./SourceText";

describe("Monaco source adapter", () => {
  afterEach(cleanup);

  it("passes file content to a model and disposes each replaced model", async () => {
    const [path, setPath] = createSignal("main.ts", { ownedWrite: true });
    const source = 'const markup = "<script>alert(1)</script>";\n';
    const view = render(() => <SourceText path={path()} value={source} readonly onInput={() => {}} onSave={() => {}} onPosition={() => {}} />);
    expect(await screen.findByLabelText("代码内容 main.ts")).toHaveProperty("value", source);
    expect(monacoTestState.models[0]?.value).toBe(source);
    setPath("other.ts");
    await screen.findByLabelText("代码内容 other.ts");
    expect(monacoTestState.models).toHaveLength(2);
    expect(monacoTestState.models[0]?.disposed).toBe(true);
    view.unmount();
    expect(monacoTestState.models.every(model => model.disposed)).toBe(true);
    expect(monacoTestState.editors[0]?.disposed).toBe(true);
  });

  it("forwards editing, cursor changes and the save command without feeding model updates back", async () => {
    const saved = vi.fn(), position = vi.fn(), changed = vi.fn();
    const [value, setValue] = createSignal("first\nsecond", { ownedWrite: true });
    render(() => <SourceText path="notes.txt" value={value()} readonly={false} onInput={next => { changed(next); setValue(next); }} onSave={saved} onPosition={position} />);
    const input = await screen.findByLabelText("代码内容 notes.txt") as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "first\nchanged" } });
    await waitFor(() => expect(value()).toBe("first\nchanged"));
    expect(changed).toHaveBeenCalledTimes(1);
    input.setSelectionRange(8, 8); fireEvent.select(input);
    expect(position).toHaveBeenLastCalledWith(2, 3);
    fireEvent.keyDown(input, { key: "s", ctrlKey: true }); expect(saved).toHaveBeenCalledOnce();
    setValue("external replacement");
    await waitFor(() => expect(input.value).toBe("external replacement"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("reports the new default cursor even when Monaco does not emit another selection event", async () => {
    const position = vi.fn();
    const [file, setFile] = createSignal({ path: "large.txt", value: "one\ntwo\nthree", reveal: { line: 3, column: 1, length: 0 } }, { ownedWrite: true });
    render(() => <SourceText path={file().path} value={file().value} reveal={file().reveal} readonly={false} onInput={() => {}} onSave={() => {}} onPosition={position} />);
    await screen.findByLabelText("代码内容 large.txt"); expect(position).toHaveBeenLastCalledWith(3, 1);
    setFile({ path: "small.txt", value: "one", reveal: { line: 1, column: 1, length: 0 } });
    await screen.findByLabelText("代码内容 small.txt"); expect(position).toHaveBeenLastCalledWith(1, 1);
  });

  it("reveals Unicode matches and updates read-only mode on the existing editor", async () => {
    const [readonly, setReadonly] = createSignal(true, { ownedWrite: true });
    render(() => <SourceText path="notes.txt" value={"header\n订单 needle\n"} readonly={readonly()} reveal={{ line: 2, column: 4, length: 6 }} onInput={() => {}} onSave={() => {}} onPosition={() => {}} />);
    const input = await screen.findByLabelText("代码内容 notes.txt") as HTMLTextAreaElement;
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("needle");
    expect(input.readOnly).toBe(true); setReadonly(false);
    await waitFor(() => expect(input.readOnly).toBe(false));
    expect(monacoTestState.editors).toHaveLength(1);
  });
});
