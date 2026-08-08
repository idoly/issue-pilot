import { Button, Input, Modal, Select, TextArea } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, createStore, For, Show } from "solid-js";

import { GitBranch, Pencil, Plus, Trash2 } from "../ui/icons";
import { createService, deleteService, updateService, type AgentConfiguration, type AgentModelDefinition, type CapabilityConfiguration, type CapabilityName, type Config, type Service } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { useApplicationResources } from "./ApplicationResources";
import { selectedChoice } from "./IssueForm";

function serviceSaveErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    invalid_db_password: "请填写数据库密码",
    invalid_sls_access_key_secret: "请填写 SLS AccessKeySecret",
    invalid_mq_password: "请填写 RabbitMQ 密码",
    service_has_running_issues: "该服务有正在处理的工单，请等待处理结束或先中止 Agent",
  };
  return messages[code] ?? code;
}

type RepositoryKind = Service["repositories"][number]["kind"];

interface ServiceDeploymentDraft extends CapabilityConfiguration {
  environmentKey: string;
  baseBranch: string;
  capabilities: CapabilityName[];
  agent: AgentConfiguration;
  nacos?: NonNullable<CapabilityConfiguration["nacos"]> & { password: string };
  playwright?: NonNullable<CapabilityConfiguration["playwright"]> & { password: string };
  redis?: NonNullable<CapabilityConfiguration["redis"]> & { password: string };
  es?: NonNullable<CapabilityConfiguration["es"]> & { password: string };
}

function cloneDeploymentDraft(deployment: ServiceDeploymentDraft): ServiceDeploymentDraft {
  return {
    environmentKey: deployment.environmentKey,
    baseBranch: deployment.baseBranch,
    capabilities: [...deployment.capabilities],
    agent: { ...deployment.agent },
    ...(deployment.nacos ? { nacos: { ...deployment.nacos } } : {}),
    ...(deployment.db ? { db: { ...deployment.db } } : {}),
    ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
    ...(deployment.playwright ? { playwright: { ...deployment.playwright } } : {}),
    ...(deployment.redis ? { redis: { ...deployment.redis } } : {}),
    ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
    ...(deployment.es ? { es: { ...deployment.es } } : {}),
  };
}

