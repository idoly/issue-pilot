import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalCopy = Object.getOwnPropertyDescriptor(document, "execCommand");
beforeEach(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard");
  if (originalCopy) Object.defineProperty(document, "execCommand", originalCopy); else Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

describe("browser clipboard", () => {
  it("copies through the secure clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await copyText("提交信息");
    expect(writeText).toHaveBeenCalledWith("提交信息");
  });
  it("copies on HTTP and restores focus without leaving temporary elements", async () => {
    const button = document.createElement("button"); document.body.append(button); button.focus();
    const copy = vi.fn(() => { expect((document.activeElement as HTMLTextAreaElement).value).toBe("提交信息"); return true; });
    Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
    await copyText("提交信息");
    expect(copy).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("textarea")).toBeNull();
  });
  it("reports a failed copy and still removes the temporary element", async () => {
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    await expect(copyText("commit")).rejects.toThrow("clipboard_write_failed");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
