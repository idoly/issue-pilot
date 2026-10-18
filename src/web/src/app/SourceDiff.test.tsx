import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { monacoTestState } from "../test-monaco";
import { SourceDiff } from "./SourceDiff";

afterEach(() => { cleanup(); document.body.replaceChildren(); });
describe("Monaco comparison adapter", () => {
  it("changes split mode without replacing its models", async () => {
    const toolbar = document.createElement("div"); document.body.append(toolbar);
    const view = render(() => <SourceDiff value={{ path: "main.ts", before: "original\n", after: "modified\n" }} toolbar={toolbar} disabled onOpen={() => {}} />);
    await screen.findByText("original");
    expect(monacoTestState.models).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "并排" }));
    await waitFor(() => expect(monacoTestState.diffs[0]?.container.dataset.split).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "行内" }));
    await waitFor(() => expect(monacoTestState.diffs[0]?.container.dataset.split).toBe("false"));
    expect(monacoTestState.models).toHaveLength(2);
    expect(screen.getByRole("button", { name: "打开文件" })).toHaveProperty("disabled", true);
    view.unmount();
    expect(monacoTestState.models.every(model => model.disposed)).toBe(true);
    expect(monacoTestState.diffs[0]?.disposed).toBe(true);
  });

  it("replaces both sides on a new comparison and disposes the old pair", async () => {
    const toolbar = document.createElement("div"); document.body.append(toolbar);
    const [value, setValue] = createSignal({ path: "a.txt", before: "first original", after: "first modified" }, { ownedWrite: true });
    render(() => <SourceDiff value={value()} toolbar={toolbar} disabled={false} onOpen={() => {}} />);
    await screen.findByText("first original");
    setValue({ path: "b.txt", before: "second original", after: "second modified" });
    await screen.findByText("second modified");
    expect(monacoTestState.models.slice(0, 2).every(model => model.disposed)).toBe(true);
    expect(monacoTestState.models.slice(2).map(model => model.getValue())).toEqual(["second original", "second modified"]);
    expect(monacoTestState.diffs).toHaveLength(1);
  });
});
