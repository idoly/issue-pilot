import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeCapability, type CapabilityExecutor } from "../capabilities/broker.ts";
import { capabilityDefinitions } from "../capabilities/registry.ts";
import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "./policy.ts";

export function createCapabilityTools(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, executor: CapabilityExecutor = executeCapability): ToolDefinition<any, any, any>[] {
  const sessionConfig = structuredClone(deploymentConfig);
  const executeTool = async (capability: CapabilityName, input: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> =>
    await executor(policy, sessionConfig, capability, input, signal) as AgentToolResult<unknown>;
  return policy.service.capabilities.map((capability) => {
    const definition = capabilityDefinitions[capability];
    return defineTool({
      name: capability,
      ...definition.metadata,
      parameters: definition.inputSchema,
      execute: (_id, input, signal) => executeTool(capability, input, signal),
    });
  });
}
