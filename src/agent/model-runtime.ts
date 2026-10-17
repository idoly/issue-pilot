import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AGENT_THINKING_LEVELS, type AgentModelDefinition, type AgentThinkingLevel } from "../domain/contracts.ts";

export interface AgentModelCatalog {
  list(): Promise<AgentModelDefinition[]>;
}

export interface PiModelRuntime {
  load(): Promise<ModelRuntime>;
  close(): Promise<void>;
}

async function copyPrivateFile(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function createPiModelRuntime(agentDir = getAgentDir(), personal?: { provider: string; apiKey: string }): PiModelRuntime {
  let privateDirectory: string | undefined;
  let runtime: Promise<ModelRuntime> | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = async () => {
    const directory = privateDirectory;
    privateDirectory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  const load = () => {
    if (closing) return Promise.reject(new Error("pi_model_runtime_closed"));
    runtime ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "issue-pilot-pi-"));
      privateDirectory = directory;
      try {
        await chmod(directory, 0o700);
        await Promise.all([
          ...(personal ? [] : [copyPrivateFile(join(agentDir, "auth.json"), join(directory, "auth.json"))]),
          copyPrivateFile(join(agentDir, "models-store.json"), join(directory, "models-store.json")),
        ]);
        let modelsPath = join(agentDir, "models.json");
        if (personal) {
          try {
            const models = JSON.parse(await readFile(modelsPath, "utf8"), (key, value) => {
              if (key === "apiKey" || /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key)) return undefined;
              return value;
            });
            modelsPath = join(directory, "models.json");
            await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
          } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
          }
        }
        const modelRuntime = await ModelRuntime.create({
          authPath: join(directory, "auth.json"),
          modelsPath,
          modelsStorePath: join(directory, "models-store.json"),
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        if (personal) await modelRuntime.setRuntimeApiKey(personal.provider, personal.apiKey);
        return modelRuntime;
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    })();
    return runtime;
  };
  return {
    load,
    close() {
      closing ??= (async () => {
        try { await runtime; } catch {
          // Initialization errors are reported by the caller that requested the runtime.
        }
        await cleanup();
      })();
      return closing;
    },
  };
}

export class PiAgentModelCatalog implements AgentModelCatalog {
  private readonly runtime: PiModelRuntime;
  private readonly ownsRuntime: boolean;
  private listing: Promise<AgentModelDefinition[]> | undefined;

  constructor(runtime?: PiModelRuntime) {
    this.runtime = runtime ?? createPiModelRuntime();
    this.ownsRuntime = runtime === undefined;
  }

  async close(): Promise<void> {
    if (!this.ownsRuntime) return;
    try { await this.listing; } catch {
      // The list caller owns refresh errors; close still releases private storage.
    }
    await this.runtime.close();
  }

  list(): Promise<AgentModelDefinition[]> {
    if (this.listing) return this.listing;
    this.listing = this.load().finally(() => { this.listing = undefined; });
    return this.listing;
  }

  private async load(): Promise<AgentModelDefinition[]> {
    const runtime = await this.runtime.load();
    await runtime.refresh({ allowNetwork: false });
    return runtime.getAvailableSnapshot()
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
        thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is AgentThinkingLevel => AGENT_THINKING_LEVELS.includes(level as AgentThinkingLevel)),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  }
}
