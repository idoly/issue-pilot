import { describe, expect, it, vi } from "vitest";

import { attachmentDisplayName, fileSize, relativeTime } from "./model";

describe("workspace display values", () => {
  it("formats file sizes without an external editor URL", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2.0 KB");
    expect(fileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats recent timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    expect(relativeTime("2026-08-14T23:55:00.000Z")).toBe("5 分钟前");
    vi.useRealTimers();
  });
});

describe("attachmentDisplayName", () => {
  it("labels opaque hash-named images by position and keeps every other name", () => {
    expect(attachmentDisplayName("0123456789abcdef01234567.png", true, 2)).toBe("图片附件 2");
    expect(attachmentDisplayName("0123456789ABCDEF0123456789abcdef.JPEG", true, 1)).toBe("图片附件 1");
    expect(attachmentDisplayName("0123456789abcdef0123456.png", true, 1)).toBe("0123456789abcdef0123456.png");
    expect(attachmentDisplayName("0123456789abcdef01234567.png", false, 1)).toBe("0123456789abcdef01234567.png");
    expect(attachmentDisplayName("screenshot-0123456789abcdef01234567.png", true, 1)).toBe("screenshot-0123456789abcdef01234567.png");
    expect(attachmentDisplayName("0123456789abcdef01234567", true, 1)).toBe("0123456789abcdef01234567");
  });
});
