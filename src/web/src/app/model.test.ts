import { describe, expect, it, vi } from "vitest";

import { fileSize, relativeTime } from "./model";

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
