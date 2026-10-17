import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Input, Modal, PasswordInput, Select } from "./index";

describe("local UI controls", () => {
  afterEach(() => cleanup());
  it("supports keyboard single selection and restores focus after Escape", async () => {
    const [value, setValue] = createSignal("a", { ownedWrite: true });
    const view = render(() => <Select aria-label="选择" value={value()} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} onChange={setValue} />);
    const trigger = screen.getByRole("combobox", { name: "选择" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(trigger.getAttribute("aria-activedescendant")).toMatch(/option-1$/));
    fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(trigger.textContent).toContain("Beta"));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    view.unmount();
  });

  it("searches multiple options, retains selections and clears on an outside click", async () => {
    const [value, setValue] = createSignal<string[]>([], { ownedWrite: true });
    const view = render(() => <div><Select mode="multiple" aria-label="成员" value={value()} onChange={setValue} options={[{ value: "alice", label: "Alice" }, { value: "bob", label: "Bob" }]} /><button>外部</button></div>);
    fireEvent.click(screen.getByRole("combobox", { name: "成员" }));
    fireEvent.input(await screen.findByRole("searchbox"), { target: { value: "Bob" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: "Alice" })).toBeNull());
    fireEvent.click(screen.getByRole("option", { name: "Bob" }));
    await waitFor(() => expect(value()).toEqual(["bob"]));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "外部" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "移除 bob" }));
    await waitFor(() => expect(value()).toEqual([]));
    view.unmount();
  });

  it("keeps disabled options and loading controls inactive", async () => {
    const change = vi.fn();
    const view = render(() => <><Select aria-label="受限" value="a" onChange={change} options={[{ value: "a", label: "A" }, { value: "b", label: "B", disabled: true }]} /><Button loading onClick={change}>保存</Button></>);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(change).not.toHaveBeenCalled();
    view.unmount();
  });

  it("traps dialog focus and restores parent and opener focus across nested dialogs", async () => {
    const [open, setOpen] = createSignal(false, { ownedWrite: true });
    const [nested, setNested] = createSignal(false, { ownedWrite: true });
    const previousOverflow = document.body.style.overflow;
    const view = render(() => <><Button onClick={() => setOpen(true)}>打开</Button><Modal open={open()} title="父弹窗" onOk={() => setOpen(false)} onCancel={() => setOpen(false)}><Input aria-label="父输入" /><Button onClick={() => setNested(true)}>子弹窗</Button><Modal open={nested()} title="子弹窗" onOk={() => setNested(false)} onCancel={() => setNested(false)}><Input aria-label="子输入" /></Modal></Modal></>);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("父输入")));
    const parent = screen.getByRole("dialog", { name: "父弹窗" });
    const nestedOpener = within(parent).getByRole("button", { name: "子弹窗" });
    nestedOpener.focus(); fireEvent.click(nestedOpener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("子输入")));
    const child = screen.getByRole("dialog", { name: "子弹窗" });
    const footer = within(child).getByRole("button", { name: "确定" });
    footer.focus(); fireEvent.keyDown(footer, { key: "Tab" });
    expect(document.activeElement).toBe(within(child).getByRole("button", { name: "关闭弹窗" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "子弹窗" })).toBeNull());
    expect(document.activeElement).toBe(nestedOpener);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(nestedOpener, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe(previousOverflow);
    view.unmount();
  });

  it("prevents dialog dismissal during save and keeps password inputs masked", async () => {
    const cancel = vi.fn();
    const view = render(() => <Modal open title="保存中" confirmLoading onOk={() => {}} onCancel={cancel}><PasswordInput aria-label="密钥" value="secret" /></Modal>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("密钥")));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText("密钥").getAttribute("type")).toBe("password");
    expect(screen.queryByRole("button", { name: /显示密码|Show password/ })).toBeNull();
    view.unmount();
  });
});
