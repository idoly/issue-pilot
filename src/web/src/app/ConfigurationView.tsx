import { Button, Input, PasswordInput, Modal, Select, Skeleton, Toggle, TextArea } from "../ui";
import { createEffect, createMemo, createSignal, createStore, For, Match, onCleanup, Show, snapshot, Switch, untrack } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CAPABILITY_CREDENTIALS } from "../../../configuration/contracts";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { ChevronRight, Pencil, Plus, Trash2 } from "../ui/icons";
import { loadRepositories, loadServiceConfigurationDescription, loadMcpServices, type McpService, type ServiceInput, type ManagedRepository, createService, deleteService, errorMessage, resolveDmsScope, updateService, type CapabilityName, type Service } from "../data/client";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";
import { ServiceOverview } from "./ServiceOverview";
import { useApplicationResources } from "./ApplicationResources";

export function serviceSaveErrorMessage(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    dms_credentials_target_changed: "DMS URL 已变更，请填写该地址的新 Authorization",
    invalid_db_password: "请填写数据库密码",
    invalid_db_databases: "请至少配置一个且不超过 20 个 MySQL 数据库",
    duplicate_db_database: "MySQL database 名不能重复",
    duplicate_db_url: "同一个 MySQL URL 不能配置多次",
    db_database_not_authorized: "所选 MySQL 数据库未授权",
    invalid_dms_url: "请填写有效的 DMS MCP HTTPS URL",
    invalid_dms_authorization: "请填写完整的 Bearer 格式 DMS MCP Authorization",
    invalid_dms_database: "DMS 数据库解析结果无效，请重新填写",
    invalid_dms_databases: "请至少配置一个且不超过 20 个 DMS 数据库",
    duplicate_dms_database_schema: "DMS schema 不能重复",
    duplicate_dms_database_id: "同一个 DMS 数据库不能配置多次",
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
    repository_not_registered: "请先在仓库配置中登记地址，再在服务中选择",
    invalid_repository: "仓库标识无效，请刷新配置后重试",
    duplicate_repository_alias: "仓库别名不能重复",
    invalid_deployment_repository_branches: "请为每个环境配置全部仓库分支",
    development_capabilities_inherited: "开发环境能力继承正式和测试，请刷新后只编辑代码分支",
    development_configuration_layout_invalid: "开发配置需要按当前迁移升级，请联系维护人员检查",
    invalid_deployment_mcp_services: "MCP 能力配置已变化，请刷新后重试",
    service_configuration_save_failed: "保存配置失败，请重试",
    service_has_running_issues: "该服务有正在处理的工单，请等待处理结束或先中止 Agent",
  };
  return messages[code] ?? code;
}

export interface ServiceRepositoryDraft {
  id?: string;
  key: string;
  alias: string;
  url: string;
}

export type ServiceDeploymentDraft = DeploymentCapabilityDraft & {
  mcpServices: string[];
  environmentKey: string;
  repositoryBranches: Array<{ repositoryKey: string; baseBranch: string }>;
};

type DbDatabaseDraft = NonNullable<ServiceDeploymentDraft["db"]>["databases"][number];
const newDbDatabaseDraft = (): DbDatabaseDraft => ({ url: "", username: "", password: "", credentialConfigured: false, credentialEnabled: true });
type DmsDatabaseDraft = NonNullable<ServiceDeploymentDraft["dms"]>["databases"][number];
const newDmsDatabaseDraft = (): DmsDatabaseDraft => ({ instanceAlias: "", schemaName: "", instanceId: "", instanceHost: "", instancePort: "", databaseId: "" });

export function serviceDeploymentDraft(deployment: Service["deployments"][number]): ServiceDeploymentDraft {
  return {
    environmentKey: deployment.environmentKey, mcpServices: [...(deployment.mcpServices ?? [])],
    repositoryBranches: deployment.repositoryBranches.map(branch => ({ repositoryKey: branch.repositoryId, baseBranch: branch.baseBranch })), capabilities: [...deployment.capabilities],
    ...(deployment.nacos ? { nacos: { ...deployment.nacos, password: "", dataIds: [...deployment.nacos.dataIds], credentialEnabled: deployment.nacos.credentialConfigured } } : {}),
    ...(deployment.db ? { db: { databases: deployment.db.databases.map(database => ({ ...database, password: "", credentialEnabled: true })) } } : {}),
    ...(deployment.dms ? { dms: { ...deployment.dms, authorization: "", credentialEnabled: true, databases: deployment.dms.databases.map(database => ({ ...database })) } } : {}),
    ...(deployment.sls ? { sls: { ...deployment.sls, accessKeyId: "", accessKeySecret: "", credentialEnabled: true, logstores: [...deployment.sls.logstores] } } : {}),
    ...(deployment.redis ? { redis: { ...deployment.redis, password: "", credentialEnabled: deployment.redis.credentialConfigured } } : {}),
    ...(deployment.mq ? { mq: { ...deployment.mq, password: "", credentialEnabled: true } } : {}),
    ...(deployment.es ? { es: { ...deployment.es, password: "", credentialEnabled: deployment.es.credentialConfigured } } : {}),
  };
}

