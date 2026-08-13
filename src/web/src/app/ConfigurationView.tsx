import { Button, Input, Modal, Segmented, Select, TextArea } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, createStore, For, Match, Show, Switch, untrack } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { GitBranch, Pencil, Plus, Trash2 } from "../ui/icons";
import { createService, deleteService, errorMessage, updateService, type AgentConfiguration, type AgentModelOption, type CapabilityConfiguration, type CapabilityName, type Config, type Service } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { serializeCapabilityDraft } from "./configuration-model";
import { useApplicationResources } from "./ApplicationResources";
import { selectedChoice } from "./IssueForm";

function serviceSaveErrorMessage(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    invalid_db_password: "请填写数据库密码",
    invalid_dms_access_key_id: "请填写 DMS AccessKeyId",
    invalid_dms_access_key_secret: "请填写 DMS AccessKeySecret",
    invalid_dms_db_id: "请填写 DMS dbId",
    invalid_dms_scope: "DMS dbId、库类型或 tid 无效",
    invalid_sls_access_key_secret: "请填写 SLS AccessKeySecret",
    invalid_mq_password: "请填写 RabbitMQ 密码",
    invalid_repository: "仓库标识无效，请刷新配置后重试",
    duplicate_repository_alias: "仓库别名不能重复",
    invalid_deployment_repository_branches: "请为每个环境配置全部仓库分支",
    service_has_running_issues: "该服务有正在处理的工单，请等待处理结束或先中止 Agent",
  };
  return messages[code] ?? code;
}

interface ServiceRepositoryDraft {
  id?: string;
  key: string;
  alias: string;
  url: string;
}

let repositoryDraftSequence = 0;
const newRepositoryDraft = (): ServiceRepositoryDraft => ({ key: `new-${++repositoryDraftSequence}`, alias: "", url: "" });

interface ServiceDeploymentDraft extends CapabilityConfiguration {
  environmentKey: string;
  repositoryBranches: Array<{ repositoryKey: string; baseBranch: string }>;
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
    repositoryBranches: deployment.repositoryBranches.map((branch) => ({ ...branch })),
    capabilities: [...deployment.capabilities],
    agent: { ...deployment.agent },
    ...(deployment.nacos ? { nacos: { ...deployment.nacos, dataIds: [...deployment.nacos.dataIds] } } : {}),
    ...(deployment.db ? { db: { ...deployment.db } } : {}),
    ...(deployment.dms ? { dms: { ...deployment.dms } } : {}),
    ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
    ...(deployment.playwright ? { playwright: { ...deployment.playwright } } : {}),
    ...(deployment.redis ? { redis: { ...deployment.redis } } : {}),
    ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
    ...(deployment.es ? { es: { ...deployment.es } } : {}),
  };
}

function ServiceRepositoryEditorRow(props: {
  index: number;
  repository: ServiceRepositoryDraft;
  only: boolean;
  onChange: (repository: { alias: string; url: string }) => void;
  onDelete: () => void;
}) {
  let currentRepository = { alias: props.repository.alias, url: props.repository.url };
  const [alias, setAlias] = createSignal(currentRepository.alias, { ownedWrite: true });
  const [url, setUrl] = createSignal(currentRepository.url, { ownedWrite: true });
  const update = (change: Partial<typeof currentRepository>) => { currentRepository = { ...currentRepository, ...change }; props.onChange(currentRepository); };
  return <div class="service-repository-row"><Input aria-label={`仓库别名 ${props.index + 1}`} placeholder="orders-api" value={alias()} onInput={(event) => { const next = event.currentTarget.value; setAlias(next); update({ alias: next }); }} /><Input aria-label={`仓库地址 ${props.index + 1}`} placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => { const next = event.currentTarget.value; setUrl(next); update({ url: next }); }} /><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除仓库${props.index + 1}`} aria-label={`删除仓库${props.index + 1}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

function CapabilityLabels(props: { catalog: Config["capabilityCatalog"]; keys: CapabilityName[] }) {
  const capabilities = () => props.catalog.filter((capability) => props.keys.includes(capability.key));
  return <div class="capability-labels"><For each={capabilities()}>{(capability) => <code>{capability.key}</code>}</For></div>;
}

