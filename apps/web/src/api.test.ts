import { describe, expect, test, vi } from "vitest";
import { createConfigurationKey } from "./api";

describe("configuration keys", () => {
  test("keeps generated keys valid for long names", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);

    const serviceKey = createConfigurationKey("service", "A".repeat(200));
    const copyKey = createConfigurationKey("service", "B".repeat(200), true);
    const localizedCopyKey = createConfigurationKey("service", "服务副本", true);

    for (const key of [serviceKey, copyKey, localizedCopyKey]) {
      expect(key.length).toBeLessThanOrEqual(99);
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]{1,98}$/);
    }
    expect(copyKey).toMatch(/-1750000000000$/);
    expect(localizedCopyKey).toBe("service-copy-1750000000000");

    vi.restoreAllMocks();
  });
});
