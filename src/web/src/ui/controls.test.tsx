import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Input, Modal, PasswordInput, Select } from "./index";

describe("local UI controls", () => {
  afterEach(() => cleanup());
  it("supports keyboard single selection and restores focus after Escape", async () => {
    const [value, setValue] = createSignal("a", { ownedWrite: true });
    const view = render(() => (
      <Select
        aria-label="选择"
        value={value()}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onChange={setValue}
      />
    ));
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
    const view = render(() => (
      <div>
        <Select
          mode="multiple"
          aria-label="成员"
          value={value()}
          onChange={setValue}
          options={[
            { value: "alice", label: "Alice" },
            { value: "bob", label: "Bob" },
          ]}
        />
        <button>外部</button>
      </div>
    ));
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

  it("leaves Home and End to the filter input so the caret can move", async () => {
    const view = render(() => (
      <Select
        mode="multiple"
        aria-label="成员"
        value={[]}
        onChange={() => {}}
        options={[
          { value: "alice", label: "Alice" },
          { value: "bob", label: "Bob" },
          { value: "carol", label: "Carol" },
        ]}
      />
    ));
    fireEvent.click(screen.getByRole("combobox", { name: "成员" }));
    const search = await screen.findByRole("searchbox");
    // Focus is in the filter input, so it must expose the listbox and the active option.
    expect(search.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Alice" }).id);
    const activeBefore = screen.getByRole("combobox", { name: "成员" }).getAttribute("aria-activedescendant");
    const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole("combobox", { name: "成员" }).getAttribute("aria-activedescendant")).toBe(activeBefore);
    view.unmount();
  });

  it("keeps disabled options and loading controls inactive", async () => {
    const change = vi.fn();
    const view = render(() => (
      <>
        <Select
          aria-label="受限"
          value="a"
          onChange={change}
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B", disabled: true },
          ]}
        />
        <Button loading onClick={change}>
          保存
        </Button>
      </>
    ));
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(change).not.toHaveBeenCalled();
    view.unmount();
  });

  it("starts and moves keyboard highlights only on enabled options", async () => {
    const change = vi.fn();
    render(() => (
      <Select
        aria-label="选择"
        onChange={change}
        options={[
          { value: "a", label: "A", disabled: true },
          { value: "b", label: "B" },
          { value: "c", label: "C", disabled: true },
          { value: "d", label: "D" },
          { value: "e", label: "E", disabled: true },
        ]}
      />
    ));
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const b = await screen.findByRole("option", { name: "B" });
    const d = screen.getByRole("option", { name: "D" });
    const expectHighlight = (option: HTMLElement) => waitFor(() => expect(trigger.getAttribute("aria-activedescendant")).toBe(option.id));
    expect(trigger.getAttribute("aria-activedescendant")).toBe(b.id);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await expectHighlight(d);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await expectHighlight(b);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await expectHighlight(d);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await expectHighlight(b);
    fireEvent.keyDown(trigger, { key: "End" });
    await expectHighlight(d);
    fireEvent.keyDown(trigger, { key: "Home" });
    await expectHighlight(b);
    await fireEvent.mouseEnter(screen.getByRole("option", { name: "C" }));
    expect(trigger.getAttribute("aria-activedescendant")).toBe(b.id);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(change).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("keeps a highlight with its option when options move and clears it when none are enabled", async () => {
    const disabled = { value: "a", label: "Alpha", disabled: true };
    const beta = { value: "", label: "Beta" };
    const delta = { value: "d", label: "Delta" };
    const [options, setOptions] = createSignal([disabled, beta, delta], { ownedWrite: true });
    const change = vi.fn();
    render(() => <Select aria-label="选择" showSearch options={options()} onChange={change} />);
    fireEvent.click(screen.getByRole("combobox"));
    const input = await screen.findByRole("searchbox");
    const deltaOption = () => screen.getByRole("option", { name: "Delta" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(deltaOption().id));
    setOptions([delta, disabled, beta]);
    await waitFor(() => expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Delta", "Alpha", "Beta"]));
    expect(input.getAttribute("aria-activedescendant")).toBe(deltaOption().id);
    fireEvent.input(input, { target: { value: "Alpha" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: "Delta" })).toBeNull());
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(change).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "Beta" } });
    const betaOption = await screen.findByRole("option", { name: "Beta" });
    expect(input.getAttribute("aria-activedescendant")).toBe(betaOption.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenCalledExactlyOnceWith("");
  });

  for (const state of [{ disabled: true }, { loading: true }])
    it(`ignores keyboard removal while ${state.disabled ? "disabled" : "loading"}`, () => {
      const change = vi.fn();
      const view = render(() => <Select mode="multiple" aria-label="锁定选择" value={["a"]} onChange={change} options={[{ value: "a", label: "Alpha" }]} {...state} />);
      const trigger = screen.getByRole("combobox", { name: "锁定选择" });
      fireEvent.keyDown(trigger, { key: "Backspace" });
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      expect(change).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox")).toBeNull();
      view.unmount();
    });

  it("keeps a dialog and its draft when clicking or dragging onto the backdrop", async () => {
    const [open, setOpen] = createSignal(true, { ownedWrite: true });
    const cancel = vi.fn(() => setOpen(false));
    render(() => (
      <Modal open={open()} title="编辑" onOk={() => {}} onCancel={cancel}>
        <Input aria-label="草稿" />
      </Modal>
    ));
    const input = screen.getByLabelText("草稿");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await fireEvent.input(input, { target: { value: "未保存内容" } });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    fireEvent.mouseDown(input);
    fireEvent.mouseUp(dialog);
    fireEvent.click(dialog);
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText("草稿")).toHaveProperty("value", "未保存内容");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("routes the browser's cancel request to the open child dialog", async () => {
    const [open, setOpen] = createSignal(false, { ownedWrite: true });
    const [nested, setNested] = createSignal(false, { ownedWrite: true });
    const view = render(() => (
      <>
        <Button onClick={() => setOpen(true)}>打开</Button>
        <Modal open={open()} title="父弹窗" onOk={() => setOpen(false)} onCancel={() => setOpen(false)}>
          <Input aria-label="父输入" />
          <Button onClick={() => setNested(true)}>子弹窗</Button>
          <Modal open={nested()} title="子弹窗" onOk={() => setNested(false)} onCancel={() => setNested(false)}>
            <Input aria-label="子输入" />
          </Modal>
        </Modal>
      </>
    ));
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("父输入")));
    const parent = screen.getByRole("dialog", { name: "父弹窗" });
    const nestedOpener = within(parent).getByRole("button", { name: "子弹窗" });
    nestedOpener.focus();
    fireEvent.click(nestedOpener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("子输入")));
    const child = screen.getByRole("dialog", { name: "子弹窗" });
    expect(fireEvent(child, new Event("cancel", { cancelable: true }))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "子弹窗" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "父弹窗" })).toBe(parent);
    fireEvent(parent, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.unmount();
  });

  it("prevents dialog dismissal during save and keeps password inputs masked", async () => {
    const cancel = vi.fn();
    const view = render(() => (
      <Modal open title="保存中" confirmLoading onOk={() => {}} onCancel={cancel}>
        <PasswordInput aria-label="密钥" value="secret" />
      </Modal>
    ));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("密钥")));
    expect(fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByLabelText("密钥").getAttribute("type")).toBe("password");
    expect(screen.queryByRole("button", { name: /显示密码|Show password/ })).toBeNull();
    view.unmount();
  });
});