export function serializeServiceDeployment(deployment: ServiceDeploymentDraft, repositories: ServiceRepositoryDraft[]): ServiceInput["deployments"][number] {
  return { environmentKey: deployment.environmentKey, mcpServices: [...deployment.mcpServices], capabilities: [...deployment.capabilities], repositoryBranches: deployment.repositoryBranches.map(branch => ({ repositoryAlias: repositories.find(repository => repository.key === branch.repositoryKey)!.alias, baseBranch: branch.baseBranch.trim() })), ...serializeCapabilityDraft(deployment) };
}

export function deploymentValidationError(deployment: ServiceDeploymentDraft): string {
  if (deployment.repositoryBranches.some(branch => !branch.baseBranch.trim())) return "请填写所有仓库分支";
  if (deployment.environmentKey === "dev") return "";
  if (deployment.capabilities.includes("nacos") && !deployment.nacos?.dataIds.length) return "请填写 Nacos dataIds";
  if (deployment.capabilities.includes("db") && (!deployment.db?.databases.length || deployment.db.databases.some(database => !database.url.trim() || !database.username.trim() || (!database.password.trim() && !database.credentialConfigured)))) return "请填写所有 MySQL 数据库连接信息";
  if (deployment.capabilities.includes("dms")) {
    if (!deployment.dms?.url.trim()) return "请填写 DMS 地址";
    if (!deployment.dms.databases.length) return "请添加 DMS 数据库";
    if (deployment.dms.databases.some(database => !database.instanceAlias.trim() || !database.schemaName.trim())) return "请填写全部 DMS 数据库的实例和 schema";
    if (deployment.dms.databases.some(database => !database.databaseId)) return "DMS 数据库尚未解析完成，请等待解析结果或检查行内提示";
  }
  if (deployment.capabilities.includes("sls") && (!deployment.sls?.region.trim() || !deployment.sls.project.trim() || !deployment.sls.logstores.length)) return "请填写 SLS 日志目标";
  return "";
}

function cloneDeploymentDraft(deployment: ServiceDeploymentDraft): ServiceDeploymentDraft {
  return snapshot(deployment);
}

const capabilityOptions: Array<{ key: CapabilityName }> = CAPABILITY_KEYS.map(key => ({ key }));

