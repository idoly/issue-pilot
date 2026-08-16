import { ephemeralContainerArgs, type EphemeralContainerOptions } from "./container.ts";
import { localCommandExecutor, type CommandExecutionOptions, type CommandExecutionResult, type CommandExecutor } from "./capabilities/local-exec.ts";

export interface ContainerRuntime {
  run(options: EphemeralContainerOptions, execution?: CommandExecutionOptions): Promise<CommandExecutionResult>;
}

export class UnavailableContainerRuntime implements ContainerRuntime {
  private readonly error: string;

  constructor(error = "container_runtime_unavailable") {
    this.error = error;
  }

  run(_options: EphemeralContainerOptions, _execution?: CommandExecutionOptions): Promise<never> {
    return Promise.reject(new Error(this.error));
  }
}

export class PodmanContainerRuntime implements ContainerRuntime {
  private readonly executor: CommandExecutor;

  constructor(executor: CommandExecutor = localCommandExecutor) {
    this.executor = executor;
  }

  run(options: EphemeralContainerOptions, execution?: CommandExecutionOptions): Promise<CommandExecutionResult> {
    return this.executor.execute("podman", ephemeralContainerArgs(options), execution);
  }
}

export const localContainerRuntime: ContainerRuntime = new PodmanContainerRuntime();