function ServiceDeploymentEditorRow(props: {
  index: number;
  deployment: ServiceDeploymentDraft;
  capabilityCatalog: Config["capabilityCatalog"];
  agentModels: AgentModelOption[];
  environmentOptions: () => Config["environments"];
  repositories: () => ServiceRepositoryDraft[];
  onChange: (deployment: ServiceDeploymentDraft) => void;
  onDelete: () => void;
}) {
  // The row owns its draft after mount; parent updates are emitted through onChange, not reapplied.
  const initialDeployment = untrack(() => cloneDeploymentDraft(props.deployment));
  let currentDeployment = initialDeployment;
  const [environmentKey, setEnvironmentKey] = createSignal(initialDeployment.environmentKey, { ownedWrite: true });
  const [repositoryBranches, setRepositoryBranches] = createSignal(initialDeployment.repositoryBranches, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...initialDeployment.capabilities], { ownedWrite: true });
  const [agentDraft, setAgentDraft] = createSignal<AgentConfiguration>({ ...initialDeployment.agent }, { ownedWrite: true });
  const [nacosDraft, setNacosDraft] = createSignal({ serverUrl: initialDeployment.nacos?.serverUrl ?? "", namespace: initialDeployment.nacos?.namespace ?? "", group: initialDeployment.nacos?.group ?? issuePilotConfig.defaults.nacos.group, dataIds: initialDeployment.nacos?.dataIds?.join(", ") ?? "", username: initialDeployment.nacos?.username ?? "", password: initialDeployment.nacos?.password ?? "" }, { ownedWrite: true });
  const [dbDraft, setDbDraft] = createSignal({ url: initialDeployment.db?.url ?? "", username: initialDeployment.db?.username ?? "", password: initialDeployment.db?.password ?? "" }, { ownedWrite: true });
  let currentDmsDraft = { accessKeyId: initialDeployment.dms?.accessKeyId ?? "", accessKeySecret: initialDeployment.dms?.accessKeySecret ?? "", dbId: initialDeployment.dms?.dbId ?? "", logic: initialDeployment.dms?.logic ?? false, tid: initialDeployment.dms?.tid ?? "" };
  const [dmsDraft, setDmsDraft] = createSignal(currentDmsDraft, { ownedWrite: true });
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: initialDeployment.sls?.accessKeyId ?? "", accessKeySecret: initialDeployment.sls?.accessKeySecret ?? "", region: initialDeployment.sls?.region ?? "", project: initialDeployment.sls?.project ?? "", logstores: initialDeployment.sls?.logstores.join(", ") ?? "" }, { ownedWrite: true });
  const [playwrightDraft, setPlaywrightDraft] = createSignal({ baseUrl: initialDeployment.playwright?.baseUrl ?? "", username: initialDeployment.playwright?.username ?? "", password: initialDeployment.playwright?.password ?? "" }, { ownedWrite: true });
  const [redisDraft, setRedisDraft] = createSignal({ host: initialDeployment.redis?.host ?? "", port: String(initialDeployment.redis?.port ?? issuePilotConfig.defaults.redis.port), username: initialDeployment.redis?.username ?? "", password: initialDeployment.redis?.password ?? "", database: String(initialDeployment.redis?.database ?? issuePilotConfig.defaults.redis.database) }, { ownedWrite: true });
  const [mqDraft, setMqDraft] = createSignal({ host: initialDeployment.mq?.host ?? "", port: String(initialDeployment.mq?.port ?? issuePilotConfig.defaults.rabbitmq.port), managementPort: String(initialDeployment.mq?.managementPort ?? issuePilotConfig.defaults.rabbitmq.managementPort), username: initialDeployment.mq?.username ?? "", password: initialDeployment.mq?.password ?? "", virtualHost: initialDeployment.mq?.virtualHost ?? issuePilotConfig.defaults.rabbitmq.virtualHost }, { ownedWrite: true });
  const [esDraft, setEsDraft] = createSignal({ url: initialDeployment.es?.url ?? "", username: initialDeployment.es?.username ?? "", password: initialDeployment.es?.password ?? "" }, { ownedWrite: true });
  const agent = (value = agentDraft()) => ({ ...value, provider: value.provider.trim(), model: value.model.trim() });
  const providerOptions = () => [...new Set(props.agentModels.map((model) => model.provider))].map((provider) => ({ value: provider, label: provider }));
  const modelOptions = () => props.agentModels.filter((model) => model.provider === agentDraft().provider);
  const selectedModel = () => props.agentModels.find((model) => model.provider === agentDraft().provider && model.id === agentDraft().model);
  const nacos = (value = nacosDraft()) => ({ ...value, serverUrl: value.serverUrl.trim(), namespace: value.namespace.trim(), group: value.group.trim(), dataIds: [...new Set(value.dataIds.split(",").map((item) => item.trim()).filter(Boolean))], username: value.username.trim() });
  const db = (value = dbDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const dms = (value = dmsDraft()) => ({ ...value, accessKeyId: value.accessKeyId.trim(), dbId: value.dbId.trim(), tid: value.tid.trim() });
  const sls = (value = slsDraft()) => ({ ...value, accessKeyId: value.accessKeyId.trim(), region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map((item) => item.trim()).filter(Boolean) });
  const playwright = (value = playwrightDraft()) => ({ ...value, baseUrl: value.baseUrl.trim(), username: value.username.trim() });
  const redis = (value = redisDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), username: value.username.trim(), database: Number(value.database) });
  const mq = (value = mqDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), managementPort: Number(value.managementPort), username: value.username.trim(), virtualHost: value.virtualHost.trim() });
  const es = (value = esDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const update = (change: Partial<ServiceDeploymentDraft>) => {
    currentDeployment = { ...currentDeployment, ...change };
    props.onChange(cloneDeploymentDraft(currentDeployment));
  };
  createEffect(
    () => props.repositories(),
    (repositories) => {
      const current = untrack(repositoryBranches);
      const next = repositories.map((repository) => current.find((branch) => branch.repositoryKey === repository.key) ?? { repositoryKey: repository.key, baseBranch: issuePilotConfig.defaults.deployment.baseBranch });
      if (next.length === current.length && next.every((branch, index) => branch.repositoryKey === current[index]?.repositoryKey && branch.baseBranch === current[index]?.baseBranch)) return;
      setRepositoryBranches(next);
      update({ repositoryBranches: next });
    },
  );
  const updateRepositoryBranch = (repositoryKey: string, baseBranch: string) => {
    const next = repositoryBranches().map((branch) => branch.repositoryKey === repositoryKey ? { ...branch, baseBranch } : branch);
    setRepositoryBranches(next);
    update({ repositoryBranches: next });
  };
  const updateNacos = (change: Partial<ReturnType<typeof nacosDraft>>) => { const draft = { ...nacosDraft(), ...change }; setNacosDraft(draft); update({ nacos: nacos(draft) }); };
  const updateDb = (change: Partial<ReturnType<typeof dbDraft>>) => { const draft = { ...dbDraft(), ...change }; setDbDraft(draft); update({ db: db(draft) }); };
  const updateDms = (change: Partial<ReturnType<typeof dmsDraft>>) => { currentDmsDraft = { ...currentDmsDraft, ...change }; setDmsDraft(currentDmsDraft); update({ dms: dms(currentDmsDraft) }); };
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const draft = { ...slsDraft(), ...change }; setSlsDraft(draft); update({ sls: sls(draft) }); };
  const updatePlaywright = (change: Partial<ReturnType<typeof playwrightDraft>>) => { const draft = { ...playwrightDraft(), ...change }; setPlaywrightDraft(draft); update({ playwright: playwright(draft) }); };
  const updateRedis = (change: Partial<ReturnType<typeof redisDraft>>) => { const draft = { ...redisDraft(), ...change }; setRedisDraft(draft); update({ redis: redis(draft) }); };
  const updateMq = (change: Partial<ReturnType<typeof mqDraft>>) => { const draft = { ...mqDraft(), ...change }; setMqDraft(draft); update({ mq: mq(draft) }); };
  const updateEs = (change: Partial<ReturnType<typeof esDraft>>) => { const draft = { ...esDraft(), ...change }; setEsDraft(draft); update({ es: es(draft) }); };
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const capabilities = [...selectedCapabilities(), key];
    setSelectedCapabilities(capabilities);
    update({ capabilities, ...(key === "nacos" ? { nacos: nacos() } : {}), ...(key === "db" ? { db: db() } : {}), ...(key === "dms" ? { dms: dms() } : {}), ...(key === "sls" ? { sls: sls() } : {}), ...(key === "playwright" ? { playwright: playwright() } : {}), ...(key === "redis" ? { redis: redis() } : {}), ...(key === "mq" ? { mq: mq() } : {}), ...(key === "es" ? { es: es() } : {}) });
  };
  const removeCapability = (key: CapabilityName) => {
    const capabilities = selectedCapabilities().filter((capability) => capability !== key);
    setSelectedCapabilities(capabilities);
    update({ capabilities });
  };
  return (
    <div class="service-deployment-row">
      <label class="deployment-environment"><span class="required-field">环境</span><Select aria-label={`部署环境 ${props.index + 1}`} value={environmentKey()} onChange={(value) => { const options = props.environmentOptions(); const selected = selectedChoice(value, options.map((environment) => environment.key)); if (selected) { setEnvironmentKey(selected); update({ environmentKey: selected }); } }} options={props.environmentOptions().map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
      <div class="deployment-model"><span>模型</span><button type="button" class="deployment-capability-option selected" aria-pressed="true" disabled>model</button></div>
      <div class="deployment-capabilities"><span>能力</span><div class="deployment-capability-options"><For each={props.capabilityCatalog}>{(capability) => { const selected = () => selectedCapabilities().includes(capability.key); return <button type="button" class={`deployment-capability-option${selected() ? " selected" : ""}`} aria-pressed={selected() ? "true" : "false"} onClick={() => selected() ? removeCapability(capability.key) : addCapability(capability.key)}>{capability.key}</button>; }}</For></div></div>
      <div class="deployment-repositories"><div class="capability-settings-head"><code>代码分支</code></div><For each={props.repositories()}>{(repository) => <label><span class="required-field">{repository.alias || "未命名仓库"}</span><Input aria-label={`部署 ${props.index + 1} 仓库 ${repository.alias || repository.key} 分支`} value={repositoryBranches().find((branch) => branch.repositoryKey === repository.key)?.baseBranch ?? ""} onInput={(event) => updateRepositoryBranch(repository.key, event.currentTarget.value)} /></label>}</For></div>
      <div class="deployment-capability-settings deployment-agent"><div class="capability-settings-head"><code>model</code></div><label><span class="required-field">provider</span><Select aria-label={`model provider ${props.index + 1}`} value={agentDraft().provider} onChange={(value) => { const provider = selectedChoice(value, providerOptions().map((option) => option.value)); if (!provider) return; const model = props.agentModels.find((candidate) => candidate.provider === provider); if (!model) return; const next = { provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" as const : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={providerOptions()} /></label><label><span class="required-field">modelId</span><Select aria-label={`model id ${props.index + 1}`} value={agentDraft().model} onChange={(value) => { const model = modelOptions().find((candidate) => candidate.id === value); if (!model) return; const current = agentDraft(); const next = { ...current, model: model.id, thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={modelOptions().map((model) => ({ value: model.id, label: model.id }))} /></label><label><span class="required-field">thinkingLevel</span><Select aria-label={`model thinkingLevel ${props.index + 1}`} value={agentDraft().thinkingLevel} onChange={(value) => { const selected = selectedChoice(value, selectedModel()?.thinkingLevels ?? []); if (selected) { const next = { ...agentDraft(), thinkingLevel: selected }; setAgentDraft(next); update({ agent: agent(next) }); } }} options={(selectedModel()?.thinkingLevels ?? []).map((value) => ({ value, label: value }))} /></label></div>
      <For each={props.capabilityCatalog.filter((capability) => selectedCapabilities().includes(capability.key))}>{(capability) => <Switch>
        <Match when={capability.key === "playwright"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>playwright</code></div><label><span class="required-field">baseUrl</span><Input aria-label={`playwright baseUrl ${props.index + 1}`} value={playwrightDraft().baseUrl} onInput={(event) => { updatePlaywright({ baseUrl: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`playwright username ${props.index + 1}`} value={playwrightDraft().username} onInput={(event) => { updatePlaywright({ username: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`playwright password ${props.index + 1}`}  value={playwrightDraft().password} onInput={(event) => { updatePlaywright({ password: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "nacos"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>nacos</code></div><label><span class="required-field">serverUrl</span><Input aria-label={`nacos serverUrl ${props.index + 1}`} value={nacosDraft().serverUrl} onInput={(event) => { updateNacos({ serverUrl: event.currentTarget.value }); }} /></label><label><span>namespace</span><Input aria-label={`nacos namespace ${props.index + 1}`} value={nacosDraft().namespace} onInput={(event) => { updateNacos({ namespace: event.currentTarget.value }); }} /></label><label><span class="required-field">group</span><Input aria-label={`nacos group ${props.index + 1}`} value={nacosDraft().group} onInput={(event) => { updateNacos({ group: event.currentTarget.value }); }} /></label><label><span class="required-field">dataIds</span><Input aria-label={`nacos dataIds ${props.index + 1}`} placeholder="多个 Data ID 用逗号分隔" value={nacosDraft().dataIds} onInput={(event) => { updateNacos({ dataIds: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`nacos username ${props.index + 1}`} value={nacosDraft().username} onInput={(event) => { updateNacos({ username: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`nacos password ${props.index + 1}`}  value={nacosDraft().password} onInput={(event) => { updateNacos({ password: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "db"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>db</code></div><label><span class="required-field">url</span><Input aria-label={`db url ${props.index + 1}`} value={dbDraft().url} onInput={(event) => { updateDb({ url: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`db username ${props.index + 1}`} value={dbDraft().username} onInput={(event) => { updateDb({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`db password ${props.index + 1}`}  value={dbDraft().password} onInput={(event) => { updateDb({ password: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "dms"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>dms</code></div><label><span class="required-field">accessKeyId</span><Input aria-label={`dms accessKeyId ${props.index + 1}`} value={dmsDraft().accessKeyId} onInput={(event) => { updateDms({ accessKeyId: event.currentTarget.value }); }} /></label><label><span class="required-field">accessKeySecret</span><Input.Password autocomplete="off" aria-label={`dms accessKeySecret ${props.index + 1}`} value={dmsDraft().accessKeySecret} onInput={(event) => { updateDms({ accessKeySecret: event.currentTarget.value }); }} /></label><label><span class="required-field">dbId</span><Input inputmode="numeric" aria-label={`dms dbId ${props.index + 1}`} value={dmsDraft().dbId} onInput={(event) => { updateDms({ dbId: event.currentTarget.value }); }} /></label><label><span>tid</span><Input inputmode="numeric" aria-label={`dms tid ${props.index + 1}`} value={dmsDraft().tid} onInput={(event) => { updateDms({ tid: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span class="required-field">库类型</span><Segmented block aria-label={`dms 库类型 ${props.index + 1}`} value={dmsDraft().logic ? "logical" : "physical"} options={[{ value: "physical", label: "物理库" }, { value: "logical", label: "逻辑库" }]} onChange={(value) => { updateDms({ logic: value === "logical" }); }} /></div></div></Match>
        <Match when={capability.key === "redis"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>redis</code></div><label><span class="required-field">host</span><Input aria-label={`redis host ${props.index + 1}`} value={redisDraft().host} onInput={(event) => { updateRedis({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`redis port ${props.index + 1}`} value={redisDraft().port} onInput={(event) => { updateRedis({ port: event.currentTarget.value }); }} /></label><label><span>username</span><Input aria-label={`redis username ${props.index + 1}`} value={redisDraft().username} onInput={(event) => { updateRedis({ username: event.currentTarget.value }); }} /></label><label><span class={redisDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`redis password ${props.index + 1}`} value={redisDraft().password} onInput={(event) => { updateRedis({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">database</span><Input aria-label={`redis database ${props.index + 1}`} value={redisDraft().database} onInput={(event) => { updateRedis({ database: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "mq"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>mq</code></div><label><span class="required-field">host</span><Input aria-label={`mq host ${props.index + 1}`} value={mqDraft().host} onInput={(event) => { updateMq({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`mq port ${props.index + 1}`} value={mqDraft().port} onInput={(event) => { updateMq({ port: event.currentTarget.value }); }} /></label><label><span class="required-field">managementPort</span><Input aria-label={`mq managementPort ${props.index + 1}`} value={mqDraft().managementPort} onInput={(event) => { updateMq({ managementPort: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`mq username ${props.index + 1}`} value={mqDraft().username} onInput={(event) => { updateMq({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`mq password ${props.index + 1}`} value={mqDraft().password} onInput={(event) => { updateMq({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">virtualHost</span><Input aria-label={`mq virtualHost ${props.index + 1}`} value={mqDraft().virtualHost} onInput={(event) => { updateMq({ virtualHost: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "es"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>es</code></div><label><span class="required-field">url</span><Input aria-label={`es url ${props.index + 1}`} placeholder="http://es.example.com" value={esDraft().url} onInput={(event) => { updateEs({ url: event.currentTarget.value }); }} /></label><label><span class={esDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`es username ${props.index + 1}`} value={esDraft().username} onInput={(event) => { updateEs({ username: event.currentTarget.value }); }} /></label><label><span class={esDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`es password ${props.index + 1}`} value={esDraft().password} onInput={(event) => { updateEs({ password: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "sls"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">accessKeyId</span><Input aria-label={`sls accessKeyId ${props.index + 1}`} value={slsDraft().accessKeyId} onInput={(event) => { updateSls({ accessKeyId: event.currentTarget.value }); }} /></label><label><span class="required-field">accessKeySecret</span><Input.Password autocomplete="off" aria-label={`sls accessKeySecret ${props.index + 1}`} value={slsDraft().accessKeySecret} onInput={(event) => { updateSls({ accessKeySecret: event.currentTarget.value }); }} /></label><label><span class="required-field">region</span><Input aria-label={`sls region ${props.index + 1}`} placeholder="cn-hangzhou" value={slsDraft().region} onInput={(event) => { updateSls({ region: event.currentTarget.value }); }} /></label><label><span class="required-field">project</span><Input aria-label={`sls project ${props.index + 1}`} value={slsDraft().project} onInput={(event) => { updateSls({ project: event.currentTarget.value }); }} /></label><label><span class="required-field">logstore</span><Input aria-label={`sls logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsDraft().logstores} onInput={(event) => { updateSls({ logstores: event.currentTarget.value }); }} /></label></div></Match>
      </Switch>}</For>
      <Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除部署${props.index + 1}`} aria-label={`删除部署${props.index + 1}`} onClick={props.onDelete} />
    </div>
  );
}

export function ConfigurationView() {
  const { configuration, configurationError: resourceError, refreshConfiguration } = useApplicationResources();
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<ServiceRepositoryDraft[]>([newRepositoryDraft()], { ownedWrite: true });
  const [serviceDeployments, setServiceDeployments] = createStore<ServiceDeploymentDraft[]>([]);
  const [editingServiceKey, setEditingServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [selectedServiceKey, setSelectedServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "service"; key: string; name: string } | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const refresh = async () => {
    try {
      const refreshed = await refreshConfiguration();
      if (!refreshed.services.some((service) => service.key === selectedServiceKey())) setSelectedServiceKey(refreshed.services[0]?.key ?? null);
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(errorMessage(error));
    }
  };
  createEffect(
    () => {
      const services = configuration().services;
      const selectedKey = selectedServiceKey();
      return { fallbackKey: services[0]?.key ?? null, selectedExists: services.some((service) => service.key === selectedKey) };
    },
    ({ fallbackKey, selectedExists }) => { if (!selectedExists) setSelectedServiceKey(fallbackKey); },
  );
  const selectedService = createMemo(() => configuration().services.find((service) => service.key === selectedServiceKey()));
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setServiceRepositories([newRepositoryDraft()]); setServiceDeployments(() => []); setEditingServiceKey(null);
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
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, key: repository.id, alias: repository.alias, url: repository.url })));
    const deployments = service.deployments.map((deployment) => ({
      environmentKey: deployment.environmentKey,
      repositoryBranches: deployment.repositoryBranches.map((branch) => ({ repositoryKey: branch.repositoryId, baseBranch: branch.baseBranch })),
      capabilities: [...deployment.capabilities],
      agent: deployment.agent ? { ...deployment.agent } : defaultAgent(),
      ...(deployment.nacos ? { nacos: { ...deployment.nacos, dataIds: deployment.nacos.dataIds ?? [], password: deployment.nacos.password ?? "" } } : {}),
      ...(deployment.db ? { db: { ...deployment.db } } : {}),
      ...(deployment.dms ? { dms: { ...deployment.dms } } : {}),
      ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
      ...(deployment.playwright ? { playwright: { ...deployment.playwright, username: deployment.playwright.username ?? "", password: deployment.playwright.password ?? "" } } : {}),
      ...(deployment.redis ? { redis: { ...deployment.redis, password: deployment.redis.password ?? "" } } : {}),
      ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
      ...(deployment.es ? { es: { ...deployment.es, password: deployment.es.password ?? "" } } : {}),
    })).filter((deployment) => deployment.environmentKey);
    setServiceDeployments(() => deployments);
    setConfigurationError(""); setServiceOpen(true);
  };
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length || serviceRepositories().some((repository) => !repository.alias.trim() || !repository.url.trim())) return "请填写所有仓库别名和地址";
    if (new Set(serviceRepositories().map((repository) => repository.alias.trim())).size !== serviceRepositories().length) return "仓库别名不能重复";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (serviceDeployments.some((deployment) => !deployment.environmentKey || deployment.repositoryBranches.length !== serviceRepositories().length || deployment.repositoryBranches.some((branch) => !branch.baseBranch.trim()))) return "请填写所有部署环境和仓库分支";
    if (new Set(serviceDeployments.map((deployment) => deployment.environmentKey)).size !== serviceDeployments.length) return "同一环境只能配置一个部署";
    if (serviceDeployments.some((deployment) => !deployment.agent.provider.trim() || !deployment.agent.model.trim())) return "请配置所有部署模型";
    if (serviceDeployments.some((deployment) => deployment.capabilities.includes("nacos") && !deployment.nacos?.dataIds.length)) return "请填写 Nacos dataIds";
    return "";
  };
  const availableDeploymentEnvironments = createMemo(() => configuration().environments.filter((environment) => !serviceDeployments.some((deployment) => deployment.environmentKey === environment.key)));
  const addServiceRepository = () => {
    const repository = newRepositoryDraft();
    setServiceRepositories((current) => [...current, repository]);
    setServiceDeployments((current) => current.map((deployment) => ({ ...deployment, repositoryBranches: [...deployment.repositoryBranches, { repositoryKey: repository.key, baseBranch: issuePilotConfig.defaults.deployment.baseBranch }] })));
  };
  const deleteServiceRepository = (repository: ServiceRepositoryDraft) => {
    setServiceRepositories((current) => current.filter((item) => item !== repository));
    setServiceDeployments((current) => current.map((deployment) => ({ ...deployment, repositoryBranches: deployment.repositoryBranches.filter((branch) => branch.repositoryKey !== repository.key) })));
  };
  const addServiceDeployment = () => {
    const environment = availableDeploymentEnvironments()[0];
    if (environment) {
      const deployment = { environmentKey: environment.key, repositoryBranches: serviceRepositories().map((repository) => ({ repositoryKey: repository.key, baseBranch: issuePilotConfig.defaults.deployment.baseBranch })), capabilities: [], agent: defaultAgent() } satisfies ServiceDeploymentDraft;
      setServiceDeployments((current) => [...current, deployment]);
    }
  };
  const saveService = async () => {
    const validationError = serviceValidationError();
    if (validationError) { setConfigurationError(validationError); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), alias: repository.alias.trim(), url: repository.url.trim() })),
        deployments: serviceDeployments.map((deployment) => ({
          environmentKey: deployment.environmentKey,
          repositoryBranches: deployment.repositoryBranches.map((branch) => ({ repositoryAlias: serviceRepositories().find((repository) => repository.key === branch.repositoryKey)!.alias.trim(), baseBranch: branch.baseBranch.trim() })),
          capabilities: deployment.capabilities,
          agent: { provider: deployment.agent.provider.trim(), model: deployment.agent.model.trim(), thinkingLevel: deployment.agent.thinkingLevel },
          ...serializeCapabilityDraft(deployment),
        })),
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
      setConfigurationError(errorMessage(error));
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
              <section class="service-detail-section"><div class="service-detail-heading"><h3>代码仓库</h3><span>{service().repositories.length} 个授权根目录</span></div><div class="detail-repositories"><div class="repository-detail-head"><span>别名</span><span>仓库地址</span></div><For each={service().repositories}>{(repository) => <div class="repository-detail-row"><GitBranch size={15} /><strong>{repository.alias}</strong><code title={repository.url}>{repository.url}</code></div>}</For></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>环境部署</h3><span>{service().deployments.length} 个环境</span></div><div class="deployment-detail-list"><Show when={service().deployments.length} fallback={<div class="service-detail-empty">尚未配置环境部署</div>}><div class="deployment-detail-head"><span>环境</span><span>分支</span><span>模型</span><span>能力</span></div><For each={service().deployments}>{(deployment) => { const environment = () => configuration().environments.find((item) => item.key === deployment.environmentKey); const branches = () => service().repositories.map((repository) => ({ alias: repository.alias, baseBranch: deployment.repositoryBranches.find((item) => item.repositoryId === repository.id)?.baseBranch ?? "-" })); return <div class="deployment-detail-row"><div data-label="环境"><strong>{environment()?.name ?? deployment.environmentKey}</strong></div><div data-label="分支"><code title={branches().map((branch) => `${branch.alias}: ${branch.baseBranch}`).join("\n")}>{branches().map((branch) => branch.baseBranch).join(" / ")}</code></div><div data-label="模型"><Show when={deployment.agent} fallback={<span class="capability-empty">未配置</span>}>{(agent) => <code>{agent().provider}/{agent().model} · {agent().thinkingLevel}</code>}</Show></div><div data-label="能力"><Show when={deployment.capabilities.length} fallback={<span class="capability-empty">无外部能力</span>}><CapabilityLabels catalog={configuration().capabilityCatalog} keys={deployment.capabilities} /></Show></div></div>; }}</For></Show></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>项目描述</h3></div><Show when={service().description.trim()} fallback={<div class="service-detail-empty">暂无项目描述</div>}><Markdown source={service().description} /></Show></section>
            </div>
          </>}
        </Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">代码仓库</strong><span>别名用于环境分支配置，服务内必须唯一</span></div><Button icon={<Plus size={14} />} onClick={addServiceRepository}>添加仓库</Button></div><div class="service-repository-editor"><For each={serviceRepositories()}>{(repository, index) => <ServiceRepositoryEditorRow index={index()} repository={repository} only={serviceRepositories().length === 1} onChange={(next) => setServiceRepositories((current) => { Object.assign(repository, next); return [...current]; })} onDelete={() => deleteServiceRepository(repository)} />}</For></div></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>按仓库别名配置分支和 Pi 使用的外部能力</span></div><Button icon={<Plus size={14} />} disabled={!availableDeploymentEnvironments().length} onClick={addServiceDeployment}>添加部署</Button></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow index={index()} deployment={deployment} capabilityCatalog={configuration().capabilityCatalog} agentModels={configuration().agentModels} repositories={serviceRepositories} environmentOptions={() => configuration().environments.filter((environment) => environment.key === deployment.environmentKey || !serviceDeployments.some((item) => item !== deployment && item.environmentKey === environment.key))} onChange={(next) => setServiceDeployments((current) => { Object.assign(current[index()]!, next); })} onDelete={() => setServiceDeployments((current) => current.filter((_, itemIndex) => itemIndex !== index()))} />}</For></div></div>
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
