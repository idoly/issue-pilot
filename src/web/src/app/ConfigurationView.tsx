import { Button, Input, Modal, Skeleton, Switch as Toggle, TextArea } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, createStore, For, Match, onCleanup, Show, snapshot, Switch, untrack } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CAPABILITY_CREDENTIALS } from "../../../configuration/contracts";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { ChevronRight, GitBranch, Pencil, Plus, Trash2 } from "../ui/icons";
import { createService, deleteService, errorMessage, resolveDmsScope, updateService, type CapabilityName, type Service } from "../data/client";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";
import { useApplicationResources } from "./ApplicationResources";

function serviceSaveErrorMessage(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    invalid_db_password: "请填写数据库密码",
    invalid_dms_url: "请填写有效的 DMS MCP HTTPS URL",
    invalid_dms_authorization: "请填写完整的 Bearer 格式 DMS MCP Authorization",
    invalid_dms_database: "DMS 数据库选择无效，请重新选择",
    dms_mcp_connection_failed: "无法连接 DMS MCP，请检查 URL 和 Authorization",
    dms_mcp_scope_resolve_unavailable: "当前 DMS MCP 未提供实例或数据库解析工具",
    dms_mcp_scope_resolve_failed: "未找到该实例或数据库，或 DMS 无法连接目标实例",
    dms_mcp_scope_resolve_invalid_response: "DMS 返回了无法识别或不唯一的实例/数据库信息",
    invalid_sls_access_key_secret: "请填写 SLS AccessKeySecret",
    invalid_mq_password: "请填写 RabbitMQ 密码",
    credential_required: "该能力必须配置凭据",
    credential_not_configured: "没有可保留的现有凭据，请填写新凭据",
    invalid_credential_replacement: "请填写完整的新凭据",
    invalid_credential_update: "凭据更新状态无效，请刷新配置后重试",
    credential_fields_not_allowed: "请刷新页面后重新提交配置",
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

type ServiceDeploymentDraft = DeploymentCapabilityDraft & {
  environmentKey: string;
  repositoryBranches: Array<{ repositoryKey: string; baseBranch: string }>;
};

function cloneDeploymentDraft(deployment: ServiceDeploymentDraft): ServiceDeploymentDraft {
  return snapshot(deployment);
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
  return <div class="service-repository-row"><Input aria-label={`仓库别名 ${props.index + 1}`} placeholder="orders-api" value={alias()} onInput={(event) => { const next = event.currentTarget.value; setAlias(next); update({ alias: next }); }} /><Input aria-label={`仓库地址 ${props.index + 1}`} placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => { const next = event.currentTarget.value; setUrl(next); update({ url: next }); }} /><Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除仓库${props.index + 1}`} aria-label={`删除仓库${props.index + 1}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

const capabilityOptions = CAPABILITY_KEYS.map((key) => ({ key }));

function CapabilityLabels(props: { keys: CapabilityName[] }) {
  const capabilities = () => capabilityOptions.filter((capability) => props.keys.includes(capability.key));
  return <div class="capability-labels"><For each={capabilities()}>{(capability) => <code>{capability.key}</code>}</For></div>;
}

function ServiceDeploymentEditorRow(props: {
  index: number;
  deployment: ServiceDeploymentDraft;
  environmentName: string;
  repositories: () => ServiceRepositoryDraft[];
  onChange: (deployment: ServiceDeploymentDraft) => void;
  onDelete: () => void;
}) {
  // The row owns its draft after mount; parent updates are emitted through onChange, not reapplied.
  const initialDeployment = untrack(() => cloneDeploymentDraft(props.deployment));
  let currentDeployment = initialDeployment;
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const [repositoryBranches, setRepositoryBranches] = createSignal(initialDeployment.repositoryBranches, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...initialDeployment.capabilities], { ownedWrite: true });
  const credentialState = <Key extends CapabilityName>(key: Key, configured = false) => ({ credentialConfigured: configured, credentialEnabled: CAPABILITY_CREDENTIALS[key].required || configured });
  const [nacosDraft, setNacosDraft] = createSignal({ serverUrl: initialDeployment.nacos?.serverUrl ?? "", namespace: initialDeployment.nacos?.namespace ?? "", group: initialDeployment.nacos?.group ?? issuePilotConfig.defaults.nacos.group, dataIds: initialDeployment.nacos?.dataIds?.join(", ") ?? "", username: initialDeployment.nacos?.username ?? "", password: initialDeployment.nacos?.password ?? "", ...credentialState("nacos", initialDeployment.nacos?.credentialConfigured) }, { ownedWrite: true });
  const [dbDraft, setDbDraft] = createSignal({ url: initialDeployment.db?.url ?? "", username: initialDeployment.db?.username ?? "", password: initialDeployment.db?.password ?? "", ...credentialState("db", initialDeployment.db?.credentialConfigured) }, { ownedWrite: true });
  let currentDmsDraft = { url: initialDeployment.dms?.url ?? issuePilotConfig.defaults.dms.sseUrl, authorization: initialDeployment.dms?.authorization ?? "", instanceId: initialDeployment.dms?.instanceId ?? "", instanceHost: initialDeployment.dms?.instanceHost ?? "", instancePort: initialDeployment.dms?.instancePort ?? "", instanceLabel: initialDeployment.dms?.instanceLabel ?? "", databaseId: initialDeployment.dms?.databaseId ?? "", databaseLabel: initialDeployment.dms?.databaseLabel ?? "", ...credentialState("dms", initialDeployment.dms?.credentialConfigured) };
  const [dmsDraft, setDmsDraft] = createSignal(currentDmsDraft, { ownedWrite: true });
  const [dmsInstanceAlias, setDmsInstanceAlias] = createSignal(initialDeployment.dms?.instanceLabel?.split(" · ", 1)[0] ?? "", { ownedWrite: true });
  const [dmsSchemaName, setDmsSchemaName] = createSignal(initialDeployment.dms?.databaseLabel ?? "", { ownedWrite: true });
  const [dmsDatabaseLoading, setDmsDatabaseLoading] = createSignal(false, { ownedWrite: true });
  const [dmsDatabaseError, setDmsDatabaseError] = createSignal("", { ownedWrite: true });
  let dmsDatabaseSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let dmsDatabaseSearchGeneration = 0;
  let dmsDatabaseLastSearch = "";
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: initialDeployment.sls?.accessKeyId ?? "", accessKeySecret: initialDeployment.sls?.accessKeySecret ?? "", region: initialDeployment.sls?.region ?? "", project: initialDeployment.sls?.project ?? "", logstores: initialDeployment.sls?.logstores.join(", ") ?? "", ...credentialState("sls", initialDeployment.sls?.credentialConfigured) }, { ownedWrite: true });
  const [redisDraft, setRedisDraft] = createSignal({ host: initialDeployment.redis?.host ?? "", port: String(initialDeployment.redis?.port ?? issuePilotConfig.defaults.redis.port), username: initialDeployment.redis?.username ?? "", password: initialDeployment.redis?.password ?? "", database: String(initialDeployment.redis?.database ?? issuePilotConfig.defaults.redis.database), ...credentialState("redis", initialDeployment.redis?.credentialConfigured) }, { ownedWrite: true });
  const [mqDraft, setMqDraft] = createSignal({ host: initialDeployment.mq?.host ?? "", port: String(initialDeployment.mq?.port ?? issuePilotConfig.defaults.rabbitmq.port), managementPort: String(initialDeployment.mq?.managementPort ?? issuePilotConfig.defaults.rabbitmq.managementPort), username: initialDeployment.mq?.username ?? "", password: initialDeployment.mq?.password ?? "", virtualHost: initialDeployment.mq?.virtualHost ?? issuePilotConfig.defaults.rabbitmq.virtualHost, ...credentialState("mq", initialDeployment.mq?.credentialConfigured) }, { ownedWrite: true });
  const [esDraft, setEsDraft] = createSignal({ url: initialDeployment.es?.url ?? "", username: initialDeployment.es?.username ?? "", password: initialDeployment.es?.password ?? "", ...credentialState("es", initialDeployment.es?.credentialConfigured) }, { ownedWrite: true });
  const nacos = (value = nacosDraft()) => ({ ...value, serverUrl: value.serverUrl.trim(), namespace: value.namespace.trim(), group: value.group.trim(), dataIds: [...new Set(value.dataIds.split(",").map((item) => item.trim()).filter(Boolean))], username: value.username.trim() });
  const db = (value = dbDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const dms = (value = dmsDraft()) => ({ ...value, url: value.url.trim(), authorization: value.authorization.trim() });
  const sls = (value = slsDraft()) => ({ ...value, accessKeyId: value.accessKeyId.trim(), region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map((item) => item.trim()).filter(Boolean) });
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
  const clearResolvedDms = () => updateDms({ instanceId: "", instanceHost: "", instancePort: "", instanceLabel: dmsInstanceAlias(), databaseId: "", databaseLabel: dmsSchemaName() });
  const validDmsConnection = () => Boolean(dmsDraft().url.trim() && /^Bearer [^\s]+$/.test(dmsDraft().authorization.trim()));
  const resolveDmsInputs = (instanceAlias: string, schemaName: string) => {
    const normalizedAlias = instanceAlias.trim();
    const normalizedSchema = schemaName.trim();
    const requestKey = `${normalizedAlias}\u0000${normalizedSchema}`;
    if (dmsDatabaseLoading() && requestKey === dmsDatabaseLastSearch) return;
    dmsDatabaseLastSearch = requestKey;
    if (dmsDatabaseSearchTimer) clearTimeout(dmsDatabaseSearchTimer);
    const generation = ++dmsDatabaseSearchGeneration;
    if (!normalizedAlias || !normalizedSchema) { setDmsDatabaseLoading(false); setDmsDatabaseError(""); return; }
    dmsDatabaseSearchTimer = setTimeout(() => {
      const draft = dmsDraft();
      if (!validDmsConnection()) { setDmsDatabaseError("请先填写有效的 URL 和 Authorization"); return; }
      setDmsDatabaseLoading(true); setDmsDatabaseError("");
      void resolveDmsScope({ url: draft.url.trim(), authorization: draft.authorization.trim(), instanceAlias: normalizedAlias, schemaName: normalizedSchema }).then((scope) => {
        if (generation !== dmsDatabaseSearchGeneration || `${dmsInstanceAlias().trim()}\u0000${dmsSchemaName().trim()}` !== requestKey) return;
        updateDms(scope);
      }).catch((error) => { if (generation === dmsDatabaseSearchGeneration) setDmsDatabaseError(serviceSaveErrorMessage(error)); })
        .finally(() => { if (generation === dmsDatabaseSearchGeneration) setDmsDatabaseLoading(false); });
    }, 500);
  };
  onCleanup(() => {
    if (dmsDatabaseSearchTimer) clearTimeout(dmsDatabaseSearchTimer);
    dmsDatabaseSearchGeneration += 1;
  });
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const draft = { ...slsDraft(), ...change }; setSlsDraft(draft); update({ sls: sls(draft) }); };
  const updateRedis = (change: Partial<ReturnType<typeof redisDraft>>) => { const draft = { ...redisDraft(), ...change }; setRedisDraft(draft); update({ redis: redis(draft) }); };
  const updateMq = (change: Partial<ReturnType<typeof mqDraft>>) => { const draft = { ...mqDraft(), ...change }; setMqDraft(draft); update({ mq: mq(draft) }); };
  const updateEs = (change: Partial<ReturnType<typeof esDraft>>) => { const draft = { ...esDraft(), ...change }; setEsDraft(draft); update({ es: es(draft) }); };
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const capabilities = [...selectedCapabilities(), key];
    setSelectedCapabilities(capabilities);
    update({ capabilities, ...(key === "nacos" ? { nacos: nacos() } : {}), ...(key === "db" ? { db: db() } : {}), ...(key === "dms" ? { dms: dms() } : {}), ...(key === "sls" ? { sls: sls() } : {}), ...(key === "redis" ? { redis: redis() } : {}), ...(key === "mq" ? { mq: mq() } : {}), ...(key === "es" ? { es: es() } : {}) });
  };
  const removeCapability = (key: CapabilityName) => {
    const capabilities = selectedCapabilities().filter((capability) => capability !== key);
    setSelectedCapabilities(capabilities);
    update({ capabilities });
  };
  return (
    <div class={`service-deployment-row${expanded() ? "" : " collapsed"}`}>
      <div class="deployment-environment" aria-label={`部署 ${props.index + 1} 环境`}><strong>{props.environmentName}</strong></div>
      <div class="deployment-summary" aria-label={`部署 ${props.index + 1} 能力`}><CapabilityLabels keys={selectedCapabilities()} /></div>
      <Button class="icon-button deployment-toggle" type="text" shape="circle" icon={<ChevronRight size={15} />} title={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-label={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((current) => !current)} />
      <Show when={expanded()}><div class="deployment-capabilities"><span>能力</span><div class="deployment-capability-options"><For each={capabilityOptions}>{(capability) => { const selected = () => selectedCapabilities().includes(capability.key); return <button type="button" class={`deployment-capability-option${selected() ? " selected" : ""}`} aria-pressed={selected() ? "true" : "false"} onClick={() => selected() ? removeCapability(capability.key) : addCapability(capability.key)}>{capability.key}</button>; }}</For></div></div>
      <div class="deployment-repositories"><div class="capability-settings-head"><code>代码分支</code></div><For each={props.repositories()}>{(repository) => <label><span class="required-field">{repository.alias || "未命名仓库"}</span><Input aria-label={`部署 ${props.index + 1} 仓库 ${repository.alias || repository.key} 分支`} value={repositoryBranches().find((branch) => branch.repositoryKey === repository.key)?.baseBranch ?? ""} onInput={(event) => updateRepositoryBranch(repository.key, event.currentTarget.value)} /></label>}</For></div>
      <For each={capabilityOptions.filter((capability) => selectedCapabilities().includes(capability.key))}>{(capability) => <Switch>
        <Match when={capability.key === "nacos"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>nacos</code></div><label><span class="required-field">serverUrl</span><Input aria-label={`nacos serverUrl ${props.index + 1}`} value={nacosDraft().serverUrl} onInput={(event) => { updateNacos({ serverUrl: event.currentTarget.value }); }} /></label><label><span>namespace</span><Input aria-label={`nacos namespace ${props.index + 1}`} value={nacosDraft().namespace} onInput={(event) => { updateNacos({ namespace: event.currentTarget.value }); }} /></label><label><span class="required-field">group</span><Input aria-label={`nacos group ${props.index + 1}`} value={nacosDraft().group} onInput={(event) => { updateNacos({ group: event.currentTarget.value }); }} /></label><label><span class="required-field">dataIds</span><Input aria-label={`nacos dataIds ${props.index + 1}`} placeholder="多个 Data ID 用逗号分隔" value={nacosDraft().dataIds} onInput={(event) => { updateNacos({ dataIds: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>认证</span><Toggle size="small" aria-label={`nacos 认证 ${props.index + 1}`} checked={nacosDraft().credentialEnabled} onChange={(checked) => updateNacos({ credentialEnabled: checked })} /></div><Show when={nacosDraft().credentialEnabled}><label><span class="required-field">username</span><Input aria-label={`nacos username ${props.index + 1}`} value={nacosDraft().username} onInput={(event) => { updateNacos({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`nacos password ${props.index + 1}`} placeholder={nacosDraft().credentialConfigured ? "已配置" : ""} value={nacosDraft().password} onInput={(event) => { updateNacos({ password: event.currentTarget.value }); }} /></label></Show></div></Match>
        <Match when={capability.key === "db"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>db</code></div><label><span class="required-field">url</span><Input aria-label={`db url ${props.index + 1}`} value={dbDraft().url} onInput={(event) => { updateDb({ url: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`db username ${props.index + 1}`} value={dbDraft().username} onInput={(event) => { updateDb({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`db password ${props.index + 1}`} placeholder={dbDraft().credentialConfigured ? "已配置" : ""} value={dbDraft().password} onInput={(event) => { updateDb({ password: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "dms"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>dms</code></div><label><span class="required-field">url</span><Input aria-label={`dms url ${props.index + 1}`} placeholder="https://example.com/sse" value={dmsDraft().url} onInput={(event) => { updateDms({ url: event.currentTarget.value }); clearResolvedDms(); resolveDmsInputs(dmsInstanceAlias(), dmsSchemaName()); }} /></label><label><span class="required-field">Authorization</span><Input.Password autocomplete="off" aria-label={`dms Authorization ${props.index + 1}`} placeholder={dmsDraft().credentialConfigured ? "已配置" : "Bearer token"} value={dmsDraft().authorization} onInput={(event) => { updateDms({ authorization: event.currentTarget.value }); clearResolvedDms(); resolveDmsInputs(dmsInstanceAlias(), dmsSchemaName()); }} /></label><label><span>alias</span><Input aria-label={`dms instance ${props.index + 1}`} placeholder="例如 RDS-XHGJ-MPM" value={dmsInstanceAlias()} onInput={(event) => { const alias = event.currentTarget.value; setDmsInstanceAlias(alias); clearResolvedDms(); resolveDmsInputs(alias, dmsSchemaName()); }} /></label><label><span>schema</span><Input aria-label={`dms database ${props.index + 1}`} placeholder="例如 mdm" value={dmsSchemaName()} onInput={(event) => { const schemaName = event.currentTarget.value; setDmsSchemaName(schemaName); clearResolvedDms(); resolveDmsInputs(dmsInstanceAlias(), schemaName); }} /></label><Show when={dmsDatabaseLoading()}><small class="dms-scope-hint">正在解析实例和数据库...</small></Show><Show when={dmsDraft().databaseId}><small class="dms-scope-hint">已解析 · <code>InstanceId {dmsDraft().instanceId}</code> · <code>DatabaseId {dmsDraft().databaseId}</code> · <code>{dmsDraft().instanceHost}:{dmsDraft().instancePort}</code></small></Show><Show when={dmsDatabaseError()}><div class="form-error" role="alert">{dmsDatabaseError()}</div></Show></div></Match>
        <Match when={capability.key === "redis"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>redis</code></div><label><span class="required-field">host</span><Input aria-label={`redis host ${props.index + 1}`} value={redisDraft().host} onInput={(event) => { updateRedis({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`redis port ${props.index + 1}`} value={redisDraft().port} onInput={(event) => { updateRedis({ port: event.currentTarget.value }); }} /></label><label><span>username</span><Input aria-label={`redis username ${props.index + 1}`} value={redisDraft().username} onInput={(event) => { updateRedis({ username: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>密码</span><Toggle size="small" aria-label={`redis 密码 ${props.index + 1}`} checked={redisDraft().credentialEnabled} onChange={(checked) => updateRedis({ credentialEnabled: checked })} /></div><Show when={redisDraft().credentialEnabled}><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`redis password ${props.index + 1}`} placeholder={redisDraft().credentialConfigured ? "已配置" : ""} value={redisDraft().password} onInput={(event) => { updateRedis({ password: event.currentTarget.value }); }} /></label></Show><label><span class="required-field">database</span><Input aria-label={`redis database ${props.index + 1}`} value={redisDraft().database} onInput={(event) => { updateRedis({ database: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "mq"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>mq</code></div><label><span class="required-field">host</span><Input aria-label={`mq host ${props.index + 1}`} value={mqDraft().host} onInput={(event) => { updateMq({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`mq port ${props.index + 1}`} value={mqDraft().port} onInput={(event) => { updateMq({ port: event.currentTarget.value }); }} /></label><label><span class="required-field">managementPort</span><Input aria-label={`mq managementPort ${props.index + 1}`} value={mqDraft().managementPort} onInput={(event) => { updateMq({ managementPort: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`mq username ${props.index + 1}`} value={mqDraft().username} onInput={(event) => { updateMq({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`mq password ${props.index + 1}`} placeholder={mqDraft().credentialConfigured ? "已配置" : ""} value={mqDraft().password} onInput={(event) => { updateMq({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">virtualHost</span><Input aria-label={`mq virtualHost ${props.index + 1}`} value={mqDraft().virtualHost} onInput={(event) => { updateMq({ virtualHost: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "es"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>es</code></div><label><span class="required-field">url</span><Input aria-label={`es url ${props.index + 1}`} placeholder="http://es.example.com" value={esDraft().url} onInput={(event) => { updateEs({ url: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>认证</span><Toggle size="small" aria-label={`es 认证 ${props.index + 1}`} checked={esDraft().credentialEnabled} onChange={(checked) => updateEs({ credentialEnabled: checked })} /></div><Show when={esDraft().credentialEnabled}><label><span class="required-field">username</span><Input aria-label={`es username ${props.index + 1}`} value={esDraft().username} onInput={(event) => { updateEs({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`es password ${props.index + 1}`} placeholder={esDraft().credentialConfigured ? "已配置" : ""} value={esDraft().password} onInput={(event) => { updateEs({ password: event.currentTarget.value }); }} /></label></Show></div></Match>
        <Match when={capability.key === "sls"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">accessKeyId</span><Input autocomplete="off" aria-label={`sls accessKeyId ${props.index + 1}`} placeholder={slsDraft().credentialConfigured ? "已配置" : ""} value={slsDraft().accessKeyId} onInput={(event) => { updateSls({ accessKeyId: event.currentTarget.value }); }} /></label><label><span class="required-field">accessKeySecret</span><Input.Password autocomplete="off" aria-label={`sls accessKeySecret ${props.index + 1}`} placeholder={slsDraft().credentialConfigured ? "已配置" : ""} value={slsDraft().accessKeySecret} onInput={(event) => { updateSls({ accessKeySecret: event.currentTarget.value }); }} /></label><label><span class="required-field">region</span><Input aria-label={`sls region ${props.index + 1}`} placeholder="cn-hangzhou" value={slsDraft().region} onInput={(event) => { updateSls({ region: event.currentTarget.value }); }} /></label><label><span class="required-field">project</span><Input aria-label={`sls project ${props.index + 1}`} value={slsDraft().project} onInput={(event) => { updateSls({ project: event.currentTarget.value }); }} /></label><label><span class="required-field">logstore</span><Input aria-label={`sls logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsDraft().logstores} onInput={(event) => { updateSls({ logstores: event.currentTarget.value }); }} /></label></div></Match>
      </Switch>}</For></Show>
      <Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除部署${props.index + 1}`} aria-label={`删除部署${props.index + 1}`} onClick={props.onDelete} />
    </div>
  );
}

export function ConfigurationView() {
  const { configuration, configurationLoaded, refreshCatalog, refreshConfiguration, configurationError: resourceError } = useApplicationResources();
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<ServiceRepositoryDraft[]>([newRepositoryDraft()], { ownedWrite: true });
  const [serviceDeployments, setServiceDeployments] = createStore<ServiceDeploymentDraft[]>([]);
  const [editingServiceKey, setEditingServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [selectedServiceKey, setSelectedServiceKey] = createSignal("", { ownedWrite: true });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "service"; key: string; name: string } | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const refresh = async () => {
    try {
      await Promise.all([refreshConfiguration(), refreshCatalog()]);
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(errorMessage(error));
    }
  };
  createEffect(
    () => ({ services: configuration().services, selectedKey: selectedServiceKey() }),
    ({ services, selectedKey }) => { if (!services.some((service) => service.key === selectedKey)) setSelectedServiceKey(services[0]?.key ?? ""); },
  );
  const selectedService = createMemo(() => configuration().services.find((service) => service.key === selectedServiceKey()));
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setServiceRepositories([newRepositoryDraft()]); setServiceDeployments(() => []); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: Service) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, key: repository.id, alias: repository.alias, url: repository.url })));
    const deployments = service.deployments.map((deployment) => ({
      environmentKey: deployment.environmentKey,
      repositoryBranches: deployment.repositoryBranches.map((branch) => ({ repositoryKey: branch.repositoryId, baseBranch: branch.baseBranch })),
      capabilities: [...deployment.capabilities],
      ...(deployment.nacos ? { nacos: { ...deployment.nacos, dataIds: [...deployment.nacos.dataIds], credentialEnabled: deployment.nacos.credentialConfigured } } : {}),
      ...(deployment.db ? { db: { ...deployment.db, credentialEnabled: true } } : {}),
      ...(deployment.dms ? { dms: { ...deployment.dms, credentialEnabled: true } } : {}),
      ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores], credentialEnabled: true } } : {}),
      ...(deployment.redis ? { redis: { ...deployment.redis, credentialEnabled: deployment.redis.credentialConfigured } } : {}),
      ...(deployment.mq ? { mq: { ...deployment.mq, credentialEnabled: true } } : {}),
      ...(deployment.es ? { es: { ...deployment.es, credentialEnabled: deployment.es.credentialConfigured } } : {}),
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
      const deployment = { environmentKey: environment.key, repositoryBranches: serviceRepositories().map((repository) => ({ repositoryKey: repository.key, baseBranch: issuePilotConfig.defaults.deployment.baseBranch })), capabilities: [] } satisfies ServiceDeploymentDraft;
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
      setConfigurationError(serviceSaveErrorMessage(error));
    } finally { setSaving(false); }
  };
  return (
    <main class="configuration-workspace">
      <Show when={!configurationLoaded()}><section class="queue-loading configuration-loading"><Show when={resourceError()} fallback={<Skeleton active paragraph={{ rows: 10 }} />}><div class="workspace-error" role="alert"><span>{resourceError()}</span><Button onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div></Show></section></Show>
      <section class="service-panel" hidden={!configurationLoaded()}>
        <div class="service-tabs"><div class="service-tabs-inner"><div class="service-tab-list" role="tablist" aria-label="服务列表"><For each={configuration().services}>{(service) => <button type="button" role="tab" aria-selected={selectedServiceKey() === service.key ? "true" : "false"} class={selectedServiceKey() === service.key ? "selected" : ""} onClick={() => setSelectedServiceKey(service.key)}>{service.name}</button>}</For></div><div class="service-tab-actions"><Button icon={<Plus size={14} />} onClick={openNewService}>添加</Button><Show when={selectedService()}>{(service) => <Button type="primary" icon={<Pencil size={14} />} onClick={() => openServiceEditor(service())}>编辑</Button>}</Show></div></div></div>
        <Show when={resourceError()}><div class="workspace-error" role="alert">{resourceError()}</div></Show>
        <Show when={selectedService()} fallback={<div class="empty-band">暂无服务</div>}>{(service) => (
          <div class="service-detail">
            <section class="service-detail-section"><div class="service-detail-heading"><h3>代码仓库</h3><span>{service().repositories.length} 个</span></div><div class="service-repository-list"><For each={service().repositories}>{(repository) => <div><GitBranch size={14} /><strong>{repository.alias}</strong><code title={repository.url}>{repository.url}</code></div>}</For></div></section>
            <section class="service-detail-section"><div class="service-detail-heading"><h3>环境部署</h3><span>{service().deployments.length} 个</span></div><div class="deployment-detail-list"><For each={service().deployments} fallback={<div class="service-detail-empty">尚未配置环境</div>}>{(deployment) => { const environment = () => configuration().environments.find((item) => item.key === deployment.environmentKey); const branches = () => deployment.repositoryBranches.map((branch) => branch.baseBranch).join(" / "); return <div class="deployment-detail-row"><strong>{environment()?.name ?? deployment.environmentKey}</strong><code title={branches()}>{branches()}</code><Show when={deployment.capabilities.length} fallback={<small>无外部能力</small>}><CapabilityLabels keys={deployment.capabilities} /></Show></div>; }}</For></div></section>
            <section class="service-detail-section service-description-section"><div class="service-detail-heading"><h3>服务描述</h3></div><p class="service-description">{service().description.trim() || "暂无描述"}</p></section>
          </div>
        )}</Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">代码仓库</strong><span>别名用于环境分支配置，服务内必须唯一</span></div><Button icon={<Plus size={14} />} onClick={addServiceRepository}>添加仓库</Button></div><div class="service-repository-editor"><For each={serviceRepositories()}>{(repository, index) => <ServiceRepositoryEditorRow index={index()} repository={repository} only={serviceRepositories().length === 1} onChange={(next) => setServiceRepositories((current) => { Object.assign(repository, next); return [...current]; })} onDelete={() => deleteServiceRepository(repository)} />}</For></div></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>按仓库别名配置分支和 Pi 使用的外部能力</span></div><Button icon={<Plus size={14} />} disabled={!availableDeploymentEnvironments().length} onClick={addServiceDeployment}>添加部署</Button></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow index={index()} deployment={deployment} repositories={serviceRepositories} environmentName={configuration().environments.find((environment) => environment.key === deployment.environmentKey)?.name ?? deployment.environmentKey} onChange={(next) => setServiceDeployments((current) => { Object.assign(current[index()]!, next); })} onDelete={() => setServiceDeployments((current) => current.filter((_, itemIndex) => itemIndex !== index()))} />}</For></div></div>
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
