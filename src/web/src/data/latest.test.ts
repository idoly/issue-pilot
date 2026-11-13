import { describe, expect, it } from "vitest";

import { createLatestTask } from "./latest";

describe("createLatestTask", () => {
  it("aborts the previous request and rejects its results", () => {
    const latest = createLatestTask();
    const first = latest.begin();
    expect(latest.active).toBe(true);
    const second = latest.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    second.finish();
    expect(latest.active).toBe(false);
  });

  it("invalidates a finished task after cancellation", () => {
    const latest = createLatestTask();
    const task = latest.begin();
    task.finish();
    const next = latest.begin();
    latest.cancel();
    expect(task.isCurrent()).toBe(false);
    expect(next.signal.aborted).toBe(true);
    expect(next.isCurrent()).toBe(false);
    expect(latest.active).toBe(false);
  });
});
