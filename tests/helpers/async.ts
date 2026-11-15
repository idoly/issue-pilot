import { setTimeout as delay } from "node:timers/promises";

/** Polls a condition until it holds; throws `condition_not_met` after the attempt budget. */
export async function waitFor(check: () => boolean, { attempts = 200, intervalMs = 5 }: { attempts?: number; intervalMs?: number } = {}): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await delay(intervalMs);
  }
  throw new Error("condition_not_met");
}
