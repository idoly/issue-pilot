import { addAbortListener } from "node:events";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { generatedWorkFileSaver } from "../workspace/work-files.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const limits = issuePilotConfig.limits.codemode;

/** Reserve the SDK's second worker slot for a previous worker that is still exiting. */
export class CodemodeQueue {
  private active = false;
  private readonly waiting = new Set<() => void>();
  private readonly waitMs: number;
  private readonly capacity: number;

  constructor(waitMs: number = limits.queueWaitMs, capacity: number = limits.queueEntries) {
    this.waitMs = waitMs;
    this.capacity = capacity;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally { release(); }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (!this.active) {
      this.active = true;
      return Promise.resolve(() => this.release());
    }
    if (this.waiting.size >= this.capacity) return Promise.reject(new Error("codemode_queue_capacity_exceeded"));
    return new Promise((resolve, reject) => {
      let cancellation: ReturnType<typeof addAbortListener> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.waiting.delete(start);
        clearTimeout(timer);
        cancellation?.[Symbol.dispose]();
      };
      const start = () => { cleanup(); resolve(() => this.release()); };
      this.waiting.add(start);
      timer = setTimeout(() => { cleanup(); reject(new Error("codemode_queue_timeout")); }, this.waitMs);
      if (signal) cancellation = addAbortListener(signal, () => { cleanup(); reject(signal.reason); });
    });
  }

  private release(): void {
    const next = this.waiting.values().next().value;
    if (next) next();
    else this.active = false;
  }
}

const scripts = new CodemodeQueue();

export function createIssueCodemodeExtension(root: string): ExtensionFactory {
  const extension = createCodemodeExtension({ models: false, saveOutput: generatedWorkFileSaver(root, "codemode") });
  return pi => extension({
    ...pi,
    registerTool(tool) {
      if (tool.name !== "codemode") { pi.registerTool(tool); return; }
      pi.registerTool({
        ...tool,
        promptGuidelines: [...(tool.promptGuidelines ?? []), "Codemode scripts wait for a process-wide execution slot. Independent tool calls inside a script can still run in parallel."],
        execute: (id, input, signal, update, context) => scripts.run(() => tool.execute(id, input, signal, update, context), signal),
      });
    },
  });
}
