import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, getAgentDir, getPackageDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AGENT_PI_SETTING_KEYS, type AgentRuntimeConfiguration } from "../domain/contracts.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
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
const runtimeSchema = Type.Object({ settings: Type.Optional(agentPiSettingsSchema) }, { additionalProperties: false });
export class AgentRuntimeConfigurationError extends Error {}
export function parseAgentRuntime(value: unknown): AgentRuntimeConfiguration {
  if (!Value.Check(runtimeSchema, value)) throw new AgentRuntimeConfigurationError("invalid_agent_runtime_configuration");
  return structuredClone(value) as AgentRuntimeConfiguration;
}
export const agentResourceDirectory = path.resolve(projectRoot, issuePilotConfig.runtime.agent.resourceDirectory);
export async function agentResources(directory?: string) {
  const roots = { skills: [] as string[], prompts: [] as string[], extensions: [] as string[], instructions: "" };
  if (!directory || !existsSync(directory)) return roots;
  for (const kind of ["skills", "prompts"] as const) {
    const location = path.join(directory, kind);
    if (existsSync(location)) roots[kind].push(location);
  }
  const discovered = await new DefaultPackageManager({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }) }).resolve();
  const extensionRoot = path.join(directory, "extensions");
  roots.extensions = discovered.extensions.filter(extension => {
    const relative = path.relative(extensionRoot, extension.path);
    return extension.enabled && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }).map(extension => extension.path);
  const append = path.join(directory, "APPEND_SYSTEM.md");
  if (existsSync(append)) roots.instructions = await readFile(append, "utf8");
  return roots;
}
export async function inspectAgentResources(directory = agentResourceDirectory) {
  const resources = await agentResources(directory);
  const loader = new DefaultResourceLoader({
    cwd: projectRoot, agentDir: getAgentDir(), settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: resources.skills, additionalPromptTemplatePaths: resources.prompts, systemPrompt: "", appendSystemPrompt: [],
  });
  await loader.reload();
  const skills = loader.getSkills(), prompts = loader.getPrompts();
  return {
    directory,
    skills: skills.skills.map(skill => ({ name: skill.name, description: skill.description, path: skill.filePath })),
    prompts: prompts.prompts.map(prompt => ({ name: prompt.name, description: prompt.description, path: prompt.filePath })),
    extensions: resources.extensions,
    hasAdditionalInstructions: Boolean(resources.instructions),
    diagnostics: [...skills.diagnostics, ...prompts.diagnostics].map(diagnostic => ({ type: diagnostic.type, path: diagnostic.path, message: diagnostic.message })),
  };
}