function ServiceRepositoryEditorRow(props: {
  index: number;
  repository: { id?: string; kind: RepositoryKind; url: string };
  only: boolean;
  onChange: (repository: { kind: RepositoryKind; url: string }) => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = createSignal(props.repository.url, { ownedWrite: true });
  return <div class="service-repository-row"><Input aria-label={`仓库地址 ${props.index + 1}`} placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => { const next = event.currentTarget.value; setUrl(next); props.onChange({ kind: props.repository.kind, url: next }); }} /><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除仓库${props.index + 1}`} aria-label={`删除仓库${props.index + 1}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

function CapabilityLabels(props: { catalog: Config["capabilityCatalog"]; keys: CapabilityName[] }) {
  const entries = () => props.catalog.filter((capability) => props.keys.includes(capability.key));
  return <div class="capability-labels"><For each={entries()}>{(capability) => <code>{capability.key}</code>}</For></div>;
}

function ServiceDeploymentEditorRow(props: {
  index: number;
  deployment: ServiceDeploymentDraft;
  capabilityCatalog: Config["capabilityCatalog"];
  agentModels: AgentModelDefinition[];
  environmentOptions: () => Config["environments"];
  onChange: (deployment: ServiceDeploymentDraft) => void;
  onDelete: () => void;
}) {
  let currentDeployment = cloneDeploymentDraft(props.deployment);
  const [environmentKey, setEnvironmentKey] = createSignal(props.deployment.environmentKey, { ownedWrite: true });
  const [baseBranch, setBaseBranch] = createSignal(props.deployment.baseBranch, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...props.deployment.capabilities], { ownedWrite: true });
  const [agentDraft, setAgentDraft] = createSignal<AgentConfiguration>({ ...props.deployment.agent }, { ownedWrite: true });
  const [nacosDraft, setNacosDraft] = createSignal({ serverUrl: props.deployment.nacos?.serverUrl ?? "", namespace: props.deployment.nacos?.namespace ?? "", group: props.deployment.nacos?.group ?? "DEFAULT_GROUP", dataIds: props.deployment.nacos?.dataIds?.join(", ") ?? "", username: props.deployment.nacos?.username ?? "", password: props.deployment.nacos?.password ?? "" }, { ownedWrite: true });
  const [dbDraft, setDbDraft] = createSignal({ url: props.deployment.db?.url ?? "", username: props.deployment.db?.username ?? "", password: props.deployment.db?.password ?? "" }, { ownedWrite: true });
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: props.deployment.sls?.accessKeyId ?? "", accessKeySecret: props.deployment.sls?.accessKeySecret ?? "", region: props.deployment.sls?.region ?? "", project: props.deployment.sls?.project ?? "", logstores: props.deployment.sls?.logstores.join(", ") ?? "" }, { ownedWrite: true });
  const [playwrightDraft, setPlaywrightDraft] = createSignal({ baseUrl: props.deployment.playwright?.baseUrl ?? "", username: props.deployment.playwright?.username ?? "", password: props.deployment.playwright?.password ?? "" }, { ownedWrite: true });
  const [redisDraft, setRedisDraft] = createSignal({ host: props.deployment.redis?.host ?? "", port: String(props.deployment.redis?.port ?? 6379), username: props.deployment.redis?.username ?? "", password: props.deployment.redis?.password ?? "", database: String(props.deployment.redis?.database ?? 0) }, { ownedWrite: true });
  const [mqDraft, setMqDraft] = createSignal({ host: props.deployment.mq?.host ?? "", port: String(props.deployment.mq?.port ?? 5672), managementPort: String(props.deployment.mq?.managementPort ?? 15672), username: props.deployment.mq?.username ?? "", password: props.deployment.mq?.password ?? "", virtualHost: props.deployment.mq?.virtualHost ?? "/" }, { ownedWrite: true });
  const [esDraft, setEsDraft] = createSignal({ url: props.deployment.es?.url ?? "", username: props.deployment.es?.username ?? "", password: props.deployment.es?.password ?? "" }, { ownedWrite: true });
  const agent = (value = agentDraft()) => ({ ...value, provider: value.provider.trim(), model: value.model.trim() });
  const providerOptions = () => [...new Set(props.agentModels.map((model) => model.provider))].map((provider) => ({ value: provider, label: provider }));
  const modelOptions = () => props.agentModels.filter((model) => model.provider === agentDraft().provider);
  const selectedModel = () => props.agentModels.find((model) => model.provider === agentDraft().provider && model.id === agentDraft().model);
  const nacos = (value = nacosDraft()) => ({ ...value, serverUrl: value.serverUrl.trim(), namespace: value.namespace.trim(), group: value.group.trim(), dataIds: [...new Set(value.dataIds.split(",").map((item) => item.trim()).filter(Boolean))], username: value.username.trim() });
  const db = (value = dbDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const sls = (value = slsDraft()) => ({ ...value, accessKeyId: value.accessKeyId.trim(), region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map((item) => item.trim()).filter(Boolean) });
  const playwright = (value = playwrightDraft()) => ({ ...value, baseUrl: value.baseUrl.trim(), username: value.username.trim() });
  const redis = (value = redisDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), username: value.username.trim(), database: Number(value.database) });
  const mq = (value = mqDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), managementPort: Number(value.managementPort), username: value.username.trim(), virtualHost: value.virtualHost.trim() });
  const es = (value = esDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const update = (change: Partial<ServiceDeploymentDraft>) => {
    currentDeployment = { ...currentDeployment, ...change };
    props.onChange(cloneDeploymentDraft(currentDeployment));
  };
  const updateNacos = (change: Partial<ReturnType<typeof nacosDraft>>) => { const next = { ...nacosDraft(), ...change }; setNacosDraft(next); update({ nacos: nacos(next) }); };
  const updateDb = (change: Partial<ReturnType<typeof dbDraft>>) => { const next = { ...dbDraft(), ...change }; setDbDraft(next); update({ db: db(next) }); };
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const next = { ...slsDraft(), ...change }; setSlsDraft(next); update({ sls: sls(next) }); };
  const updatePlaywright = (change: Partial<ReturnType<typeof playwrightDraft>>) => { const next = { ...playwrightDraft(), ...change }; setPlaywrightDraft(next); update({ playwright: playwright(next) }); };
  const updateRedis = (change: Partial<ReturnType<typeof redisDraft>>) => { const next = { ...redisDraft(), ...change }; setRedisDraft(next); update({ redis: redis(next) }); };
  const updateMq = (change: Partial<ReturnType<typeof mqDraft>>) => { const next = { ...mqDraft(), ...change }; setMqDraft(next); update({ mq: mq(next) }); };
  const updateEs = (change: Partial<ReturnType<typeof esDraft>>) => { const next = { ...esDraft(), ...change }; setEsDraft(next); update({ es: es(next) }); };
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const next = [...selectedCapabilities(), key];
    setSelectedCapabilities(next);
    update({ capabilities: next, ...(key === "nacos" ? { nacos: nacos() } : {}), ...(key === "db" ? { db: db() } : {}), ...(key === "sls" ? { sls: sls() } : {}), ...(key === "playwright" ? { playwright: playwright() } : {}), ...(key === "redis" ? { redis: redis() } : {}), ...(key === "mq" ? { mq: mq() } : {}), ...(key === "es" ? { es: es() } : {}) });
  };
  const removeCapability = (key: CapabilityName) => {
    const next = selectedCapabilities().filter((item) => item !== key);
    setSelectedCapabilities(next);
    update({ capabilities: next });
  };
  return (
    <div class="service-deployment-row">
      <label class="deployment-environment"><span class="required-field">环境</span><Select aria-label={`部署环境 ${props.index + 1}`} value={environmentKey()} onChange={(value) => { const options = props.environmentOptions(); const selected = selectedChoice(value, options.map((environment) => environment.key)); if (selected) { setEnvironmentKey(selected); update({ environmentKey: selected }); } }} options={props.environmentOptions().map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
      <label class="deployment-branch"><span class="required-field">分支</span><Input aria-label={`部署分支 ${props.index + 1}`} value={baseBranch()} onInput={(event) => { const next = event.currentTarget.value; setBaseBranch(next); update({ baseBranch: next }); }} /></label>
      <div class="deployment-model"><span>模型</span><button type="button" class="deployment-capability-option selected" aria-pressed="true" disabled>model</button></div>
      <div class="deployment-capabilities"><span>能力</span><div class="deployment-capability-options"><For each={props.capabilityCatalog}>{(capability) => { const selected = () => selectedCapabilities().includes(capability.key); return <button type="button" class={`deployment-capability-option${selected() ? " selected" : ""}`} aria-pressed={selected() ? "true" : "false"} onClick={() => selected() ? removeCapability(capability.key) : addCapability(capability.key)}>{capability.key}</button>; }}</For></div></div>
      <div class="deployment-capability-settings deployment-agent"><div class="capability-settings-head"><code>model</code></div><label><span class="required-field">provider</span><Select aria-label={`model provider ${props.index + 1}`} value={agentDraft().provider} onChange={(value) => { const provider = selectedChoice(value, providerOptions().map((option) => option.value)); if (!provider) return; const model = props.agentModels.find((candidate) => candidate.provider === provider); if (!model) return; const next = { provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" as const : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={providerOptions()} /></label><label><span class="required-field">modelId</span><Select aria-label={`model id ${props.index + 1}`} value={agentDraft().model} onChange={(value) => { const model = modelOptions().find((candidate) => candidate.id === value); if (!model) return; const current = agentDraft(); const next = { ...current, model: model.id, thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={modelOptions().map((model) => ({ value: model.id, label: model.id }))} /></label><label><span class="required-field">thinkingLevel</span><Select aria-label={`model thinkingLevel ${props.index + 1}`} value={agentDraft().thinkingLevel} onChange={(value) => { const selected = selectedChoice(value, selectedModel()?.thinkingLevels ?? []); if (selected) { const next = { ...agentDraft(), thinkingLevel: selected }; setAgentDraft(next); update({ agent: agent(next) }); } }} options={(selectedModel()?.thinkingLevels ?? []).map((value) => ({ value, label: value }))} /></label></div>
      <Show when={selectedCapabilities().includes("nacos")}><div class="deployment-capability-settings deployment-nacos"><div class="capability-settings-head"><code>nacos</code></div><label><span class="required-field">serverUrl</span><Input aria-label={`nacos serverUrl ${props.index + 1}`} value={nacosDraft().serverUrl} onInput={(event) => { updateNacos({ serverUrl: event.currentTarget.value }); }} /></label><label><span>namespace</span><Input aria-label={`nacos namespace ${props.index + 1}`} value={nacosDraft().namespace} onInput={(event) => { updateNacos({ namespace: event.currentTarget.value }); }} /></label><label><span class="required-field">group</span><Input aria-label={`nacos group ${props.index + 1}`} value={nacosDraft().group} onInput={(event) => { updateNacos({ group: event.currentTarget.value }); }} /></label><label><span class="required-field">dataIds</span><Input aria-label={`nacos dataIds ${props.index + 1}`} placeholder="多个 Data ID 用逗号分隔" value={nacosDraft().dataIds} onInput={(event) => { updateNacos({ dataIds: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`nacos username ${props.index + 1}`} value={nacosDraft().username} onInput={(event) => { updateNacos({ username: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`nacos password ${props.index + 1}`}  value={nacosDraft().password} onInput={(event) => { updateNacos({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("db")}><div class="deployment-capability-settings deployment-db"><div class="capability-settings-head"><code>db</code></div><label><span class="required-field">url</span><Input aria-label={`db url ${props.index + 1}`} value={dbDraft().url} onInput={(event) => { updateDb({ url: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`db username ${props.index + 1}`} value={dbDraft().username} onInput={(event) => { updateDb({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`db password ${props.index + 1}`}  value={dbDraft().password} onInput={(event) => { updateDb({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("redis")}><div class="deployment-capability-settings deployment-redis"><div class="capability-settings-head"><code>redis</code></div><label><span class="required-field">host</span><Input aria-label={`redis host ${props.index + 1}`} value={redisDraft().host} onInput={(event) => { updateRedis({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`redis port ${props.index + 1}`} value={redisDraft().port} onInput={(event) => { updateRedis({ port: event.currentTarget.value }); }} /></label><label><span>username</span><Input aria-label={`redis username ${props.index + 1}`} value={redisDraft().username} onInput={(event) => { updateRedis({ username: event.currentTarget.value }); }} /></label><label><span class={redisDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`redis password ${props.index + 1}`} value={redisDraft().password} onInput={(event) => { updateRedis({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">database</span><Input aria-label={`redis database ${props.index + 1}`} value={redisDraft().database} onInput={(event) => { updateRedis({ database: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("mq")}><div class="deployment-capability-settings deployment-mq"><div class="capability-settings-head"><code>mq</code></div><label><span class="required-field">host</span><Input aria-label={`mq host ${props.index + 1}`} value={mqDraft().host} onInput={(event) => { updateMq({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`mq port ${props.index + 1}`} value={mqDraft().port} onInput={(event) => { updateMq({ port: event.currentTarget.value }); }} /></label><label><span class="required-field">managementPort</span><Input aria-label={`mq managementPort ${props.index + 1}`} value={mqDraft().managementPort} onInput={(event) => { updateMq({ managementPort: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`mq username ${props.index + 1}`} value={mqDraft().username} onInput={(event) => { updateMq({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`mq password ${props.index + 1}`} value={mqDraft().password} onInput={(event) => { updateMq({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">virtualHost</span><Input aria-label={`mq virtualHost ${props.index + 1}`} value={mqDraft().virtualHost} onInput={(event) => { updateMq({ virtualHost: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("es")}><div class="deployment-capability-settings deployment-es"><div class="capability-settings-head"><code>es</code></div><label><span class="required-field">url</span><Input aria-label={`es url ${props.index + 1}`} placeholder="http://es.example.com" value={esDraft().url} onInput={(event) => { updateEs({ url: event.currentTarget.value }); }} /></label><label><span class={esDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`es username ${props.index + 1}`} value={esDraft().username} onInput={(event) => { updateEs({ username: event.currentTarget.value }); }} /></label><label><span class={esDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`es password ${props.index + 1}`} value={esDraft().password} onInput={(event) => { updateEs({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("sls")}><div class="deployment-capability-settings deployment-sls"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">accessKeyId</span><Input aria-label={`sls accessKeyId ${props.index + 1}`} value={slsDraft().accessKeyId} onInput={(event) => { updateSls({ accessKeyId: event.currentTarget.value }); }} /></label><label><span class="required-field">accessKeySecret</span><Input.Password autocomplete="off" aria-label={`sls accessKeySecret ${props.index + 1}`} value={slsDraft().accessKeySecret} onInput={(event) => { updateSls({ accessKeySecret: event.currentTarget.value }); }} /></label><label><span class="required-field">region</span><Input aria-label={`sls region ${props.index + 1}`} placeholder="cn-hangzhou" value={slsDraft().region} onInput={(event) => { updateSls({ region: event.currentTarget.value }); }} /></label><label><span class="required-field">project</span><Input aria-label={`sls project ${props.index + 1}`} value={slsDraft().project} onInput={(event) => { updateSls({ project: event.currentTarget.value }); }} /></label><label><span class="required-field">logstore</span><Input aria-label={`sls logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsDraft().logstores} onInput={(event) => { updateSls({ logstores: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("playwright")}><div class="deployment-capability-settings deployment-playwright"><div class="capability-settings-head"><code>playwright</code></div><label><span class="required-field">baseUrl</span><Input aria-label={`playwright baseUrl ${props.index + 1}`} value={playwrightDraft().baseUrl} onInput={(event) => { updatePlaywright({ baseUrl: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`playwright username ${props.index + 1}`} value={playwrightDraft().username} onInput={(event) => { updatePlaywright({ username: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`playwright password ${props.index + 1}`}  value={playwrightDraft().password} onInput={(event) => { updatePlaywright({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除部署${props.index + 1}`} aria-label={`删除部署${props.index + 1}`} onClick={props.onDelete} />
    </div>
  );
}

export function ConfigurationView() {
  const { configuration, configurationError: resourceError, refreshConfiguration } = useApplicationResources();
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<Array<{ id?: string; kind: RepositoryKind; url: string }>>([{ kind: "backend", url: "" }], { ownedWrite: true });
  const [serviceDeployments, setServiceDeployments] = createStore<ServiceDeploymentDraft[]>([]);
  const [editingServiceKey, setEditingServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [selectedServiceKey, setSelectedServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "service"; key: string; name: string } | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const refresh = async () => {
    try {
      const next = await refreshConfiguration();
      if (!next.services.some((service) => service.key === selectedServiceKey())) setSelectedServiceKey(next.services[0]?.key ?? null);
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    }
  };
  createEffect(() => configuration().services, (services) => {
    if (!services.some((service) => service.key === selectedServiceKey())) setSelectedServiceKey(services[0]?.key ?? null);
  });
  const selectedService = createMemo(() => configuration().services.find((service) => service.key === selectedServiceKey()));
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setServiceRepositories([{ kind: "backend", url: "" }]); setServiceDeployments(() => []); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const defaultAgent = (): AgentConfiguration => {
    const model = configuration().agentModels[0];
    return model ? { provider: model.provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]! } : { provider: "", model: "", thinkingLevel: "off" };
  };
  const openServiceEditor = (service: Service) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, kind: repository.kind, url: repository.url })));
    const deployments = service.deployments.map((deployment) => ({
      environmentKey: configuration().environments.find((environment) => environment.id === deployment.environmentId)?.key ?? "",
      baseBranch: deployment.baseBranch,
      capabilities: [...deployment.capabilities],
      agent: deployment.agent ? { ...deployment.agent } : defaultAgent(),
      ...(deployment.nacos ? { nacos: { ...deployment.nacos, dataIds: deployment.nacos.dataIds ?? [], password: deployment.nacos.password ?? "" } } : {}),
      ...(deployment.db ? { db: { ...deployment.db } } : {}),
      ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
      ...(deployment.playwright ? { playwright: { ...deployment.playwright, username: deployment.playwright.username ?? "", password: deployment.playwright.password ?? "" } } : {}),
      ...(deployment.redis ? { redis: { ...deployment.redis, password: deployment.redis.password ?? "" } } : {}),
      ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
      ...(deployment.es ? { es: { ...deployment.es, password: deployment.es.password ?? "" } } : {}),
    })).filter((deployment) => deployment.environmentKey);
    setServiceDeployments(() => deployments.map(cloneDeploymentDraft));
    setConfigurationError(""); setServiceOpen(true);
  };
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length || serviceRepositories().some((repository) => !repository.url.trim())) return "请填写所有仓库地址";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (serviceDeployments.some((deployment) => !deployment.environmentKey || !deployment.baseBranch.trim())) return "请填写所有部署环境和分支";
    if (new Set(serviceDeployments.map((deployment) => deployment.environmentKey)).size !== serviceDeployments.length) return "同一环境只能配置一个部署";
    if (serviceDeployments.some((deployment) => !deployment.agent.provider.trim() || !deployment.agent.model.trim())) return "请配置所有部署模型";
    if (serviceDeployments.some((deployment) => deployment.capabilities.includes("nacos") && !deployment.nacos?.dataIds.length)) return "请填写 Nacos dataIds";
    return "";
  };
  const availableDeploymentEnvironments = createMemo(() => configuration().environments.filter((environment) => !serviceDeployments.some((deployment) => deployment.environmentKey === environment.key)));
  const addServiceDeployment = () => {
    const environment = availableDeploymentEnvironments()[0];
    if (environment) {
      const deployment = { environmentKey: environment.key, baseBranch: "main", capabilities: [], agent: defaultAgent() } satisfies ServiceDeploymentDraft;
      setServiceDeployments((current) => [...current, cloneDeploymentDraft(deployment)]);
    }
  };
  const saveService = async () => {
    const validationError = serviceValidationError();
    if (validationError) { setConfigurationError(validationError); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), kind: repository.kind, url: repository.url.trim() })),
        deployments: serviceDeployments.map((deployment) => ({ environmentKey: deployment.environmentKey, baseBranch: deployment.baseBranch.trim(), capabilities: deployment.capabilities, agent: { provider: deployment.agent.provider.trim(), model: deployment.agent.model.trim(), thinkingLevel: deployment.agent.thinkingLevel }, ...(deployment.capabilities.includes("nacos") && deployment.nacos ? { nacos: { serverUrl: deployment.nacos.serverUrl.trim(), namespace: deployment.nacos.namespace.trim(), group: deployment.nacos.group.trim(), dataIds: deployment.nacos.dataIds, username: deployment.nacos.username.trim(), password: deployment.nacos.password } } : {}), ...(deployment.capabilities.includes("db") && deployment.db ? { db: { url: deployment.db.url.trim(), username: deployment.db.username.trim(), password: deployment.db.password } } : {}), ...(deployment.capabilities.includes("sls") && deployment.sls ? { sls: { accessKeyId: deployment.sls.accessKeyId.trim(), accessKeySecret: deployment.sls.accessKeySecret, region: deployment.sls.region.trim(), project: deployment.sls.project.trim(), logstores: deployment.sls.logstores } } : {}), ...(deployment.capabilities.includes("playwright") && deployment.playwright ? { playwright: { baseUrl: deployment.playwright.baseUrl.trim(), username: deployment.playwright.username.trim(), password: deployment.playwright.password } } : {}), ...(deployment.capabilities.includes("redis") && deployment.redis ? { redis: { host: deployment.redis.host.trim(), port: deployment.redis.port, username: deployment.redis.username.trim(), password: deployment.redis.password, database: deployment.redis.database } } : {}), ...(deployment.capabilities.includes("mq") && deployment.mq ? { mq: { host: deployment.mq.host.trim(), port: deployment.mq.port, managementPort: deployment.mq.managementPort, username: deployment.mq.username.trim(), password: deployment.mq.password, virtualHost: deployment.mq.virtualHost.trim() } } : {}), ...(deployment.capabilities.includes("es") && deployment.es ? { es: { url: deployment.es.url.trim(), username: deployment.es.username.trim(), password: deployment.es.password } } : {}) })),
      };
      const editingKey = editingServiceKey();
      if (editingKey) await updateService(editingKey, definition);
      else await createService(definition);
      await refresh();
      setServiceOpen(false); resetServiceForm();
    } catch (error) {
      setConfigurationError(serviceSaveErrorMessage(error));
    } finally { setSaving(false); }
  };
  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setSaving(true); setConfigurationError("");
    try {
      await deleteService(target.key);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  return (
    <main class="configuration-workspace">
      <aside class="environment-panel">
        <div class="config-panel-title"><div><span>咸亨国际</span><h1>配置</h1></div></div>
        <div class="configuration-list-heading"><span>服务</span><Button type="text" shape="circle" icon={<Plus size={16} />} title="添加服务" aria-label="添加服务" onClick={openNewService} /></div>
        <div class="environment-list">
          <For each={configuration().services} fallback={<div class="empty-band">暂无服务</div>}>{(service) => (
            <div class={`environment-entry${selectedServiceKey() === service.key ? " selected" : ""}`}><button type="button" class="environment-item" aria-label={service.name} onClick={() => setSelectedServiceKey(service.key)}><span><strong>{service.name}</strong></span></button></div>
          )}</For>
        </div>

      </aside>
      <section class="service-panel">
        <Show when={resourceError()}><div class="workspace-error" role="alert">{resourceError()}</div></Show>
        <Show when={selectedService()} fallback={<><header class="service-header"><div><span>服务配置</span><h2>暂无服务</h2></div><Button type="primary" icon={<Plus size={15} />} onClick={openNewService}>添加服务</Button></header><div class="empty-band">先创建服务，再配置环境部署</div></>}>
          {(service) => <>
            <header class="service-header">
              <div><span>服务配置 · {service().repositories.length} 个仓库 · {service().deployments.length} 个部署</span><h2>{service().name}</h2></div>
              <Button icon={<Pencil size={14} />} onClick={() => openServiceEditor(service())}>编辑服务</Button>
            </header>
            <div class="service-detail">
              <section class="service-detail-section"><div class="service-detail-heading"><h3>代码仓库</h3><span>{service().repositories.length} 个授权根目录</span></div><div class="detail-repositories"><div class="repository-detail-head"><span>仓库地址</span></div><For each={service().repositories}>{(repository) => <div class="repository-detail-row"><GitBranch size={15} /><code title={repository.url}>{repository.url}</code></div>}</For></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>环境部署</h3><span>{service().deployments.length} 个环境</span></div><div class="deployment-detail-list"><Show when={service().deployments.length} fallback={<div class="service-detail-empty">尚未配置环境部署</div>}><div class="deployment-detail-head"><span>环境</span><span>分支</span><span>模型</span><span>能力</span></div><For each={service().deployments}>{(deployment) => { const environment = configuration().environments.find((item) => item.id === deployment.environmentId); return <div class="deployment-detail-row"><div data-label="环境"><strong>{environment?.name ?? deployment.environmentId}</strong></div><div data-label="分支"><code>{deployment.baseBranch}</code></div><div data-label="模型"><Show when={deployment.agent} fallback={<span class="capability-empty">未配置</span>}>{(agent) => <code>{agent().provider}/{agent().model} · {agent().thinkingLevel}</code>}</Show></div><div data-label="能力"><Show when={deployment.capabilities.length} fallback={<span class="capability-empty">无外部能力</span>}><CapabilityLabels catalog={configuration().capabilityCatalog} keys={deployment.capabilities} /></Show></div></div>; }}</For></Show></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>项目描述</h3></div><Show when={service().description.trim()} fallback={<div class="service-detail-empty">暂无项目描述</div>}><Markdown source={service().description} /></Show></section>
            </div>
          </>}
        </Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">代码仓库</strong><span>服务可以关联一个或多个 Git 仓库</span></div><Button icon={<Plus size={14} />} onClick={() => setServiceRepositories((current) => [...current, { kind: "backend", url: "" }])}>添加仓库</Button></div><div class="service-repository-editor"><For each={serviceRepositories()}>{(repository, index) => <ServiceRepositoryEditorRow index={index()} repository={repository} only={serviceRepositories().length === 1} onChange={(next) => setServiceRepositories((current) => { Object.assign(repository, next); return [...current]; })} onDelete={() => setServiceRepositories((current) => current.filter((item) => item !== repository))} />}</For></div></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>配置分支和 pi 按需使用的外部能力</span></div><Button icon={<Plus size={14} />} disabled={!availableDeploymentEnvironments().length} onClick={addServiceDeployment}>添加部署</Button></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow index={index()} deployment={deployment} capabilityCatalog={configuration().capabilityCatalog} agentModels={configuration().agentModels} environmentOptions={() => configuration().environments.filter((environment) => environment.key === deployment.environmentKey || !serviceDeployments.some((item) => item !== deployment && item.environmentKey === environment.key))} onChange={(next) => setServiceDeployments((current) => current.map((item, itemIndex) => itemIndex === index() ? cloneDeploymentDraft(next) : item))} onDelete={() => setServiceDeployments((current) => current.filter((_, itemIndex) => itemIndex !== index()))} />}</For></div></div>
          <label class="service-form-field"><span>项目描述（Markdown）</span><TextArea aria-label="项目描述" autoSize={{ minRows: 5, maxRows: 10 }} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
          <Show when={editingServiceKey()}><div class="destructive-action"><Button danger icon={<Trash2 size={14} />} onClick={() => { setServiceOpen(false); setDeleteTarget({ kind: "service", key: editingServiceKey()!, name: serviceName() }); }}>删除服务</Button></div></Show>
        </div>
      </Modal>
      <Modal open={Boolean(deleteTarget())} title="删除服务" okText="确认删除" cancelText="取消" confirmLoading={saving()} okButtonProps={{ danger: true }} onOk={() => { void confirmDelete(); }} onCancel={() => { setDeleteTarget(null); setConfigurationError(""); }}>
        <p>确定删除“{deleteTarget()?.name}”吗？已被工单使用的配置不能删除。</p>
        <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
      </Modal>
    </main>
  );
}
