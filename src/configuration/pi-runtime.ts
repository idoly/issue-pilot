import { readFileSync } from "node:fs";
import path from "node:path";
import { DefaultPackageManager, DefaultResourceLoader, getAgentDir, getPackageDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { compile, num, obj, opt, unknown, type Schema } from "@earendil-works/pi-schema";
import { AGENT_PI_SETTING_KEYS, type AgentPiSettings, type AgentRuntimeConfiguration } from "../domain/contracts.ts";
import { parseAllowedDomains } from "./parameters.ts";
type SettingsSchema = Record<string, unknown> & { properties?: Record<string, SettingsSchema>; patternProperties?: Record<string, SettingsSchema>; anyOf?: SettingsSchema[] };
const nativeSchema = JSON.parse(readFileSync(path.join(getPackageDir(), "schemas/settings.schema.json"), "utf8")) as { properties: Record<string, SettingsSchema> };
// Keep the SDK's field contracts, reject unknown/deprecated settings, and bound numeric budgets.
function exactSchema(schema: SettingsSchema): Schema {
  const result = structuredClone(schema) as Record<string, unknown>;
  if (result.type === "number") result.minimum = Math.max(0, typeof result.minimum === "number" ? result.minimum : 0);
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([, value]) => !value.deprecated)
        .map(([key, value]) => [key, exactSchema(value)]),
    );
    result.additionalProperties = false;
  }
  if (schema.patternProperties) result.patternProperties = Object.fromEntries(Object.entries(schema.patternProperties).map(([key, value]) => [key, exactSchema(value)]));
  if (schema.anyOf) result.anyOf = schema.anyOf.map(exactSchema);
  return result;
}
const settingProperties = Object.fromEntries(AGENT_PI_SETTING_KEYS.map((key) => [key, opt(exactSchema(nativeSchema.properties[key]!))]));
settingProperties.codemode = opt(obj({ inlineBudget: opt(num({ minimum: 0 })) }));
const agentPiSettingsSchema = obj(settingProperties);
// Domain entries are validated by parseAllowedDomains so this list shares the admin parameter rules.
const validateRuntime = compile(obj({ settings: opt(agentPiSettingsSchema), networkAllowedDomains: opt(unknown()) }));
export class AgentRuntimeConfigurationError extends Error {}
export function parseAgentRuntime(value: unknown): AgentRuntimeConfiguration {
  if (!validateRuntime.check(value)) throw new AgentRuntimeConfigurationError("invalid_agent_runtime_configuration");
  const input = value as { settings?: AgentPiSettings; networkAllowedDomains?: unknown };
  const runtime: AgentRuntimeConfiguration = {};
  if (input.settings !== undefined) runtime.settings = structuredClone(input.settings);
  if (input.networkAllowedDomains !== undefined) {
    try {
      runtime.networkAllowedDomains = [...parseAllowedDomains(input.networkAllowedDomains)];
    } catch {
      throw new AgentRuntimeConfigurationError("invalid_agent_runtime_configuration");
    }
  }
  return runtime;
}
export async function inspectAgentResources(directory = getAgentDir()) {
  const settingsManager = SettingsManager.create(directory, directory, { projectTrusted: false });
  // Inspection must not install packages: npm/git installs run package scripts during an HTTP GET.
  const missingPackages: string[] = [];
  const discovered = await new DefaultPackageManager({ cwd: directory, agentDir: directory, settingsManager }).resolve(async (source) => {
    missingPackages.push(source);
    return "skip";
  });
  const packageResources = (resources: typeof discovered.skills) => resources.filter((resource) => resource.enabled && resource.metadata.origin === "package").map((resource) => resource.path);
  // The loader resolves packages without an install policy, so give it settings without packages plus the resources resolved above.
  const { packages: _packages, ...settings } = settingsManager.getGlobalSettings();
  // Inspection discovers extension paths without executing user code in an HTTP GET.
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(settings, { projectTrusted: false }),
    additionalSkillPaths: packageResources(discovered.skills),
    additionalPromptTemplatePaths: packageResources(discovered.prompts),
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  const skills = loader.getSkills(),
    prompts = loader.getPrompts();
  return {
    directory,
    skills: skills.skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath })),
    prompts: prompts.prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, path: prompt.filePath })),
    extensions: discovered.extensions.filter((extension) => extension.enabled).map((extension) => extension.path),
    hasAdditionalInstructions: Boolean(loader.getSystemPrompt() || loader.getAppendSystemPrompt().length || loader.getAgentsFiles().agentsFiles.length),
    diagnostics: [
      ...missingPackages.map((source) => ({ type: "warning" as const, path: source, message: "package_not_installed" })),
      ...[...skills.diagnostics, ...prompts.diagnostics].map((diagnostic) => ({ type: diagnostic.type, path: diagnostic.path, message: diagnostic.message })),
    ],
  };
}
