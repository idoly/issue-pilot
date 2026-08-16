import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { queryDms } from "../capabilities/dms.ts";
import { readElasticsearch } from "../capabilities/elasticsearch.ts";
import { readMysql } from "../capabilities/mysql.ts";
import { readNacos } from "../capabilities/nacos.ts";
import { readRabbitMq } from "../capabilities/rabbitmq.ts";
import { readRedis } from "../capabilities/redis.ts";
import { capabilityDefinitions, type CapabilityInputs } from "../capabilities/registry.ts";
import { readSlsLogs } from "../capabilities/sls.ts";
import { processToolRuntime, type ToolRuntime } from "../tool-runtime.ts";
import type { AgentSessionContext } from "../agent/context.ts";
import type { CapabilityName, DeploymentConfig } from "../domain/contracts.ts";

function parseInput<Key extends CapabilityName>(capability: Key, input: unknown): CapabilityInputs[Key] {
  try {
    return Value.Parse(capabilityDefinitions[capability].inputSchema, input ?? {}) as CapabilityInputs[Key];
  } catch {
    throw new Error(`invalid_${capability}_input`);
  }
}

async function runTool(tools: ToolRuntime, config: DeploymentConfig, capability: CapabilityName, input: unknown, signal?: AbortSignal) {
  switch (capability) {
    case "nacos":
      parseInput("nacos", input);
      return readNacos(config.nacos!, signal);
    case "db": return readMysql(config.db!, parseInput("db", input), signal);
    case "redis": return readRedis(config.redis!, parseInput("redis", input), signal);
    case "mq": return readRabbitMq(config.mq!, parseInput("mq", input), signal);
    case "es": return readElasticsearch(config.es!, parseInput("es", input), signal);
    case "dms": return queryDms(tools, parseInput("dms", input), config.dms!, signal);
    case "sls": return readSlsLogs(tools, parseInput("sls", input), config.sls!, signal);
  }
}

export function createCapabilityTools(context: AgentSessionContext, deploymentConfig: DeploymentConfig, tools: ToolRuntime = processToolRuntime): ToolDefinition<any, any, any>[] {
  const sessionConfig = structuredClone(deploymentConfig);
  return context.capabilities.map((capability) => {
    const definition = capabilityDefinitions[capability];
    return defineTool({
      name: capability,
      ...definition.metadata,
      parameters: definition.inputSchema,
      execute: async (_id, input, signal) => await runTool(tools, sessionConfig, capability, input, signal) as AgentToolResult<unknown>,
    });
  });
}
