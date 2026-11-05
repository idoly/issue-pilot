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

async function readOperatorModels(agentDir: string): Promise<{ providers?: Record<string, unknown> } | undefined> {
  try {
    return JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"), (key, value) => {
      // Operator headers may contain arbitrary authentication, including custom token names.
      if (key === "apiKey" || key === "headers" || /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(key)) return undefined;
      return value;
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Without a credential the runtime only lists models and reads the Operator models.json directly.
// Request runtimes receive the SQLite-selected key; Operator auth.json and models.json credentials never reach them.
export function createPiModelRuntime(agentDir = getAgentDir(), credential?: { provider: string; apiKey: string }): PiModelRuntime {
  let privateDirectory: string | undefined;
  let runtime: Promise<ModelRuntime> | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = async () => {
    const directory = privateDirectory;
    if (directory) await rm(directory, { recursive: true, force: true });
    // Failed initialization may retry cleanup during close; ownership ends only after removal succeeds.
    privateDirectory = undefined;
  };
  const load = () => {
    if (closing) return Promise.reject(new Error("pi_model_runtime_closed"));
    runtime ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "issue-pilot-pi-"));
      privateDirectory = directory;
      try {
        await chmod(directory, 0o700);
        await copyPrivateFile(join(agentDir, "models-store.json"), join(directory, "models-store.json"));
        let modelsPath = join(agentDir, "models.json");
        if (credential) {
          const models = await readOperatorModels(agentDir);
          modelsPath = join(directory, "models.json");
          if (models) await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
        }
        const modelRuntime = await ModelRuntime.create({
          authPath: join(directory, "auth.json"),
          modelsPath,
          modelsStorePath: join(directory, "models-store.json"),
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        if (credential) await modelRuntime.setRuntimeApiKey(credential.provider, credential.apiKey);
        return modelRuntime;
      } catch (error) {
        try {
          await cleanup();
        } catch (cleanupError) {
          throw new Error("pi_model_runtime_cleanup_failed", { cause: new AggregateError([error, cleanupError]) });
        }
        throw error;
      }
    })();
    return runtime;
  };
  return {
    load,
    close() {
      closing ??= (async () => {
        try {
          await runtime;
        } catch {
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
  private readonly agentDir: string;
  private listing: Promise<AgentModelDefinition[]> | undefined;

  constructor(runtime?: PiModelRuntime, agentDir = getAgentDir()) {
    this.runtime = runtime ?? createPiModelRuntime(agentDir);
    this.ownsRuntime = runtime === undefined;
    this.agentDir = agentDir;
  }

  async close(): Promise<void> {
    if (!this.ownsRuntime) return;
    try {
      await this.listing;
    } catch {
      // The list caller owns refresh errors; close still releases private storage.
    }
    await this.runtime.close();
  }

  list(): Promise<AgentModelDefinition[]> {
    if (this.listing) return this.listing;
    this.listing = this.load().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  private async load(): Promise<AgentModelDefinition[]> {
    const runtime = await this.runtime.load();
    await runtime.refresh({ allowNetwork: false });
    // Candidates are the Operator models.json providers; SQLite keys make them usable, so host authentication is not a filter.
    const providers = new Set(Object.keys((await readOperatorModels(this.agentDir))?.providers ?? {}));
    return runtime
      .getModels()
      .filter((model) => providers.has(model.provider))
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
        thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is AgentThinkingLevel => AGENT_THINKING_LEVELS.includes(level as AgentThinkingLevel)),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));
  }
}