function DbDatabaseEditorRow(props: {
  deploymentIndex: number;
  databaseIndex: number;
  database: DbDatabaseDraft;
  only: boolean;
  onChange: (database: DbDatabaseDraft) => void;
  onDelete: () => void;
}) {
  let current = { ...props.database };
  const [database, setDatabase] = createSignal(current, { ownedWrite: true });
  const update = (change: Partial<DbDatabaseDraft>) => {
    current = { ...current, ...change };
    setDatabase(current);
    props.onChange(current);
  };
  return <div class="db-database-row"><label><span class="required-field">url</span><Input aria-label={`db url ${props.deploymentIndex}-${props.databaseIndex}`} placeholder="mysql://host:3306/database" value={database().url} onInput={(event) => update({ url: event.currentTarget.value })} /></label><label><span class="required-field">username</span><Input aria-label={`db username ${props.deploymentIndex}-${props.databaseIndex}`} value={database().username} onInput={(event) => update({ username: event.currentTarget.value })} /></label><label><span class="required-field">password</span><PasswordInput autocomplete="off" aria-label={`db password ${props.deploymentIndex}-${props.databaseIndex}`} placeholder={database().credentialConfigured ? "已配置" : ""} value={database().password} onInput={(event) => update({ password: event.currentTarget.value })} /></label><Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={13} />} title={`删除 MySQL 数据库 ${props.databaseIndex}`} aria-label={`删除 MySQL 数据库 ${props.databaseIndex}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

function DmsDatabaseEditorRow(props: {
  deploymentIndex: number;
  databaseIndex: number;
  database: DmsDatabaseDraft;
  connection: () => { url: string; authorization: string; serviceKey?: string; environmentKey: string };
  only: boolean;
  onChange: (database: DmsDatabaseDraft) => void;
  onDelete: () => void;
}) {
  let current = { ...props.database };
  const [database, setDatabase] = createSignal(current, { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [resolveError, setResolveError] = createSignal("", { ownedWrite: true });
  let resolveTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveGeneration = 0;
  const emit = (next: DmsDatabaseDraft) => { current = next; setDatabase(next); props.onChange(next); };
  const scheduleResolve = (next: DmsDatabaseDraft, connection = props.connection()) => {
    if (resolveTimer) clearTimeout(resolveTimer);
    const generation = ++resolveGeneration;
    const instanceAlias = next.instanceAlias.trim();
    const schemaName = next.schemaName.trim();
    if (!instanceAlias || !schemaName) { setLoading(false); setResolveError(""); return; }
    resolveTimer = setTimeout(() => {
      if (!connection.url || (!connection.authorization && !connection.serviceKey)) { setResolveError("请先填写 DMS 地址和 Token"); return; }
      setLoading(true); setResolveError("");
      void resolveDmsScope({ ...connection, instanceAlias, schemaName }).then((scope) => {
        if (generation !== resolveGeneration || current.instanceAlias.trim() !== instanceAlias || current.schemaName.trim() !== schemaName) return;
        emit({ ...current, ...scope });
      }).catch((error) => { if (generation === resolveGeneration) setResolveError(serviceSaveErrorMessage(error)); })
        .finally(() => { if (generation === resolveGeneration) setLoading(false); });
    }, 500);
  };
  const updateScope = (change: Partial<Pick<DmsDatabaseDraft, "instanceAlias" | "schemaName">>) => {
    if (Object.entries(change).every(([key, value]) => current[key as "instanceAlias" | "schemaName"].trim() === value?.trim())) return;
    const next = { ...current, ...change, instanceId: "", instanceHost: "", instancePort: "", databaseId: "" };
    emit(next); scheduleResolve(next);
  };
  createEffect(
    () => props.connection(),
    (connection, previous) => {
      if (previous === undefined) return;
      if (connection.url === previous.url) {
        if (connection.authorization !== previous.authorization && !current.databaseId) untrack(() => scheduleResolve(current, connection));
        return;
      }
      const next = { ...current, instanceId: "", instanceHost: "", instancePort: "", databaseId: "" };
      untrack(() => { emit(next); scheduleResolve(next, connection); });
    },
  );
  onCleanup(() => { if (resolveTimer) clearTimeout(resolveTimer); resolveGeneration += 1; });
  return <div class="dms-database-row"><label><span class="required-field">alias</span><Input aria-label={`dms instance ${props.deploymentIndex}-${props.databaseIndex}`} placeholder="例如 RDS-XHGJ-SRM" value={database().instanceAlias} onInput={(event) => updateScope({ instanceAlias: event.currentTarget.value })} /></label><label><span class="required-field">schema</span><Input aria-label={`dms database ${props.deploymentIndex}-${props.databaseIndex}`} placeholder="例如 srm" value={database().schemaName} onInput={(event) => updateScope({ schemaName: event.currentTarget.value })} /></label><Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={13} />} title={`删除 DMS 数据库 ${props.databaseIndex}`} aria-label={`删除 DMS 数据库 ${props.databaseIndex}`} disabled={props.only} onClick={props.onDelete} /><Show when={loading()}><small class="dms-scope-hint">正在解析实例和数据库...</small></Show><Show when={database().databaseId}><small class="dms-scope-hint">已解析 · <code>InstanceId {database().instanceId}</code> · <code>DatabaseId {database().databaseId}</code> · <code>{database().instanceHost}:{database().instancePort}</code></small></Show><Show when={resolveError()}>{(message) => <div class="form-error" role="alert">{message()}</div>}</Show></div>;
}

export function ServiceDeploymentEditorRow(props: {
  capability?: CapabilityName;
  initiallyExpanded?: boolean;
  serviceKey: string | null;
  mcpServices: () => McpService[];
  index: number;
  deployment: ServiceDeploymentDraft;
  environmentName: string;
  repositoryName: (repository: ServiceRepositoryDraft) => string;
  repositories: () => ServiceRepositoryDraft[];
  onChange: (deployment: ServiceDeploymentDraft) => void;
}) {
  // The row owns its draft after mount; parent updates are emitted through onChange, not reapplied.
  const initialDeployment = untrack(() => cloneDeploymentDraft(props.deployment));
  let currentDeployment = initialDeployment;
  const codeOnly = initialDeployment.environmentKey === "dev";
  const [expanded, setExpanded] = createSignal(untrack(() => props.initiallyExpanded ?? false), { ownedWrite: true });
  const [mcpSelected, setMcpSelected] = createSignal(initialDeployment.mcpServices.length > 0, { ownedWrite: true });
  const [mcpIds, setMcpIds] = createSignal([...initialDeployment.mcpServices], { ownedWrite: true });
  const [repositoryBranches, setRepositoryBranches] = createSignal(initialDeployment.repositoryBranches, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...initialDeployment.capabilities], { ownedWrite: true });
  const credentialState = <Key extends CapabilityName>(key: Key, configured = false) => ({ credentialConfigured: configured, credentialEnabled: CAPABILITY_CREDENTIALS[key].required || configured });
  const [nacosDraft, setNacosDraft] = createSignal({ serverUrl: initialDeployment.nacos?.serverUrl ?? "", namespace: initialDeployment.nacos?.namespace ?? "", group: initialDeployment.nacos?.group ?? issuePilotConfig.defaults.nacos.group, dataIds: initialDeployment.nacos?.dataIds?.join(", ") ?? "", username: initialDeployment.nacos?.username ?? "", password: initialDeployment.nacos?.password ?? "", ...credentialState("nacos", initialDeployment.nacos?.credentialConfigured) }, { ownedWrite: true });
  let currentDbDraft = { databases: initialDeployment.db?.databases?.map((database) => ({ ...database, password: "", credentialEnabled: true })) ?? [newDbDatabaseDraft()] };
  const [dbDraft, setDbDraft] = createSignal(currentDbDraft, { ownedWrite: true });
  let currentDmsDraft = { url: initialDeployment.dms?.url ?? issuePilotConfig.defaults.dms.sseUrl, authorization: "", ...credentialState("dms", initialDeployment.dms?.credentialConfigured), databases: initialDeployment.dms?.databases?.map(database => ({ ...database })) ?? [newDmsDatabaseDraft()] };
  const [dmsDraft, setDmsDraft] = createSignal(currentDmsDraft, { ownedWrite: true });
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: "", accessKeySecret: "", ...credentialState("sls", initialDeployment.sls?.credentialConfigured), region: initialDeployment.sls?.region ?? "", project: initialDeployment.sls?.project ?? "", logstores: initialDeployment.sls?.logstores.join(", ") ?? "" }, { ownedWrite: true });
  const [redisDraft, setRedisDraft] = createSignal({ host: initialDeployment.redis?.host ?? "", port: String(initialDeployment.redis?.port ?? issuePilotConfig.defaults.redis.port), username: initialDeployment.redis?.username ?? "", password: initialDeployment.redis?.password ?? "", database: String(initialDeployment.redis?.database ?? issuePilotConfig.defaults.redis.database), ...credentialState("redis", initialDeployment.redis?.credentialConfigured) }, { ownedWrite: true });
  const [mqDraft, setMqDraft] = createSignal({ host: initialDeployment.mq?.host ?? "", port: String(initialDeployment.mq?.port ?? issuePilotConfig.defaults.rabbitmq.port), managementPort: String(initialDeployment.mq?.managementPort ?? issuePilotConfig.defaults.rabbitmq.managementPort), username: initialDeployment.mq?.username ?? "", password: initialDeployment.mq?.password ?? "", virtualHost: initialDeployment.mq?.virtualHost ?? issuePilotConfig.defaults.rabbitmq.virtualHost, ...credentialState("mq", initialDeployment.mq?.credentialConfigured) }, { ownedWrite: true });
  const [esDraft, setEsDraft] = createSignal({ url: initialDeployment.es?.url ?? "", username: initialDeployment.es?.username ?? "", password: initialDeployment.es?.password ?? "", ...credentialState("es", initialDeployment.es?.credentialConfigured) }, { ownedWrite: true });
  const nacos = (value = nacosDraft()) => ({ ...value, serverUrl: value.serverUrl.trim(), namespace: value.namespace.trim(), group: value.group.trim(), dataIds: [...new Set(value.dataIds.split(",").map((item) => item.trim()).filter(Boolean))], username: value.username.trim() });
  const db = (value = dbDraft()) => ({ databases: value.databases.map((database) => ({ ...database, url: database.url.trim(), username: database.username.trim() })) });
  const dms = (value = dmsDraft()) => ({ ...value, databases: value.databases.map((database) => ({ instanceAlias: database.instanceAlias.trim(), schemaName: database.schemaName.trim(), instanceId: database.instanceId.trim(), instanceHost: database.instanceHost.trim(), instancePort: database.instancePort.trim(), databaseId: database.databaseId.trim() })) });
  const sls = (value = slsDraft()) => ({ ...value, region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map((item) => item.trim()).filter(Boolean) });
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
      untrack(() => update({ repositoryBranches: next }));
    },
  );
  const updateRepositoryBranch = (repositoryKey: string, baseBranch: string) => {
    const next = repositoryBranches().map((branch) => branch.repositoryKey === repositoryKey ? { ...branch, baseBranch } : branch);
    setRepositoryBranches(next);
    update({ repositoryBranches: next });
  };
  const updateNacos = (change: Partial<ReturnType<typeof nacosDraft>>) => { const draft = { ...nacosDraft(), ...change }; setNacosDraft(draft); update({ nacos: nacos(draft) }); };
  const updateDb = (change: Partial<ReturnType<typeof dbDraft>>) => { currentDbDraft = { ...currentDbDraft, ...change }; setDbDraft(currentDbDraft); update({ db: db(currentDbDraft) }); };
  const addDbDatabase = () => {
    if (dbDraft().databases.length >= issuePilotConfig.limits.capability.database.databases) return;
    updateDb({ databases: [...dbDraft().databases, newDbDatabaseDraft()] });
  };
  const updateDbDatabase = (database: DbDatabaseDraft, next: DbDatabaseDraft) => {
    Object.assign(database, next);
    updateDb({ databases: [...dbDraft().databases] });
  };
  const removeDbDatabase = (database: DbDatabaseDraft) => updateDb({ databases: dbDraft().databases.filter((candidate) => candidate !== database) });
  const updateDms = (change: Partial<ReturnType<typeof dmsDraft>>) => { currentDmsDraft = { ...currentDmsDraft, ...change }; setDmsDraft(currentDmsDraft); update({ dms: dms(currentDmsDraft) }); };
  const addDmsDatabase = () => {
    if (dmsDraft().databases.length >= issuePilotConfig.limits.capability.dms.databases) return;
    updateDms({ databases: [...dmsDraft().databases, newDmsDatabaseDraft()] });
  };
  const updateDmsDatabase = (database: DmsDatabaseDraft, next: DmsDatabaseDraft) => {
    Object.assign(database, next);
    updateDms({ databases: [...dmsDraft().databases] });
  };
  const removeDmsDatabase = (database: DmsDatabaseDraft) => updateDms({ databases: dmsDraft().databases.filter((candidate) => candidate !== database) });
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const draft = { ...slsDraft(), ...change }; setSlsDraft(draft); update({ sls: sls(draft) }); };
  const updateRedis = (change: Partial<ReturnType<typeof redisDraft>>) => { const draft = { ...redisDraft(), ...change }; setRedisDraft(draft); update({ redis: redis(draft) }); };
  const updateMq = (change: Partial<ReturnType<typeof mqDraft>>) => { const draft = { ...mqDraft(), ...change }; setMqDraft(draft); update({ mq: mq(draft) }); };
  const updateEs = (change: Partial<ReturnType<typeof esDraft>>) => { const draft = { ...esDraft(), ...change }; setEsDraft(draft); update({ es: es(draft) }); };
  const capabilityOptionsForEditor = () => props.capability ? capabilityOptions.filter(row => row.key === props.capability) : capabilityOptions;
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const capabilities = [...selectedCapabilities(), key];
    setSelectedCapabilities(capabilities);
    update({ capabilities, ...(key === "nacos" ? { nacos: nacos() } : {}), ...(key === "db" ? { db: db() } : {}), ...(key === "dms" ? { dms: dms() } : {}), ...(key === "sls" ? { sls: sls() } : {}), ...(key === "redis" ? { redis: redis() } : {}), ...(key === "mq" ? { mq: mq() } : {}), ...(key === "es" ? { es: es() } : {}) });
  };
  createEffect(() => props.capability, capability => { if (capability) untrack(() => addCapability(capability)); });
  const removeCapability = (key: CapabilityName) => {
    const capabilities = selectedCapabilities().filter((capability) => capability !== key);
    setSelectedCapabilities(capabilities);
    update({ capabilities });
  };
  return (
    <div class={`service-deployment-row${expanded() ? "" : " collapsed"}`}>
      <div class="deployment-environment" aria-label={`部署 ${props.index + 1} 环境`}><strong>{props.environmentName}</strong></div>
      <div class="deployment-summary" aria-label={`部署 ${props.index + 1} 能力`}><div class="capability-labels"><Show when={codeOnly}><small>继承正式/测试能力</small></Show><For each={codeOnly ? [] : selectedCapabilities()}>{(key) => <button type="button" title={`移除 ${key} 能力`} aria-label={`移除 ${key} 能力`} onClick={() => removeCapability(key)}>{key}</button>}</For><Show when={!codeOnly && mcpSelected()}><button type="button" aria-label="移除 MCP 能力" onClick={() => { setMcpSelected(false); setMcpIds([]); update({ mcpServices: [] }); }}>MCP</button></Show></div></div>
      <Button class="icon-button deployment-toggle" type="text" shape="circle" icon={<ChevronRight size={15} />} title={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-label={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((current) => !current)} />
      <Show when={expanded()}><Show when={!codeOnly && (capabilityOptionsForEditor().some((capability) => !selectedCapabilities().includes(capability.key)) || !props.capability && !mcpSelected())}><div class="deployment-capabilities"><span>添加能力</span><div class="deployment-capability-options"><For each={capabilityOptionsForEditor().filter((capability) => !selectedCapabilities().includes(capability.key))}>{(capability) => <button type="button" class="deployment-capability-option" onClick={() => addCapability(capability.key)}>{capability.key}</button>}</For><Show when={!props.capability && !mcpSelected()}><button type="button" class="deployment-capability-option" disabled={!props.mcpServices().length} title="添加 MCP 类型能力" onClick={() => setMcpSelected(true)}>MCP</button></Show></div></div></Show>
      <Show when={!props.capability}><div class="deployment-repositories"><div class="capability-settings-head"><code>代码分支</code></div><For each={props.repositories()}>{(repository) => <label><span class="required-field">{props.repositoryName(repository)}</span><Input aria-label={`部署 ${props.index + 1} 仓库 ${props.repositoryName(repository)} 分支`} value={repositoryBranches().find((branch) => branch.repositoryKey === repository.key)?.baseBranch ?? ""} onInput={(event) => updateRepositoryBranch(repository.key, event.currentTarget.value)} /></label>}</For></div></Show>
      <For each={codeOnly ? [] : capabilityOptions.filter((capability) => selectedCapabilities().includes(capability.key) && (!props.capability || props.capability === capability.key))}>{(capability) => <Switch>
        <Match when={capability.key === "nacos"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>nacos</code></div><label><span class="required-field">serverUrl</span><Input aria-label={`nacos serverUrl ${props.index + 1}`} value={nacosDraft().serverUrl} onInput={(event) => { updateNacos({ serverUrl: event.currentTarget.value }); }} /></label><label><span>namespace</span><Input aria-label={`nacos namespace ${props.index + 1}`} value={nacosDraft().namespace} onInput={(event) => { updateNacos({ namespace: event.currentTarget.value }); }} /></label><label><span class="required-field">group</span><Input aria-label={`nacos group ${props.index + 1}`} value={nacosDraft().group} onInput={(event) => { updateNacos({ group: event.currentTarget.value }); }} /></label><label><span class="required-field">dataIds</span><Input aria-label={`nacos dataIds ${props.index + 1}`} placeholder="多个 Data ID 用逗号分隔" value={nacosDraft().dataIds} onInput={(event) => { updateNacos({ dataIds: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>认证</span><Toggle aria-label={`nacos 认证 ${props.index + 1}`} checked={nacosDraft().credentialEnabled} onChange={(checked) => updateNacos({ credentialEnabled: checked })} /></div><Show when={nacosDraft().credentialEnabled}><label><span class="required-field">username</span><Input aria-label={`nacos username ${props.index + 1}`} value={nacosDraft().username} onInput={(event) => { updateNacos({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><PasswordInput autocomplete="off" aria-label={`nacos password ${props.index + 1}`} placeholder={nacosDraft().credentialConfigured ? "已配置" : ""} value={nacosDraft().password} onInput={(event) => { updateNacos({ password: event.currentTarget.value }); }} /></label></Show></div></Match>
        <Match when={capability.key === "db"}><div class="deployment-capability-settings db-capability-settings"><div class="capability-settings-head"><code>db</code></div><div class="db-database-editor"><div class="db-database-editor-head"><div><strong>数据库范围</strong><span>每个数据库独立配置只读账号；URL 路径中的 database 名是 Agent selector</span></div><Button icon={<Plus size={13} />} disabled={dbDraft().databases.length >= issuePilotConfig.limits.capability.database.databases} onClick={addDbDatabase}>添加 MySQL 数据库</Button></div><div class="db-database-list"><For each={dbDraft().databases}>{(database, databaseIndex) => <DbDatabaseEditorRow deploymentIndex={props.index + 1} databaseIndex={databaseIndex() + 1} database={database} only={dbDraft().databases.length === 1} onChange={(next) => updateDbDatabase(database, next)} onDelete={() => removeDbDatabase(database)} />}</For></div></div></div></Match>
        <Match when={capability.key === "dms"}><div class="deployment-capability-settings dms-capability-settings"><div class="capability-settings-head"><code>dms</code></div><label><span class="required-field">地址</span><Input aria-label={`dms 地址 ${props.index + 1}`} value={dmsDraft().url} onInput={event => updateDms({ url: event.currentTarget.value })} /></label><label><span class="required-field">Token</span><PasswordInput aria-label={`dms Token ${props.index + 1}`} value={dmsDraft().authorization} placeholder={dmsDraft().credentialConfigured ? "已配置，留空保留" : "Bearer token"} onInput={event => updateDms({ authorization: event.currentTarget.value })} /></label><div class="dms-database-editor"><div class="dms-database-editor-head"><div><strong>数据库范围</strong><span>Agent 直接选择已授权 schema，每个 alias/schema 由后台解析</span></div><Button icon={<Plus size={13} />} disabled={dmsDraft().databases.length >= issuePilotConfig.limits.capability.dms.databases} onClick={addDmsDatabase}>添加 DMS 数据库</Button></div><div class="dms-database-list"><For each={dmsDraft().databases}>{(database, databaseIndex) => <DmsDatabaseEditorRow deploymentIndex={props.index + 1} databaseIndex={databaseIndex() + 1} database={database} connection={() => ({ url: dmsDraft().url, authorization: dmsDraft().authorization, environmentKey: initialDeployment.environmentKey, ...(props.serviceKey ? { serviceKey: props.serviceKey } : {}) })} only={dmsDraft().databases.length === 1} onChange={(next) => updateDmsDatabase(database, next)} onDelete={() => removeDmsDatabase(database)} />}</For></div></div></div></Match>
        <Match when={capability.key === "redis"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>redis</code></div><label><span class="required-field">host</span><Input aria-label={`redis host ${props.index + 1}`} value={redisDraft().host} onInput={(event) => { updateRedis({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`redis port ${props.index + 1}`} value={redisDraft().port} onInput={(event) => { updateRedis({ port: event.currentTarget.value }); }} /></label><label><span>username</span><Input aria-label={`redis username ${props.index + 1}`} value={redisDraft().username} onInput={(event) => { updateRedis({ username: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>密码</span><Toggle aria-label={`redis 密码 ${props.index + 1}`} checked={redisDraft().credentialEnabled} onChange={(checked) => updateRedis({ credentialEnabled: checked })} /></div><Show when={redisDraft().credentialEnabled}><label><span class="required-field">password</span><PasswordInput autocomplete="off" aria-label={`redis password ${props.index + 1}`} placeholder={redisDraft().credentialConfigured ? "已配置" : ""} value={redisDraft().password} onInput={(event) => { updateRedis({ password: event.currentTarget.value }); }} /></label></Show><label><span class="required-field">database</span><Input aria-label={`redis database ${props.index + 1}`} value={redisDraft().database} onInput={(event) => { updateRedis({ database: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "mq"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>mq</code></div><label><span class="required-field">host</span><Input aria-label={`mq host ${props.index + 1}`} value={mqDraft().host} onInput={(event) => { updateMq({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`mq port ${props.index + 1}`} value={mqDraft().port} onInput={(event) => { updateMq({ port: event.currentTarget.value }); }} /></label><label><span class="required-field">managementPort</span><Input aria-label={`mq managementPort ${props.index + 1}`} value={mqDraft().managementPort} onInput={(event) => { updateMq({ managementPort: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`mq username ${props.index + 1}`} value={mqDraft().username} onInput={(event) => { updateMq({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><PasswordInput autocomplete="off" aria-label={`mq password ${props.index + 1}`} placeholder={mqDraft().credentialConfigured ? "已配置" : ""} value={mqDraft().password} onInput={(event) => { updateMq({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">virtualHost</span><Input aria-label={`mq virtualHost ${props.index + 1}`} value={mqDraft().virtualHost} onInput={(event) => { updateMq({ virtualHost: event.currentTarget.value }); }} /></label></div></Match>
        <Match when={capability.key === "es"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>es</code></div><label><span class="required-field">url</span><Input aria-label={`es url ${props.index + 1}`} placeholder="http://es.example.com" value={esDraft().url} onInput={(event) => { updateEs({ url: event.currentTarget.value }); }} /></label><div class="deployment-capability-field"><span>认证</span><Toggle aria-label={`es 认证 ${props.index + 1}`} checked={esDraft().credentialEnabled} onChange={(checked) => updateEs({ credentialEnabled: checked })} /></div><Show when={esDraft().credentialEnabled}><label><span class="required-field">username</span><Input aria-label={`es username ${props.index + 1}`} value={esDraft().username} onInput={(event) => { updateEs({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><PasswordInput autocomplete="off" aria-label={`es password ${props.index + 1}`} placeholder={esDraft().credentialConfigured ? "已配置" : ""} value={esDraft().password} onInput={(event) => { updateEs({ password: event.currentTarget.value }); }} /></label></Show></div></Match>
        <Match when={capability.key === "sls"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">AccessKey ID</span><PasswordInput aria-label={`sls AccessKey ID ${props.index + 1}`} value={slsDraft().accessKeyId} placeholder={slsDraft().credentialConfigured ? "已配置，留空保留" : ""} onInput={event => updateSls({ accessKeyId: event.currentTarget.value })} /></label><label><span class="required-field">AccessKey Secret</span><PasswordInput aria-label={`sls AccessKey Secret ${props.index + 1}`} value={slsDraft().accessKeySecret} onInput={event => updateSls({ accessKeySecret: event.currentTarget.value })} /></label><label><span class="required-field">region</span><Input aria-label={`sls region ${props.index + 1}`} placeholder="cn-hangzhou" value={slsDraft().region} onInput={(event) => { updateSls({ region: event.currentTarget.value }); }} /></label><label><span class="required-field">project</span><Input aria-label={`sls project ${props.index + 1}`} value={slsDraft().project} onInput={(event) => { updateSls({ project: event.currentTarget.value }); }} /></label><label><span class="required-field">logstore</span><Input aria-label={`sls logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsDraft().logstores} onInput={(event) => { updateSls({ logstores: event.currentTarget.value }); }} /></label></div></Match>
      </Switch>}</For><Show when={!codeOnly && !props.capability && mcpSelected()}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>MCP</code></div><label><span>已配置的 MCP 能力</span><Select mode="multiple" aria-label={`部署 ${props.index + 1} MCP 能力`} value={mcpIds()} options={props.mcpServices().map(row => ({ value: row.id, label: row.name + (row.enabled ? "" : " · 已关闭") }))} onChange={ids => { setMcpIds(ids); update({ mcpServices: ids }); }} /></label></div></Show></Show>
    </div>
  );
}

