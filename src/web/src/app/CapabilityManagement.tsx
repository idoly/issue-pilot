import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Modal, Skeleton, Tag, TextArea, Toggle } from "../ui";
import { CAPABILITY_KEYS, CAPABILITY_TYPES, type CapabilityName } from "../../../domain/contracts";
import { errorMessage, loadCapabilitySwitches, updateCapabilitySwitch, loadMcpServices, loadMcpServiceConfiguration, importMcpServices, updateMcpService, deleteMcpService, testMcpService, type CapabilitySwitchItem, type McpService, type McpServersInput } from "../data/client";
import { CapabilityConfigurationDialog } from "./CapabilityConfigurationDialog";
import { useApplicationResources } from "./ApplicationResources";

const labels: Record<CapabilityName, string> = { nacos: "Nacos", db: "MySQL", redis: "Redis", mq: "RabbitMQ", es: "Elasticsearch", dms: "DMS", sls: "SLS" };
const descriptions: Record<CapabilityName, string> = {
  nacos: "读取服务配置，核对环境参数与配置差异。",
  db: "执行只读 SQL，查询业务数据并导出结果。",
  redis: "查看缓存内容、键类型与过期时间。",
  mq: "查看队列状态、积压与绑定关系，不消费消息。",
  es: "检索索引数据，查看映射与统计结果。",
  dms: "通过 DMS 查询数据库，由服务端处理认证。",
  sls: "检索应用日志，按时间、条件或 Trace ID 排查问题。",
};
const typeNames = { http: "HTTP", mcp: "MCP", database: "数据库", redis: "Redis" };
const mcpTransports = { streamable_http: "Streamable HTTP", sse: "SSE", stdio: "stdio（本地进程）" };
const parseJson = (value: string): McpServersInput => {
  let input: unknown;
  try { input = JSON.parse(value); } catch { throw new Error("invalid_mcp_json"); }
  if (!input || typeof input !== "object" || !("mcpServers" in input) || !input.mcpServers || typeof input.mcpServers !== "object" || Array.isArray(input.mcpServers)) throw new Error("invalid_mcp_servers");
  return { mcpServers: input.mcpServers as Record<string, unknown> };
};
const displayError = (cause: unknown) => ({ mcp_headers_not_supported: "HTTP 导入仅支持 Authorization 请求头", invalid_mcp_json: "请输入有效的 JSON", invalid_mcp_servers: "请输入 mcpServers 对象；编辑时只能包含一个服务", invalid_mcp_stdio: "替换进程配置时请填写完整 command、args、env 和 cwd", mcp_stdio_configuration_required: "启用 stdio 前需要填写进程配置", mcp_name_conflict: "MCP 名称重复，未保存", capability_has_running_issues: "有相关工单正在执行，请稍后修改", mcp_has_running_issues: "有工单正在执行，请稍后修改", mcp_credentials_target_changed: "地址或协议已变化，请填写新认证或清除认证", developer_role_required: "只有开发角色可以修改配置", admin_role_required: "只有管理角色可以添加外部能力" } as Record<string, string>)[errorMessage(cause)] ?? errorMessage(cause);

