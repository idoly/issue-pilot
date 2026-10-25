import { Button, Input, PasswordInput, Modal, Select, Skeleton, TextArea } from "../ui";
import { createEffect, createMemo, createSignal, createStore, For, Match, onCleanup, Show, snapshot, Switch, untrack } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { ChevronRight, Pencil, Plus, Trash2 } from "../ui/icons";
import { loadServiceMysqlTargets, loadRepositories, loadServiceConfigurationDescription, type ServiceInput, type ManagedRepository, createService, deleteService, errorMessage, resolveDmsScope, updateService, type CapabilityName, type Service } from "../data/client";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";
import { MysqlTargetsEditor, SlsTargetsEditor } from "./ServiceTargets";
import { ServiceOverview } from "./ServiceOverview";
import { useApplicationResources } from "./ApplicationResources";

function serviceSaveErrorMessage(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    configuration_changed: "配置已更新，请重新打开服务后再保存。当前输入已保留。",
    development_branches_inherited: "开发基线必须继承正式分支",
    development_production_deployment_required: "请配置正式环境分支",
    dms_credentials_target_changed: "DMS URL 已变更，请填写该地址的新 Authorization",
    invalid_dms_url: "请填写有效的 DMS MCP HTTPS URL",
    invalid_dms_authorization: "请填写完整的 Bearer 格式 DMS MCP Authorization",
    invalid_dms_database: "DMS 数据库解析结果无效，请重新填写",
    invalid_dms_databases: "请至少配置一个且不超过 20 个 DMS 数据库",
    duplicate_dms_database_schema: "DMS schema 不能重复",
    duplicate_dms_database_id: "同一个 DMS 数据库不能配置多次",
    dms_mcp_connection_failed: "无法连接 DMS MCP，请检查 URL 和 Authorization",
    dms_mcp_http_429: "DMS MCP 请求被限流（HTTP 429），请稍后重试；频繁发生时请检查入口请求量和服务额度",
    dms_mcp_http_401: "DMS MCP 认证失败（HTTP 401），请检查 Authorization",
    dms_mcp_http_403: "DMS MCP 拒绝访问（HTTP 403），请检查凭证权限",
    dms_mcp_scope_resolve_unavailable: "当前 DMS MCP 未提供实例或数据库解析工具",
    dms_mcp_scope_resolve_failed: "未找到该实例或数据库，或 DMS 无法连接目标实例",
    dms_mcp_scope_resolve_invalid_response: "DMS 返回了无法识别或不唯一的实例/数据库信息",
    invalid_sls_access_key_secret: "请填写 SLS AccessKeySecret",
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

type ServiceDeploymentDraft = DeploymentCapabilityDraft & {
  environmentKey: string;
  mysql?: import("../../../domain/contracts").MysqlTarget[];
  repositoryBranches: Array<{ repositoryKey: string; baseBranch: string }>;
};

type DmsDatabaseDraft = NonNullable<ServiceDeploymentDraft["dms"]>["databases"][number];
const newDmsDatabaseDraft = (): DmsDatabaseDraft => ({ instanceAlias: "", schemaName: "", instanceId: "", instanceHost: "", instancePort: "", databaseId: "" });

function serviceDeploymentDraft(deployment: Service["deployments"][number]): ServiceDeploymentDraft {
  return {
    environmentKey: deployment.environmentKey,
    repositoryBranches: deployment.repositoryBranches.map(branch => ({ repositoryKey: branch.repositoryId, baseBranch: branch.baseBranch })), capabilities: [...deployment.capabilities],
    ...(deployment.dms ? { dms: { ...deployment.dms, authorization: "", databases: deployment.dms.databases.map(database => ({ ...database })) } } : {}),
    ...(deployment.mysql ? { mysql: deployment.mysql.map(({ passwordConfigured: _configured, ...target }) => ({ ...target, password: "" })) } : {}),
    ...(deployment.sls ? { sls: { ...deployment.sls, accessKeyId: "", accessKeySecret: "", logstores: [...deployment.sls.logstores] } } : {}),
  };
}

function serializeServiceDeployment(deployment: ServiceDeploymentDraft, repositories: ServiceRepositoryDraft[]): ServiceInput["deployments"][number] {
  return { environmentKey: deployment.environmentKey, capabilities: [...deployment.capabilities], repositoryBranches: deployment.environmentKey === "dev" ? [] : deployment.repositoryBranches.map(branch => ({ repositoryAlias: repositories.find(repository => repository.key === branch.repositoryKey)!.alias, baseBranch: branch.baseBranch.trim() })), ...(deployment.mysql?.length ? { mysql: deployment.mysql } : {}), ...serializeCapabilityDraft(deployment) };
}

function deploymentValidationError(deployment: ServiceDeploymentDraft): string {
  if (deployment.environmentKey === "dev") return "";
  if (deployment.repositoryBranches.some(branch => !branch.baseBranch.trim())) return "请填写所有仓库分支";
  if (deployment.capabilities.includes("dms")) {
    if (!deployment.dms?.url.trim()) return "请填写 DMS 地址";
    if (!deployment.dms.databases.length) return "请添加 DMS 数据库";
    if (deployment.dms.databases.some(database => !database.instanceAlias.trim() || !database.schemaName.trim())) return "请填写全部 DMS 数据库的实例和 schema";
  }
  if (deployment.capabilities.includes("sls") && (!deployment.sls?.region.trim() || !deployment.sls.project.trim() || !deployment.sls.logstores.length)) return "请填写 SLS 日志目标";
  return "";
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

function ServiceDeploymentEditorRow(props: {
  serviceKey: string | null;
  index: number;
  deployment: ServiceDeploymentDraft;
  environmentName: string;
  productionBranches: () => ServiceDeploymentDraft["repositoryBranches"];
  repositoryName: (repository: ServiceRepositoryDraft) => string;
  repositories: () => ServiceRepositoryDraft[];
  onChange: (deployment: ServiceDeploymentDraft) => void;
}) {
  // The row owns its draft after mount; parent updates are emitted through onChange, not reapplied.
  const initialDeployment = untrack(() => snapshot(props.deployment));
  let currentDeployment = initialDeployment;
  let dmsTargets: HTMLDivElement | undefined;
  const codeOnly = initialDeployment.environmentKey === "dev";
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const [repositoryBranches, setRepositoryBranches] = createSignal(initialDeployment.repositoryBranches, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...initialDeployment.capabilities], { ownedWrite: true });
  let currentDmsDraft = { url: initialDeployment.dms?.url ?? issuePilotConfig.defaults.dms.sseUrl, authorization: "", credentialConfigured: initialDeployment.dms?.credentialConfigured ?? false, databases: initialDeployment.dms?.databases?.map(database => ({ ...database })) ?? [newDmsDatabaseDraft()] };
  const [dmsDraft, setDmsDraft] = createSignal(currentDmsDraft, { ownedWrite: true });
  const initialSlsTarget = initialDeployment.sls?.targets?.[0] ?? initialDeployment.sls;
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: "", accessKeySecret: "", credentialConfigured: initialDeployment.sls?.credentialConfigured ?? false, region: initialSlsTarget?.region ?? "", project: initialSlsTarget?.project ?? "", logstores: initialSlsTarget?.logstores.join(", ") ?? "",...(initialDeployment.sls?.targets ? { targets: initialDeployment.sls.targets.map(target => ({ ...target, logstores: [...target.logstores] })) } : {}) }, { ownedWrite: true });
  const dms = (value = dmsDraft()) => ({ ...value, databases: value.databases.map((database) => ({ instanceAlias: database.instanceAlias.trim(), schemaName: database.schemaName.trim(), instanceId: database.instanceId.trim(), instanceHost: database.instanceHost.trim(), instancePort: database.instancePort.trim(), databaseId: database.databaseId.trim() })) });
  const sls = (value = slsDraft()) => {
    const fields = { region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map(item => item.trim()).filter(Boolean) };
    return { ...value, ...fields, ...(value.targets ? { targets: value.targets.map((target, index) => index === 0 ? { ...target, ...fields } : { ...target, logstores: [...target.logstores] }) } : {}) };
  };
  const update = (change: Partial<ServiceDeploymentDraft>) => {
    currentDeployment = { ...currentDeployment, ...change };
    props.onChange(snapshot(currentDeployment));
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
  const updateDms = (change: Partial<ReturnType<typeof dmsDraft>>) => { currentDmsDraft = { ...currentDmsDraft, ...change }; setDmsDraft(currentDmsDraft); update({ dms: dms(currentDmsDraft) }); };
  const addDmsDatabase = () => {
    if (dmsDraft().databases.length >= issuePilotConfig.limits.capability.dms.databases) return;
    updateDms({ databases: [...dmsDraft().databases, newDmsDatabaseDraft()] });
    requestAnimationFrame(() => {
      if (!dmsTargets?.isConnected) return;
      const input = dmsTargets.querySelector<HTMLInputElement>(".dms-database-row:last-child input");
      input?.focus({ preventScroll: true }); input?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const updateDmsDatabase = (database: DmsDatabaseDraft, next: DmsDatabaseDraft) => {
    Object.assign(database, next);
    updateDms({ databases: [...dmsDraft().databases] });
  };
  const removeDmsDatabase = (database: DmsDatabaseDraft) => updateDms({ databases: dmsDraft().databases.filter((candidate) => candidate !== database) });
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const draft = { ...slsDraft(), ...change }; setSlsDraft(draft); update({ sls: sls(draft) }); };
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const capabilities = [...selectedCapabilities(), key];
    setSelectedCapabilities(capabilities);
    update({ capabilities, ...(key === "dms" ? { dms: dms() } : {}), ...(key === "sls" ? { sls: sls() } : {}) });
  };
  const removeCapability = (key: CapabilityName) => {
    const capabilities = selectedCapabilities().filter((capability) => capability !== key);
    setSelectedCapabilities(capabilities);
    update({ capabilities });
  };
  return (
    <div class={`service-deployment-row${expanded() ? "" : " collapsed"}`}>
      <div class="deployment-environment" aria-label={`部署 ${props.index + 1} 环境`}><strong>{props.environmentName}</strong></div>
      <div class="deployment-summary" aria-label={`部署 ${props.index + 1} 能力`}><div class="capability-labels"><Show when={codeOnly}><small>分支继承正式 · 查询继承正式/测试</small></Show><For each={codeOnly ? [] : selectedCapabilities()}>{(key) => <button type="button" title={`移除 ${key} 能力`} aria-label={`移除 ${key} 能力`} onClick={() => removeCapability(key)}>{key}</button>}</For></div></div>
      <Button class="icon-button deployment-toggle" type="text" shape="circle" icon={<ChevronRight size={15} />} title={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-label={`${expanded() ? "收起" : "展开"}部署${props.index + 1}`} aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((current) => !current)} />
      <Show when={expanded()}><Show when={!codeOnly && CAPABILITY_KEYS.some(key => !selectedCapabilities().includes(key))}><div class="deployment-capabilities"><span>添加能力</span><div class="deployment-capability-options"><For each={CAPABILITY_KEYS.filter(key => !selectedCapabilities().includes(key))}>{key => <button type="button" class="deployment-capability-option" onClick={() => addCapability(key)}>{key}</button>}</For></div></div></Show>
      <div class="deployment-repositories"><div class="capability-settings-head"><code>代码分支</code></div><For each={props.repositories()}>{(repository) => <label><span class="required-field">{props.repositoryName(repository)}</span><Show when={codeOnly} fallback={<Input aria-label={`部署 ${props.index + 1} 仓库 ${props.repositoryName(repository)} 分支`} value={repositoryBranches().find((branch) => branch.repositoryKey === repository.key)?.baseBranch ?? ""} onInput={(event) => updateRepositoryBranch(repository.key, event.currentTarget.value)} />}><code class="inherited-branch" aria-label={`${props.repositoryName(repository)} 开发基线`}>{props.productionBranches().find(branch => branch.repositoryKey === repository.key)?.baseBranch.trim() || "待配置正式分支"}</code></Show></label>}</For></div>
      <Show when={!codeOnly}><MysqlTargetsEditor value={currentDeployment.mysql ?? []} environment={initialDeployment.environmentKey} onChange={mysql => update({ mysql })} /></Show>
      <For each={codeOnly ? [] : CAPABILITY_KEYS.filter(key => selectedCapabilities().includes(key))}>{key => <Switch>
        <Match when={key === "dms"}><div class="deployment-capability-settings dms-capability-settings"><div class="capability-settings-head"><code>dms</code></div><label><span class="required-field">地址</span><Input aria-label={`dms 地址 ${props.index + 1}`} value={dmsDraft().url} onInput={event => updateDms({ url: event.currentTarget.value })} /></label><label><span class="required-field">Token</span><PasswordInput aria-label={`dms Token ${props.index + 1}`} value={dmsDraft().authorization} placeholder={dmsDraft().credentialConfigured ? "已配置，留空保留" : "Bearer token"} onInput={event => updateDms({ authorization: event.currentTarget.value })} /></label><div class="dms-database-editor"><div class="dms-database-editor-head"><div><strong>数据库范围</strong><span>Agent 直接选择已授权 schema，每个 alias/schema 由后台解析</span></div><Button icon={<Plus size={13} />} disabled={dmsDraft().databases.length >= issuePilotConfig.limits.capability.dms.databases} onClick={addDmsDatabase}>添加 DMS 数据库</Button></div><div ref={value => { dmsTargets = value; }} class="dms-database-list"><For each={dmsDraft().databases}>{(database, databaseIndex) => <DmsDatabaseEditorRow deploymentIndex={props.index + 1} databaseIndex={databaseIndex() + 1} database={database} connection={() => ({ url: dmsDraft().url, authorization: dmsDraft().authorization, environmentKey: initialDeployment.environmentKey, ...(props.serviceKey ? { serviceKey: props.serviceKey } : {}) })} only={dmsDraft().databases.length === 1} onChange={(next) => updateDmsDatabase(database, next)} onDelete={() => removeDmsDatabase(database)} />}</For></div></div></div></Match>
        <Match when={key === "sls"}><div class="deployment-capability-settings"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">AccessKey ID</span><PasswordInput aria-label={`sls AccessKey ID ${props.index + 1}`} value={slsDraft().accessKeyId} placeholder={slsDraft().credentialConfigured ? "已配置，留空保留" : ""} onInput={event => updateSls({ accessKeyId: event.currentTarget.value })} /></label><label><span class="required-field">AccessKey Secret</span><PasswordInput aria-label={`sls AccessKey Secret ${props.index + 1}`} value={slsDraft().accessKeySecret} onInput={event => updateSls({ accessKeySecret: event.currentTarget.value })} /></label><SlsTargetsEditor deploymentIndex={props.index + 1} value={slsDraft().targets ?? [{ name: initialDeployment.environmentKey, region: slsDraft().region, project: slsDraft().project, logstores: slsDraft().logstores.split(",").map(value => value.trim()).filter(Boolean) }]} onChange={targets => updateSls({ targets: targets.length === 1 && !initialDeployment.sls?.targets && targets[0]?.name === initialDeployment.environmentKey ? undefined : targets, region: targets[0]?.region ?? "", project: targets[0]?.project ?? "", logstores: targets[0]?.logstores.join(", ") ?? "" })} /></div></Match>
      </Switch>}</For></Show>
    </div>
  );
}

export function ConfigurationView(props: { selectedServiceKey?: string; onSelectService?: (key: string) => void } = {}) {
  const { currentUser, configuration, configurationLoaded, refreshCatalog, refreshConfiguration, configurationError: resourceError } = useApplicationResources();
  const canConfigure = () => currentUser()?.role === "developer";
  let editorGeneration = 0, serviceRevisionDraft: number | undefined;
  const [mysqlLoading, setMysqlLoading] = createSignal(false, { ownedWrite: true });
  const [saveConflict, setSaveConflict] = createSignal(false, { ownedWrite: true });
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
  const refresh = async (owner: number) => {
    try {
      await Promise.all([refreshConfiguration(), refreshCatalog()]);
      if (owner === editorGeneration) setConfigurationError("");
    } catch (error) {
      if (owner === editorGeneration) setConfigurationError(errorMessage(error));
    }
  };
  createEffect(
    () => ({ services: configuration().services, selectedKey: selectedServiceKey() }),
    ({ services, selectedKey }) => { if (!services.some((service) => service.key === selectedKey)) setSelectedServiceKey(services[0]?.key ?? ""); },
  );
  createEffect(() => props.selectedServiceKey, key => { if (key) setSelectedServiceKey(key); });
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
  onCleanup(() => { editorGeneration++; descriptionController?.abort(); });
  const visibleConfigurationDescription = () => {
    const value = configurationDescription();
    return currentUser()?.role === "developer" && value?.serviceKey === selectedServiceKey() && value.subject === currentUser()?.subject ? value.context : undefined;
  };
  const environmentDrafts = (service?: Service): ServiceDeploymentDraft[] => ["dev", "test", "prod"].map(environmentKey => {
    const existing = service?.deployments.find(row => row.environmentKey === environmentKey);
    return existing ? serviceDeploymentDraft(existing) : { environmentKey, capabilities: [], repositoryBranches: service?.repositories.map(repository => ({ repositoryKey: repository.id, baseBranch: issuePilotConfig.defaults.deployment.baseBranch })) ?? [] };
  });
  const resetServiceForm = () => {
    serviceRevisionDraft = undefined; setMysqlLoading(false); setSaveConflict(false);
    setServiceName(""); setDescription(""); setServiceRepositories([]); setServiceDeployments(() => environmentDrafts()); setEditingServiceKey(null);
  };
  const closeServiceEditor = () => {
    editorGeneration++;
    setServiceOpen(false);
    resetServiceForm();
    setSaving(false);
    setConfigurationError("");
  };
  createEffect(() => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, (identity, previous) => {
    if (identity === previous) return;
    closeServiceEditor(); setDeleteTarget(null);
  });
  const [repositoryChoices, setRepositoryChoices] = createSignal<ManagedRepository[]>([], { ownedWrite: true });
  const [repositoryLoading, setRepositoryLoading] = createSignal(false, { ownedWrite: true });
  const [repositoryError, setRepositoryError] = createSignal("", { ownedWrite: true });
  let repositoryGeneration = 0;
  const loadRepositoryChoices = () => {
    const generation = ++repositoryGeneration;
    setRepositoryLoading(true); setRepositoryError("");
    void loadRepositories().then(rows => { if (generation === repositoryGeneration) setRepositoryChoices(rows); })
      .catch((cause) => { if (generation === repositoryGeneration) setRepositoryError(errorMessage(cause)); })
      .finally(() => { if (generation === repositoryGeneration) setRepositoryLoading(false); });
  };
  createEffect(() => configuration().services, () => loadRepositoryChoices());
  onCleanup(() => { repositoryGeneration += 1; });
  const openNewService = () => {
    editorGeneration++;
    loadRepositoryChoices();
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: Service) => {
    loadRepositoryChoices();
    const owner = ++editorGeneration;
    serviceRevisionDraft = service.revision; setMysqlLoading(false); setSaveConflict(false);
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, key: repository.id, alias: repository.alias, url: repository.url })));
    const deployments = environmentDrafts(service);
    setServiceDeployments(() => deployments);
    setConfigurationError(""); setServiceOpen(true);
    if (service.deployments.some(deployment => deployment.mysql?.length)) {
      setMysqlLoading(true);
      void loadServiceMysqlTargets(service.key).then(value => {
        if (owner !== editorGeneration) return;
        if (value.revision !== service.revision) throw new Error("configuration_changed");
        const loaded = environmentDrafts(service).map(deployment => ({ ...deployment, mysql: value.deployments.find(row => row.environmentKey === deployment.environmentKey)?.mysql ?? [] }));
        setServiceDeployments(() => loaded);
        setMysqlLoading(false);
      }).catch(error => { if (owner === editorGeneration) setConfigurationError(serviceSaveErrorMessage(error)); });
    }
  };
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length) return "请至少选择一个关联仓库";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (serviceDeployments.some((deployment) => !deployment.environmentKey || deployment.environmentKey !== "dev" && (deployment.repositoryBranches.length !== serviceRepositories().length || deployment.repositoryBranches.some((branch) => !branch.baseBranch.trim())))) return "请填写所有部署环境和仓库分支";
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
    if (saving() || mysqlLoading() || !canConfigure()) return;
    const owner = editorGeneration;
    const validationError = serviceValidationError();
    if (validationError) { showServiceSaveError(validationError); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        expectedRevision: serviceRevisionDraft, name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), alias: repository.alias.trim(), url: repository.url.trim() })),
        deployments: serviceDeployments.map(deployment => serializeServiceDeployment(deployment, serviceRepositories())),
      };
      const editingKey = editingServiceKey();
      if (editingKey) await updateService(editingKey, definition);
      else await createService(definition);
      await refresh(owner);
      if (owner === editorGeneration) closeServiceEditor();
    } catch (error) {
      if (owner === editorGeneration) { setSaveConflict(error instanceof Error && error.message === "configuration_changed"); showServiceSaveError(serviceSaveErrorMessage(error)); }
    } finally { if (owner === editorGeneration) setSaving(false); }
  };
  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target || saving() || !canConfigure()) return;
    const owner = editorGeneration;
    setSaving(true); setConfigurationError("");
    try {
      await deleteService(target.key);
      if (owner === editorGeneration) setDeleteTarget(null);
      await refresh(owner);
    } catch (error) {
      if (owner === editorGeneration) setConfigurationError(serviceSaveErrorMessage(error));
    } finally { if (owner === editorGeneration) setSaving(false); }
  };
  return (
    <main class="configuration-workspace">
      <Show when={!configurationLoaded()}><section class="queue-loading configuration-loading"><Show when={resourceError()} fallback={<Skeleton active paragraph={{ rows: 10 }} />}><div class="workspace-error" role="alert"><span>{resourceError()}</span><Button onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div></Show></section></Show>
      <section class="service-panel" hidden={!configurationLoaded()}>
        <div class="service-tabs"><div class="service-tabs-inner"><div class="service-tab-list" role="tablist" aria-label="服务列表"><For each={configuration().services}>{(service) => <button type="button" role="tab" aria-selected={selectedServiceKey() === service.key ? "true" : "false"} class={selectedServiceKey() === service.key ? "selected" : ""} onClick={() => { setSelectedServiceKey(service.key); props.onSelectService?.(service.key); }}>{service.name}</button>}</For></div><div class="service-tab-actions"><Button icon={<Plus size={14} />} disabled={!canConfigure()} onClick={openNewService}>添加</Button><Show when={selectedService()}>{(service) => <Button type="primary" icon={<Pencil size={14} />} disabled={!canConfigure()} onClick={() => openServiceEditor(service())}>编辑</Button>}</Show></div></div></div>
        <Show when={resourceError()}><div class="workspace-error" role="alert">{resourceError()}</div></Show>
        <Show when={selectedService()} fallback={<div class="empty-band">暂无服务</div>}>{(service) => (<>
          <Show when={descriptionError()}><div class="workspace-error" role="alert">{descriptionError()}<Button size="small" onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div></Show>
          <ServiceOverview service={service()} configurationDescription={visibleConfigurationDescription()} repositories={repositoryChoices()} environments={configuration().environments} />
        </>)}</Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} okButtonProps={{ disabled: mysqlLoading() || repositoryLoading() || Boolean(repositoryError()) }} onOk={() => { void saveService(); }} onCancel={closeServiceEditor}>
        <div class="service-form">
          <Show when={configurationError()}>
            <div ref={element => { serviceErrorElement = element; }} class="create-error" role="alert">
              {configurationError()}
              <Show when={saveConflict() || mysqlLoading()}>
                <Button size="small" onClick={() => { closeServiceEditor(); void refreshConfiguration().catch(() => undefined); }}>重新加载</Button>
              </Show>
            </div>
          </Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">关联仓库</strong><span>可多选，仓库名称和地址统一在仓库配置中维护</span></div><span class="service-repository-count">已选 {serviceRepositories().length} 个</span></div><Show when={repositoryError()}><div class="workspace-error" role="alert">仓库加载失败：{repositoryError()}<Button size="small" onClick={loadRepositoryChoices}>重试</Button></div></Show><Select mode="multiple" aria-label="关联仓库" placeholder="选择已登记仓库（可多选）" loading={repositoryLoading()} value={serviceRepositories().map((repository) => repository.url)} options={repositoryOptions()} showSearch={{ filterOption: (query, option) => `${option.label} ${option.url}`.toLowerCase().includes(query.trim().toLowerCase()) }} optionRender={(option) => <span class="service-repository-option"><strong>{option.label}</strong><code>{option.url}</code></span>} onChange={selectRepositories} maxTagCount={4} listHeight={360} notFoundContent="暂无可选仓库，请先在仓库配置中添加" /><Show when={!repositoryLoading() && !repositoryError() && !repositoryChoices().length}><p class="service-form-empty">暂无已登记仓库，请先在“配置 → 仓库”中添加。</p></Show></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>开发基线继承正式分支；查询来源保持正式／测试</span></div></div><div class="service-deployment-editor"><Show when={!mysqlLoading()} fallback={<Skeleton active paragraph={{ rows: 3 }} />}><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow serviceKey={editingServiceKey()} index={index()} deployment={deployment} productionBranches={() => serviceDeployments.find(row => row.environmentKey === "prod")?.repositoryBranches ?? []} repositories={serviceRepositories} repositoryName={repositoryName} environmentName={configuration().environments.find((environment) => environment.key === deployment.environmentKey)?.name ?? deployment.environmentKey} onChange={(next) => setServiceDeployments((current) => { Object.assign(current[index()]!, next); })} />}</For></Show></div></div>
          <label class="service-form-field"><span>服务描述（Markdown）</span><TextArea aria-label="项目描述" placeholder="记录业务知识、排查步骤和查询范例；分支和公开能力参数会自动附加到展示及 AI 读取的描述中。" autoSize={{ minRows: 5, maxRows: 10 }} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
          <Show when={editingServiceKey()}><div class="destructive-action"><Button danger icon={<Trash2 size={14} />} onClick={() => { const target = { kind: "service" as const, key: editingServiceKey()!, name: serviceName() }; closeServiceEditor(); setDeleteTarget(target); }}>删除服务</Button></div></Show>
        </div>
      </Modal>
      <Modal open={Boolean(deleteTarget())} title="删除服务" okText="确认删除" cancelText="取消" confirmLoading={saving()} okButtonProps={{ danger: true }} onOk={() => { void confirmDelete(); }} onCancel={() => { setDeleteTarget(null); setConfigurationError(""); }}>
        <p>确定删除“{deleteTarget()?.name}”吗？已被工单使用的配置不能删除。</p>
        <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
      </Modal>
    </main>
  );
}