export function ConfigurationView() {
  const { currentUser, configuration, configurationLoaded, refreshCatalog, refreshConfiguration, configurationError: resourceError } = useApplicationResources();
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<ServiceRepositoryDraft[]>([], { ownedWrite: true });
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
  const [configurationDescription, setConfigurationDescription] = createSignal<{ serviceKey: string; subject: string; context: string } | null>(null, { ownedWrite: true });
  const [descriptionError, setDescriptionError] = createSignal("", { ownedWrite: true });
  let descriptionController: AbortController | undefined;
  createEffect(() => ({ service: selectedService(), user: currentUser() }), ({ service, user }) => {
    descriptionController?.abort(); setConfigurationDescription(null); setDescriptionError("");
    if (!service || user?.role !== "developer") return;
    const controller = new AbortController(); descriptionController = controller;
    void loadServiceConfigurationDescription(service.key, controller.signal).then(value => {
      if (!controller.signal.aborted) setConfigurationDescription({ serviceKey: service.key, subject: user.subject, context: value.context });
    }).catch(() => { if (!controller.signal.aborted) setDescriptionError("无法读取完整配置，请刷新重试"); });
  });
  onCleanup(() => { descriptionController?.abort(); });
  const visibleConfigurationDescription = () => {
    const value = configurationDescription();
    return currentUser()?.role === "developer" && value?.serviceKey === selectedServiceKey() && value.subject === currentUser()?.subject ? value.context : undefined;
  };
  const environmentDrafts = (service?: Service): ServiceDeploymentDraft[] => ["dev", "test", "prod"].map(environmentKey => {
    const existing = service?.deployments.find(row => row.environmentKey === environmentKey);
    return existing ? serviceDeploymentDraft(existing) : { environmentKey, mcpServices: [], capabilities: [], repositoryBranches: service?.repositories.map(repository => ({ repositoryKey: repository.id, baseBranch: issuePilotConfig.defaults.deployment.baseBranch })) ?? [] };
  });
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setServiceRepositories([]); setServiceDeployments(() => environmentDrafts()); setEditingServiceKey(null);
  };
  const [repositoryChoices, setRepositoryChoices] = createSignal<ManagedRepository[]>([], { ownedWrite: true });
  const [mcpChoices, setMcpChoices] = createSignal<McpService[]>([], { ownedWrite: true });
  const [repositoryLoading, setRepositoryLoading] = createSignal(false, { ownedWrite: true });
  const [repositoryError, setRepositoryError] = createSignal("", { ownedWrite: true });
  let repositoryGeneration = 0;
  const loadRepositoryChoices = () => {
    const generation = ++repositoryGeneration;
    setRepositoryLoading(true); setRepositoryError("");
    void Promise.all([loadRepositories(), loadMcpServices()]).then(([rows, mcp]) => { if (generation === repositoryGeneration) { setRepositoryChoices(rows); setMcpChoices(mcp); } })
      .catch((cause) => { if (generation === repositoryGeneration) setRepositoryError(errorMessage(cause)); })
      .finally(() => { if (generation === repositoryGeneration) setRepositoryLoading(false); });
  };
  createEffect(() => configuration().services, () => loadRepositoryChoices());
  onCleanup(() => { repositoryGeneration += 1; });
  const openNewService = () => {
    loadRepositoryChoices();
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: Service) => {
    loadRepositoryChoices();
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, key: repository.id, alias: repository.alias, url: repository.url })));
    const deployments = environmentDrafts(service);
    setServiceDeployments(() => deployments);
    setConfigurationError(""); setServiceOpen(true);
  };
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length) return "请至少选择一个关联仓库";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (serviceDeployments.some((deployment) => !deployment.environmentKey || deployment.repositoryBranches.length !== serviceRepositories().length || deployment.repositoryBranches.some((branch) => !branch.baseBranch.trim()))) return "请填写所有部署环境和仓库分支";
    if (new Set(serviceDeployments.map((deployment) => deployment.environmentKey)).size !== serviceDeployments.length) return "同一环境只能配置一个部署";
    return serviceDeployments.map(deploymentValidationError).find(Boolean) ?? "";
  };
  const repositoryName = (repository: ServiceRepositoryDraft) => repositoryChoices().find((choice) => choice.url === repository.url)?.name ?? "仓库";
  const repositoryOptions = createMemo(() => repositoryChoices().map((repository) => ({ value: repository.url, label: repository.name, url: repository.url })));
  const selectRepositories = (urls: string[]) => {
    const previous = new Map(serviceRepositories().map((repository) => [repository.url, repository]));
    const choices = new Map(repositoryChoices().map((repository) => [repository.url, repository]));
    const next = [...new Set(urls)].map((url) => {
      const existing = previous.get(url);
      if (existing) return existing;
      const choice = choices.get(url);
      if (!choice) throw new Error("repository_not_registered");
      return { key: `catalog-${choice.id}`, alias: `repository-${choice.id}`, url };
    });
    setServiceRepositories(next);
    setServiceDeployments((deployments) => {
      for (const deployment of deployments) {
        deployment.repositoryBranches = next.map((repository) => deployment.repositoryBranches.find((branch) => branch.repositoryKey === repository.key) ?? { repositoryKey: repository.key, baseBranch: issuePilotConfig.defaults.deployment.baseBranch });
      }
    });
  };
  let serviceErrorElement: HTMLDivElement | undefined;
  const showServiceSaveError = (message: string) => {
    setConfigurationError(message);
    window.requestAnimationFrame(() => serviceErrorElement?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
  };
  const saveService = async () => {
    if (saving()) return;
    const validationError = serviceValidationError();
    if (validationError) { showServiceSaveError(validationError); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), alias: repository.alias.trim(), url: repository.url.trim() })),
        deployments: serviceDeployments.map(deployment => serializeServiceDeployment(deployment, serviceRepositories())),
      };
      const editingKey = editingServiceKey();
      if (editingKey) await updateService(editingKey, definition);
      else await createService(definition);
      await refresh();
      setServiceOpen(false); resetServiceForm();
    } catch (error) {
      showServiceSaveError(serviceSaveErrorMessage(error));
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
        <Show when={selectedService()} fallback={<div class="empty-band">暂无服务</div>}>{(service) => (<>
          <Show when={descriptionError()}><div class="workspace-error" role="alert">{descriptionError()}<Button size="small" onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div></Show>
          <ServiceOverview service={service()} configurationDescription={visibleConfigurationDescription()} repositories={repositoryChoices()} environments={configuration().environments} />
        </>)}</Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} okButtonProps={{ disabled: repositoryLoading() || Boolean(repositoryError()) }} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div ref={element => { serviceErrorElement = element; }} class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">关联仓库</strong><span>可多选，仓库名称和地址统一在仓库配置中维护</span></div><span class="service-repository-count">已选 {serviceRepositories().length} 个</span></div><Show when={repositoryError()}><div class="workspace-error" role="alert">仓库加载失败：{repositoryError()}<Button size="small" onClick={loadRepositoryChoices}>重试</Button></div></Show><Select mode="multiple" aria-label="关联仓库" placeholder="选择已登记仓库（可多选）" loading={repositoryLoading()} value={serviceRepositories().map((repository) => repository.url)} options={repositoryOptions()} showSearch={{ filterOption: (query, option) => `${option.label} ${option.url}`.toLowerCase().includes(query.trim().toLowerCase()) }} optionRender={(option) => <span class="service-repository-option"><strong>{option.label}</strong><code>{option.url}</code></span>} onChange={selectRepositories} maxTagCount={4} listHeight={360} notFoundContent="暂无可选仓库，请先在仓库配置中添加" /><Show when={!repositoryLoading() && !repositoryError() && !repositoryChoices().length}><p class="service-form-empty">暂无已登记仓库，请先在“配置 → 仓库”中添加。</p></Show></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>在服务中设置各环境参数；开发环境仅配置分支，查询能力继承正式和测试</span></div></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow serviceKey={editingServiceKey()} mcpServices={mcpChoices} index={index()} deployment={deployment} repositories={serviceRepositories} repositoryName={repositoryName} environmentName={configuration().environments.find((environment) => environment.key === deployment.environmentKey)?.name ?? deployment.environmentKey} onChange={(next) => setServiceDeployments((current) => { Object.assign(current[index()]!, next); })} />}</For></div></div>
          <label class="service-form-field"><span>服务描述（Markdown）</span><TextArea aria-label="项目描述" placeholder="记录业务知识、排查步骤和查询范例；分支和公开能力参数会自动附加到展示及 AI 读取的描述中。" autoSize={{ minRows: 5, maxRows: 10 }} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
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