export function CapabilityManagement() {
  const { currentUser, configuration, refreshConfiguration } = useApplicationResources();
  const canConfigure = () => currentUser()?.role === "developer";
  const [configuring, setConfiguring] = createSignal<CapabilityName | null>(null, { ownedWrite: true });
  const [switches, setSwitches] = createSignal<CapabilitySwitchItem[]>([], { ownedWrite: true });
  const [mcp, setMcp] = createSignal<McpService[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [editing, setEditing] = createSignal<McpService | null>(null, { ownedWrite: true });
  const [jsonText, setJsonText] = createSignal("", { ownedWrite: true });
  const [loadingEditor, setLoadingEditor] = createSignal(false, { ownedWrite: true });
  const [deleting, setDeleting] = createSignal(false, { ownedWrite: true });
  const [tested, setTested] = createSignal<Array<{ name: string; readOnly: boolean }> | null>(null, { ownedWrite: true });
  let generation = 0, request = 0;
  let editorController: AbortController | undefined;
  const load = async () => {
    const owner = generation, id = ++request; setLoading(untrack(switches).length === 0);
    try { const [s, m] = await Promise.all([loadCapabilitySwitches(), loadMcpServices()]); if (owner === generation && id === request) { setSwitches(s); setMcp(m); } }
    catch (cause) { if (owner === generation && id === request) setError(displayError(cause)); }
    finally { if (owner === generation && id === request) setLoading(false); }
  };
  createEffect(() => currentUser()?.subject, () => { generation++; editorController?.abort(); setLoadingEditor(false); setConfiguring(null); setSwitches([]); setMcp([]); setOpen(false); setEditing(null); setDeleting(false); setTested(null); setJsonText(""); setError(""); setBusy(false); void load(); });
  onCleanup(() => { generation++; editorController?.abort(); });
  const perform = async (action: (isCurrent: () => boolean) => Promise<unknown>) => {
    if (busy()) return; const owner = generation; setBusy(true); setError("");
    try { await action(() => owner === generation); if (owner === generation) { await load(); await refreshConfiguration(); } }
    catch (cause) { if (owner === generation) setError(displayError(cause)); }
    finally { if (owner === generation) setBusy(false); }
  };
  const closeEditor = () => { editorController?.abort(); setLoadingEditor(false); setOpen(false); setJsonText(""); };
  const edit = async (row?: McpService) => {
    editorController?.abort(); setLoadingEditor(false); setEditing(row ?? null); setJsonText("");
    setError(""); setDeleting(false); setOpen(true);
    if (!row) return;
    const owner = generation, controller = new AbortController(); editorController = controller; setLoadingEditor(true);
    try {
      const input = await loadMcpServiceConfiguration(row.id, controller.signal);
      if (owner === generation && !controller.signal.aborted) setJsonText(JSON.stringify(input, null, 2));
    } catch (cause) { if (owner === generation && !controller.signal.aborted) setError(displayError(cause)); }
    finally { if (owner === generation && editorController === controller) setLoadingEditor(false); }
  };
  const save = () => perform(async isCurrent => {
    const input = parseJson(jsonText()), row = editing();
    if (row) await updateMcpService(row.id, input); else await importMcpServices(input);
    if (isCurrent()) closeEditor();
  });
  return <main class="capability-configuration"><section class="user-management-card capability-management" aria-label="能力管理">
    <header class="user-management-header"><div><strong>内建</strong><span>按服务和环境配置地址、目标与认证；这里统一管理开关。</span></div></header>
    <Show when={error() && !open()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { setError(""); void load(); }}>重试</Button></div></Show>
    <Show when={!loading() && switches().length === CAPABILITY_KEYS.length} fallback={<Show when={loading()}><div class="user-management-loading"><Skeleton active paragraph={{ rows: 7 }} /></div></Show>}>
      <div class="capability-switch-list"><table class="capability-table" aria-label="内建能力列表"><thead><tr><th scope="col">能力</th><th scope="col">类型</th><th scope="col">用途</th><th scope="col">已配置</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody><For each={CAPABILITY_KEYS}>{key => {
        const on = () => switches().find(row => row.key === key)?.enabled ?? false;
        return <tr class="capability-switch-row"><th scope="row">{labels[key]}</th><td><Tag>{typeNames[CAPABILITY_TYPES[key]]}</Tag></td><td class="capability-description">{descriptions[key]}</td><td>{configuration().services.flatMap(service => service.deployments).filter(deployment => deployment.capabilities.includes(key)).length} 个服务环境</td><td><div class="capability-status"><Tag color={on() ? "green" : "default"}>{on() ? "开启" : "关闭"}</Tag><Show when={canConfigure()}><Toggle aria-label={`${labels[key]} 全局开关`} checked={on()} disabled={busy()} onChange={value => { void perform(() => updateCapabilitySwitch(key, value)); }} /></Show></div></td><td><Show when={canConfigure()}><Button size="small" onClick={() => setConfiguring(key)}>配置</Button></Show></td></tr>;
      }}</For></tbody></table></div>
    </Show>
  </section>
  <section class="user-management-card capability-management" aria-label="外部能力管理">
    <header class="user-management-header"><div><strong>外部</strong><span>通过 MCP 接入工具，启用后向所有工单提供全部工具，无需在服务或环境中选择。</span></div><Show when={currentUser()?.isAdmin}><Button type="primary" onClick={() => edit()}>添加</Button></Show></header>
    <Show when={!loading()} fallback={<Skeleton active paragraph={{ rows: 2 }} />}>
      <Show when={mcp().length} fallback={<p class="form-note">尚未添加外部能力，由管理角色通过 mcpServers JSON 添加。</p>}>
        <div class="capability-switch-list"><table class="capability-table" aria-label="MCP 工具列表"><thead><tr><th scope="col">名称</th><th scope="col">协议</th><th scope="col">适用范围</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody><For each={mcp()}>{row => <tr class="capability-switch-row"><th scope="row">{row.name}</th><td><Tag>{mcpTransports[row.transport]}</Tag></td><td>所有工单</td><td><div class="capability-status"><Tag color={row.enabled ? "green" : "default"}>{row.enabled ? "开启" : "关闭"}</Tag><Show when={canConfigure()}><Toggle aria-label={`${row.name} MCP 开关`} checked={row.enabled} disabled={busy()} onChange={value => { void perform(() => updateMcpService(row.id, { name: row.name, url: row.url, transport: row.transport, enabled: value, credentialUpdate: { mode: "preserve" } })); }} /></Show></div></td><td><Show when={canConfigure()}><div class="capability-actions"><Button size="small" disabled={busy()} onClick={() => { void perform(async isCurrent => { const result = await testMcpService(row.id); if (isCurrent()) setTested(result.tools); }); }}>测试连接</Button><Button size="small" disabled={busy()} onClick={() => edit(row)}>配置</Button></div></Show></td></tr>}</For></tbody></table></div>
      </Show>
    </Show>
  </section>
  <Modal open={open()} title={editing() ? "编辑 MCP" : "添加"} okText={editing() ? "保存" : "添加"} confirmLoading={busy()} okButtonProps={{ disabled: loadingEditor() || !jsonText().trim() }} footerExtra={<Show when={editing()}><Button danger disabled={busy() || loadingEditor()} onClick={() => setDeleting(true)}>删除</Button></Show>} onCancel={closeEditor} onOk={() => { void save(); }}><Show when={!loadingEditor()} fallback={<Skeleton active paragraph={{ rows: 6 }} />}><TextArea aria-label="mcpServers JSON" rows={12} autocomplete="off" spellcheck={false} value={jsonText()} placeholder={'{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@0.0.83","--headless","--isolated"]}}}'} onInput={event => setJsonText(event.currentTarget.value)} /></Show><Show when={error()}><div role="alert" class="form-error">{error()}</div></Show></Modal>
  <Modal open={deleting()} title="删除" okText="删除" confirmLoading={busy()} okButtonProps={{ danger: true }} onCancel={() => setDeleting(false)} onOk={() => { const row = editing(); if (row) void perform(async isCurrent => { await deleteMcpService(row.id); if (isCurrent()) { setDeleting(false); closeEditor(); } }); }}><p>删除 {editing()?.name}？</p><Show when={error()}><div role="alert">{error()}</div></Show></Modal>
  <Modal open={tested() !== null} title="连接测试" okText="关闭" onOk={() => setTested(null)} onCancel={() => setTested(null)}><For each={tested() ?? []} fallback={<p>未提供工具</p>}>{tool => <p><code>{tool.name}</code> · {tool.readOnly ? "只读" : "非只读"}</p>}</For></Modal>
  <Show when={configuring()}>{key => <CapabilityConfigurationDialog capability={key()} onClose={() => setConfiguring(null)} />}</Show>
  </main>;
}
