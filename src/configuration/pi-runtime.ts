import { readFileSync } from "node:fs";
import path from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, getAgentDir, getPackageDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AGENT_PI_SETTING_KEYS, type AgentRuntimeConfiguration } from "../domain/contracts.ts";
type SettingsSchema = Record<string, unknown> & { properties?: Record<string, SettingsSchema>; patternProperties?: Record<string, SettingsSchema>; anyOf?: SettingsSchema[] };
const nativeSchema = JSON.parse(readFileSync(path.join(getPackageDir(), "schemas/settings.schema.json"), "utf8")) as { properties: Record<string, SettingsSchema> };
// Keep the SDK's field contracts, reject unknown/deprecated settings, and bound numeric budgets.
function exactSchema(schema: SettingsSchema): TSchema {
  const result = structuredClone(schema) as Record<string, unknown>;
  if (result.type === "number") result.minimum = Math.max(0, typeof result.minimum === "number" ? result.minimum : 0);
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties).filter(([, value]) => !value.deprecated).map(([key, value]) => [key, exactSchema(value)]));
    result.additionalProperties = false;
  }
  if (schema.patternProperties) result.patternProperties = Object.fromEntries(Object.entries(schema.patternProperties).map(([key, value]) => [key, exactSchema(value)]));
  if (schema.anyOf) result.anyOf = schema.anyOf.map(exactSchema);
  return Type.Unsafe(result);
}
const settingProperties = Object.fromEntries(AGENT_PI_SETTING_KEYS.map(key => [key, Type.Optional(exactSchema(nativeSchema.properties[key]!))]));
settingProperties.codemode = Type.Optional(Type.Object({ inlineBudget: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false }));
export const agentPiSettingsSchema = Type.Object(settingProperties, { additionalProperties: false });
const runtimeSchema = Type.Object({ settings: Type.Optional(agentPiSettingsSchema), networkAllowedDomains: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
export class AgentRuntimeConfigurationError extends Error {}
export function parseAgentRuntime(value: unknown): AgentRuntimeConfiguration {
  if (!Value.Check(runtimeSchema, value)) throw new AgentRuntimeConfigurationError("invalid_agent_runtime_configuration");
  const runtime = structuredClone(value) as AgentRuntimeConfiguration;
  if (runtime.networkAllowedDomains && !NetworkConfigSchema.safeParse({ allowedDomains: runtime.networkAllowedDomains, deniedDomains: [] }).success) throw new AgentRuntimeConfigurationError("invalid_agent_runtime_configuration");
  return runtime;
}
export async function inspectAgentResources(directory = getAgentDir()) {
  const settingsManager = SettingsManager.create(directory, directory, { projectTrusted: false });
  const discovered = await new DefaultPackageManager({ cwd: directory, agentDir: directory, settingsManager }).resolve();
  // Inspection discovers extension paths without executing user code in an HTTP GET.
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noThemes: true });
  await loader.reload();
  const skills = loader.getSkills(), prompts = loader.getPrompts();
  return {
    directory,
    skills: skills.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.filePath })),
    prompts: prompts.prompts.map(prompt => ({ name: prompt.name, description: prompt.description, path: prompt.filePath })),
    extensions: discovered.extensions.filter(extension => extension.enabled).map(extension => extension.path),
    hasAdditionalInstructions: Boolean(loader.getSystemPrompt() || loader.getAppendSystemPrompt().length || loader.getAgentsFiles().agentsFiles.length),
    diagnostics: [...skills.diagnostics, ...prompts.diagnostics].map(diagnostic => ({ type: diagnostic.type, path: diagnostic.path, message: diagnostic.message })),
  };
}
