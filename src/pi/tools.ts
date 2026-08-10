import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeCapability } from "../capabilities/broker.ts";
import { capabilityInputSchemas } from "../capabilities/contracts.ts";
import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "./policy.ts";

interface ToolMetadata {
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

const metadata: Record<CapabilityName, ToolMetadata> = {
  nacos: {
    label: "Read Service Configuration",
    description: "Return the raw configuration for the deployment's authorized Nacos data IDs.",
    promptSnippet: "Read every exact Nacos Data ID authorized for this deployment",
    promptGuidelines: ["Use nacos only for the deployment configuration scope supplied by Issue Pilot."],
  },
  db: {
    label: "Query Database",
    description: "Run one read-only SQL statement against the selected deployment database.",
    promptSnippet: "Run one bounded read-only MySQL statement",
    promptGuidelines: ["Use db only for read-only SQL evidence and request the complete bounded result."],
  },
  sls: {
    label: "Read SLS Logs",
    description: "Query the selected deployment's Simple Log Service.",
    promptSnippet: "Query an authorized SLS logstore with bounded inputs",
    promptGuidelines: ["Use sls only for logstores authorized by the Issue Pilot deployment policy."],
  },
  redis: {
    label: "Read Redis",
    description: "Run one read-only Redis operation.",
    promptSnippet: "Run an allowlisted read-only Redis operation",
    promptGuidelines: ["Use redis only for the allowlisted read operations; arbitrary Redis commands are unavailable."],
  },
  es: {
    label: "Read Elasticsearch",
    description: "Run a search, count, or mapping request against the selected deployment.",
    promptSnippet: "Read Elasticsearch search, count, or mapping evidence",
    promptGuidelines: ["Use es only for search, count, or mapping reads against the selected deployment."],
  },
  mq: {
    label: "Read RabbitMQ",
    description: "Read RabbitMQ management metadata without consuming messages.",
    promptSnippet: "Read RabbitMQ management metadata without consuming messages",
    promptGuidelines: ["Use mq only for management metadata; message consumption is unavailable."],
  },
  playwright: {
    label: "Use Service Browser",
    description: "Run declarative browser actions against the selected deployment.",
    promptSnippet: "Run bounded declarative browser actions at the fixed deployment origin",
    promptGuidelines: ["Use playwright only at the fixed deployment origin and never request credentials in output."],
  },
};

export function createCapabilityTools(policy: IssuePolicy, deploymentConfig: Record<string, unknown>): ToolDefinition<any, any, any>[] {
  const sessionConfig = structuredClone(deploymentConfig);
  const executeTool = async (capability: CapabilityName, input: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> =>
    await executeCapability(policy, sessionConfig, capability, input, signal) as AgentToolResult<unknown>;
  const toolMetadata = (name: CapabilityName) => ({ name, ...metadata[name] });
  const tools: Record<CapabilityName, ToolDefinition<any, any, any>> = {
    nacos: defineTool({ ...toolMetadata("nacos"), parameters: capabilityInputSchemas.nacos, execute: (_id, input, signal) => executeTool("nacos", input, signal) }),
    db: defineTool({ ...toolMetadata("db"), parameters: capabilityInputSchemas.db, execute: (_id, input, signal) => executeTool("db", input, signal) }),
    sls: defineTool({ ...toolMetadata("sls"), parameters: capabilityInputSchemas.sls, execute: (_id, input, signal) => executeTool("sls", input, signal) }),
    redis: defineTool({ ...toolMetadata("redis"), parameters: capabilityInputSchemas.redis, execute: (_id, input, signal) => executeTool("redis", input, signal) }),
    es: defineTool({ ...toolMetadata("es"), parameters: capabilityInputSchemas.es, execute: (_id, input, signal) => executeTool("es", input, signal) }),
    mq: defineTool({ ...toolMetadata("mq"), parameters: capabilityInputSchemas.mq, execute: (_id, input, signal) => executeTool("mq", input, signal) }),
    playwright: defineTool({ ...toolMetadata("playwright"), parameters: capabilityInputSchemas.playwright, execute: (_id, input, signal) => executeTool("playwright", input, signal) }),
  };
  return policy.service.capabilities.map((capability) => tools[capability]);
}
