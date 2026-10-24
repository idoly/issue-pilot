import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { structuredJsonResult } from "../capabilities/contracts.ts";
import { DmsOperationError, queryDms } from "../capabilities/dms.ts";
import { capabilityToolInputSchema, type CapabilityInputs } from "../capabilities/registry.ts";
import { readSlsLogs } from "../capabilities/sls.ts";
import type { IssueWorkFileStore } from "../workspace/work-files.ts";
import type { AgentSessionContext } from "./context.ts";
import type { CapabilityName, DeploymentConfig } from "../domain/contracts.ts";

export interface ServiceToolScope { environmentKey: string; serviceKey: string; serviceName: string; config: DeploymentConfig }

export function createCapabilityTools(context: Pick<AgentSessionContext, "serviceKey" | "environmentKey" | "capabilities">, deploymentConfig: DeploymentConfig, options: { workFiles?: IssueWorkFileStore | undefined; serviceScopes?: ServiceToolScope[] | undefined } = {}): ToolDefinition<any, any, any>[] {
  const { workFiles, serviceScopes } = options;
  const scopes = structuredClone(serviceScopes ?? [{ environmentKey: context.environmentKey, serviceKey: context.serviceKey, serviceName: context.serviceKey, config: deploymentConfig }]);
  const schemas: TSchema[] = [];
  for (const scope of scopes) for (const capability of context.capabilities) {
    if (!scope.config[capability]) continue;
    const schema = capabilityToolInputSchema(capability, scope.config[capability]!, { exportEnabled: Boolean(workFiles) && capability === "dms" });
    const union = schema as unknown as { anyOf?: TSchema[] };
    const variants = Array.isArray(union.anyOf) ? union.anyOf : [schema];
    for (const variant of variants) schemas.push(Type.Object({ environment: Type.Literal(scope.environmentKey), service: Type.Literal(scope.serviceKey, { description: scope.serviceName }), capability: Type.Literal(capability), ...(variant as unknown as { properties: Record<string, TSchema> }).properties }, { additionalProperties: false }));
  }
  if (!schemas.length) return [];
  const schema = schemas.length === 1 ? schemas[0]! : Type.Union(schemas);
  const validateInput = Compile(schema);
  return [defineTool({
    name: "service_query", label: "Query service evidence", parameters: schema, outputSchema: Type.Unknown(),
    description: "Query evidence from a configured environment and service. Development Issues can read production/test sources; other Issues stay in their own environment. Use workspace list/describe to read service investigation notes before choosing a capability. Credentials and targets are injected by the server. Native operations remain read-only. External MCP servers expose separate tools through Pi.",
    promptGuidelines: [
      "When codemode is enabled, service_query resolves to structured JSON data. Batch independent non-DMS evidence reads with Promise.allSettled and return only the fields needed for the answer. Await calls that depend on an earlier result or write the same file.",
      "Run DMS batches serially with spacing. Adjust batch size and spacing from observed latency and failures; do not assume a fixed request quota. On DMS failure, the error JSON contains error and diagnostics (phase, elapsedMs, phaseElapsedMs, sqlDispatchAttempted, optional retryAfterSeconds). A dispatch attempt does not prove server execution. Honor retryAfterSeconds when present; otherwise use bounded backoff. Never automatically replay SQL with an unknown result.",
    ],
    execute: async (_id, raw, signal): Promise<AgentToolResult<unknown>> => {
      signal?.throwIfAborted();
      if (!validateInput.Check(raw)) throw new Error("invalid_service_query_input");
      const input = raw as Record<string, unknown>;
      const scope = scopes.find(scope => scope.serviceKey === input.service && scope.environmentKey === input.environment);
      const capability = input.capability as CapabilityName;
      if (!scope || !context.capabilities.includes(capability) || !scope.config[capability]) throw new Error("service_capability_not_available");
      try {
        const result: AgentToolResult<unknown> = capability === "dms"
          ? await queryDms(input as CapabilityInputs["dms"], scope.config.dms!, signal, undefined, workFiles)
          : await readSlsLogs(input as CapabilityInputs["sls"], scope.config.sls!, signal);
        return structuredJsonResult(result);
      } catch (error) {
        if (!(error instanceof DmsOperationError)) throw error;
        // Only expose stable codes and measured metadata, never the SDK error or its cause.
        throw new Error(JSON.stringify({ error: error.message, diagnostics: error.diagnostics }));
      }
    },
  })];
}
