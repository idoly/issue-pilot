import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { queryDms } from "../capabilities/dms.ts";
import { readElasticsearch } from "../capabilities/elasticsearch.ts";
import { readMysql } from "../capabilities/mysql.ts";
import { readNacos } from "../capabilities/nacos.ts";
import { readRabbitMq } from "../capabilities/rabbitmq.ts";
import { readRedis } from "../capabilities/redis.ts";
import { capabilityToolInputSchema, type CapabilityInputs } from "../capabilities/registry.ts";
import { readSlsLogs } from "../capabilities/sls.ts";
import type { McpToolBinding } from "../mcp/client.ts";
import type { IssueOutputStore } from "../outputs/store.ts";
import type { AgentSessionContext } from "../agent/context.ts";
import type { CapabilityName, DeploymentConfig } from "../domain/contracts.ts";

export interface ServiceToolScope { environmentKey: string; serviceKey: string; serviceName: string; config: DeploymentConfig }
export interface ServiceMcpToolScope { environmentKey: string; serviceKey: string; serviceName: string; tools: McpToolBinding[] }
async function runTool(config: DeploymentConfig, capability: CapabilityName, input: CapabilityInputs[CapabilityName], signal?: AbortSignal, outputStore?: IssueOutputStore) {
  switch (capability) {
    case "nacos": return readNacos(config.nacos!, signal);
    case "db": return readMysql(config.db!, input as CapabilityInputs["db"], signal, outputStore);
    case "redis": return readRedis(config.redis!, input as CapabilityInputs["redis"], signal);
    case "mq": return readRabbitMq(config.mq!, input as CapabilityInputs["mq"], signal);
    case "es": return readElasticsearch(config.es!, input as CapabilityInputs["es"], signal);
    case "dms": return queryDms(input as CapabilityInputs["dms"], config.dms!, signal, undefined, outputStore);
    case "sls": return readSlsLogs(input as CapabilityInputs["sls"], config.sls!, signal);
  }
}

export function createCapabilityTools(context: Pick<AgentSessionContext, "serviceKey" | "environmentKey" | "capabilities" | "canWriteOutputs">, deploymentConfig: DeploymentConfig, options: { outputStore?: IssueOutputStore | undefined; serviceScopes?: ServiceToolScope[] | undefined; mcpScopes?: ServiceMcpToolScope[] | undefined } = {}): ToolDefinition<any, any, any>[] {
  const { outputStore, serviceScopes, mcpScopes = [] } = options;
  const scopes = structuredClone(serviceScopes ?? [{ environmentKey: context.environmentKey, serviceKey: context.serviceKey, serviceName: context.serviceKey, config: deploymentConfig }]);
  const schemas: TSchema[] = [];
  for (const scope of scopes) for (const capability of context.capabilities) {
    if (!scope.config[capability]) continue;
    const schema = capabilityToolInputSchema(capability, scope.config[capability]!, { outputEnabled: context.canWriteOutputs && (capability === "db" || capability === "dms") });
    schemas.push(Type.Object({ environment: Type.Literal(scope.environmentKey), service: Type.Literal(scope.serviceKey, { description: scope.serviceName }), capability: Type.Literal(capability), ...(schema as unknown as { properties: Record<string, TSchema> }).properties }, { additionalProperties: false }));
  }
  for (const scope of mcpScopes) for (const tool of scope.tools) schemas.push(Type.Object({ environment: Type.Literal(scope.environmentKey), service: Type.Literal(scope.serviceKey, { description: scope.serviceName }), capability: Type.Literal("mcp"), tool: Type.Literal(tool.name, { description: `${tool.label}: ${tool.description}` }), input: tool.parameters }, { additionalProperties: false }));
  if (!schemas.length) return [];
  const schema = schemas.length === 1 ? schemas[0]! : Type.Union(schemas);
  return [defineTool({
    name: "service_query", label: "Query service evidence", parameters: schema,
    description: "Query evidence from a configured environment and service. Development Issues can read production/test sources; other Issues stay in their own environment. Use workspace list/describe to read service investigation notes before choosing a capability. Credentials and targets are injected by the server. Native operations remain read-only; MCP operations follow the source environment policy. For MCP select tool and supply its input object.",
    execute: async (_id, raw, signal): Promise<AgentToolResult<unknown>> => {
      let input: Record<string, unknown>;
      try { input = Value.Parse(schema, raw ?? {}) as typeof input; } catch { throw new Error("invalid_service_query_input"); }
      if (input.capability === "mcp") {
        const binding = mcpScopes.find(scope => scope.serviceKey === input.service && scope.environmentKey === input.environment)?.tools.find(tool => tool.name === input.tool);
        if (!binding) throw new Error("service_capability_not_available");
        return binding.call(input.input as Record<string, unknown>, signal);
      }
      const scope = scopes.find(scope => scope.serviceKey === input.service && scope.environmentKey === input.environment);
      const capability = input.capability as CapabilityName;
      if (!scope || !context.capabilities.includes(capability) || !scope.config[capability]) throw new Error("service_capability_not_available");
      return runTool(scope.config, capability, input as unknown as CapabilityInputs[CapabilityName], signal, outputStore);
    },
  })];
}
