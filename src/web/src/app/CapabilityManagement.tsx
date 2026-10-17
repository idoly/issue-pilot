import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Input, Modal, PasswordInput, Select, Skeleton, Tag, TextArea, Toggle } from "../ui";
import { CAPABILITY_KEYS, CAPABILITY_TYPES, type CapabilityName, type McpStdioConfiguration } from "../../../domain/contracts";
import { errorMessage, loadCapabilitySwitches, updateCapabilitySwitch, loadMcpServices, importMcpServices, createMcpService, updateMcpService, deleteMcpService, testMcpService, type CapabilitySwitchItem, type McpService, type McpServiceInput } from "../data/client";
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
const mcpTransports = [{ value: "streamable_http" as const, label: "Streamable HTTP" }, { value: "sse" as const, label: "SSE" }, { value: "stdio" as const, label: "stdio（本地进程）" }];
const parseJson = (value: string): unknown => { try { return JSON.parse(value); } catch { throw new Error("invalid_mcp_json"); } };
const displayError = (cause: unknown) => ({ mcp_headers_not_supported: "HTTP 导入仅支持 Authorization 请求头", invalid_mcp_json: "请输入有效的 JSON", invalid_mcp_stdio: "请检查 command、args、env 和 cwd", mcp_stdio_configuration_required: "启用 stdio 前需要填写进程配置", mcp_name_conflict: "MCP 名称重复，未保存", capability_has_running_issues: "有相关工单正在执行，请稍后修改", mcp_has_running_issues: "有工单正在执行，请稍后修改", mcp_service_in_use: "该能力正在被服务配置使用", mcp_credentials_target_changed: "地址或协议已变化，请填写新认证或清除认证", developer_role_required: "只有开发角色可以修改配置" } as Record<string, string>)[errorMessage(cause)] ?? errorMessage(cause);

export function CapabilityManagement() {
  const { currentUser, configuration, refreshConfiguration } = useApplicationResources();
  const [configuring, setConfiguring] = createSignal<CapabilityName | null>(null, { ownedWrite: true });
  const [switches, setSwitches] = createSignal<CapabilitySwitchItem[]>([], { ownedWrite: true });
  const [mcp, setMcp] = createSignal<McpService[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [editing, setEditing] = createSignal<McpService | null>(null, { ownedWrite: true });
  const [name, setName] = createSignal("", { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [transport, setTransport] = createSignal<McpService["transport"]>("streamable_http", { ownedWrite: true });
  const [stdio, setStdio] = createSignal("", { ownedWrite: true });
  const [importing, setImporting] = createSignal(false, { ownedWrite: true });
  const [importText, setImportText] = createSignal("", { ownedWrite: true });
  const [authorization, setAuthorization] = createSignal("", { ownedWrite: true });
  const [clearAuthorization, setClearAuthorization] = createSignal(false, { ownedWrite: true });
  const [enabled, setEnabled] = createSignal(false, { ownedWrite: true });
  const [deleting, setDeleting] = createSignal(false, { ownedWrite: true });
  const [tested, setTested] = createSignal<Array<{ name: string; readOnly: boolean }> | null>(null, { ownedWrite: true });
  let generation = 0, request = 0;
  const load = async () => {
    const owner = generation, id = ++request; setLoading(untrack(switches).length === 0);
    try { const [s, m] = await Promise.all([loadCapabilitySwitches(), loadMcpServices()]); if (owner === generation && id === request) { setSwitches(s); setMcp(m); } }
    catch (cause) { if (owner === generation && id === request) setError(displayError(cause)); }
    finally { if (owner === generation && id === request) setLoading(false); }
  };
  createEffect(() => currentUser()?.subject, () => { generation++; setConfiguring(null); setSwitches([]); setMcp([]); setOpen(false); setEditing(null); setDeleting(false); setTested(null); setAuthorization(""); setStdio(""); setImporting(false); setImportText(""); setError(""); setBusy(false); void load(); });
  onCleanup(() => { generation++; });
  const perform = async (action: (isCurrent: () => boolean) => Promise<unknown>) => {
    if (busy()) return; const owner = generation; setBusy(true); setError("");
    try { await action(() => owner === generation); if (owner === generation) { await load(); await refreshConfiguration(); } }
    catch (cause) { if (owner === generation) setError(displayError(cause)); }
    finally { if (owner === generation) setBusy(false); }
  };
  const edit = (row?: McpService) => {
    setEditing(row ?? null); setName(row?.name ?? ""); setUrl(row?.url ?? ""); setTransport(row?.transport ?? "streamable_http"); setEnabled(row?.enabled ?? false); setAuthorization(""); setStdio(""); setClearAuthorization(false); setError(""); setDeleting(false); setOpen(true);
  };
  const useCount = (id: string) => configuration().services.flatMap(service => service.deployments).filter(deployment => deployment.mcpServices?.includes(id)).length;
  const save = () => perform(async isCurrent => {
    const row = editing();
    const input: McpServiceInput = { name: name().trim(), url: transport() === "stdio" ? "" : url().trim(), transport: transport(), enabled: enabled(), credentialUpdate: transport() === "stdio" && stdio().trim() ? { mode: "replace", values: { stdio: parseJson(stdio()) as McpStdioConfiguration } } : transport() !== "stdio" && authorization().trim() ? { mode: "replace", values: { authorization: authorization().trim() } } : { mode: row?.credentialConfigured && !clearAuthorization() ? "preserve" : "clear" } };
    if (row) await updateMcpService(row.id, input); else await createMcpService(input);
    if (isCurrent()) { setOpen(false); setAuthorization(""); setStdio(""); }
  });
  return <main class="capability-configuration"><section class="user-management-card capability-management" aria-label="能力管理">
    <header class="user-management-header"><div><strong>能力</strong><span>统一维护类型与开关；地址、目标和认证直接在服务中配置。</span></div><div class="user-row-actions"><Show when={currentUser()?.role === "developer"}><Button onClick={() => { setImportText(""); setError(""); setImporting(true); }}>导入 mcpServers</Button><Button type="primary" onClick={() => edit()}>添加能力</Button></Show></div></header>
    <Show when={error() && !open() && !importing()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { setError(""); void load(); }}>重试</Button></div></Show>
    <Show when={!loading() && switches().length === CAPABILITY_KEYS.length} fallback={<Show when={loading()}><div class="user-management-loading"><Skeleton active paragraph={{ rows: 7 }} /></div></Show>}>
      <div class="capability-switch-list"><table class="capability-table" aria-label="能力列表"><thead><tr><th scope="col">能力</th><th scope="col">类型</th><th scope="col">用途</th><th scope="col">已配置</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody><For each={CAPABILITY_KEYS}>{key => {
        const on = () => switches().find(row => row.key === key)?.enabled ?? false;
        return <tr class="capability-switch-row"><th scope="row">{labels[key]}</th><td><Tag>{typeNames[CAPABILITY_TYPES[key]]}</Tag></td><td class="capability-description">{descriptions[key]}</td><td>{configuration().services.flatMap(service => service.deployments).filter(deployment => deployment.capabilities.includes(key)).length} 个服务环境</td><td><div class="capability-status"><Tag color={on() ? "green" : "default"}>{on() ? "开启" : "关闭"}</Tag><Show when={currentUser()?.role === "developer"}><Toggle aria-label={`${labels[key]} 全局开关`} checked={on()} disabled={busy()} onChange={value => { void perform(() => updateCapabilitySwitch(key, value)); }} /></Show></div></td><td><Show when={currentUser()?.role === "developer"}><Button size="small" onClick={() => setConfiguring(key)}>配置</Button></Show></td></tr>;
      }}</For><For each={mcp()}>{row => <tr class="capability-switch-row"><th scope="row">{row.name}</th><td><Tag>MCP</Tag></td><td class="capability-description">连接外部 MCP 服务，发现并调用其工具。<small>{mcpTransports.find(item => item.value === row.transport)?.label}</small></td><td>{useCount(row.id)} 个服务环境</td><td><Tag color={row.enabled ? "green" : "default"}>{row.enabled ? "开启" : "关闭"}</Tag></td><td><Show when={currentUser()?.role === "developer"}><div class="capability-actions"><Button size="small" disabled={busy()} onClick={() => { void perform(async isCurrent => { const result = await testMcpService(row.id); if (isCurrent()) setTested(result.tools); }); }}>测试连接</Button><Button size="small" disabled={busy()} onClick={() => edit(row)}>配置</Button></div></Show></td></tr>}</For></tbody></table></div>
    </Show>
  </section>
  <Modal open={open()} title={editing() ? "编辑能力" : "添加能力"} okText="保存" confirmLoading={busy()} okButtonProps={{ disabled: !name().trim() || transport() !== "stdio" && !url().trim() || transport() === "stdio" && !(editing()?.transport === "stdio" && editing()?.credentialConfigured) && !stdio().trim() }} onOk={() => { void save(); }} onCancel={() => { setOpen(false); setAuthorization(""); setStdio(""); }}><div class="user-form">
    <label><span>类型</span><Select aria-label="能力类型" value="mcp" options={[{ value: "mcp", label: "MCP" }]} onChange={() => {}} disabled /></label>
    <label><span>名称</span><Input aria-label="能力名称" value={name()} onInput={event => setName(event.currentTarget.value)} /></label>
    <label><span>协议</span><Select aria-label="MCP 协议" value={transport()} options={mcpTransports} onChange={setTransport} /></label>
    <Show when={transport() === "stdio"} fallback={<><label><span>地址</span><Input aria-label="能力地址" value={url()} placeholder="https://example.com/mcp" onInput={event => setUrl(event.currentTarget.value)} /></label><label><span>Authorization（可选）</span><PasswordInput aria-label="能力 Authorization" autocomplete="off" placeholder={editing()?.credentialConfigured ? "已配置，留空保留" : "Bearer token"} value={authorization()} onInput={event => setAuthorization(event.currentTarget.value)} /></label></>}><label><span>进程配置 JSON</span><TextArea aria-label="MCP 进程配置" rows={8} autocomplete="off" spellcheck={false} placeholder={editing()?.credentialConfigured ? "已配置，留空保留；替换时填写完整 command、args、env、cwd" : '{"command":"npx","args":["@playwright/mcp@latest"],"env":{}}'} value={stdio()} onInput={event => setStdio(event.currentTarget.value)} /></label><p class="form-note">进程以应用用户运行。凭证放在 env；配置保存后不回显。相对 cwd 基于工单工作目录。</p></Show>
    <Show when={editing()?.credentialConfigured}><label>{transport() === "stdio" ? "清除进程配置" : "清除已存认证"}<Toggle aria-label="清除能力认证" checked={clearAuthorization()} onChange={setClearAuthorization} /></label></Show>
    <label>启用<Toggle aria-label="能力启用" checked={enabled()} onChange={setEnabled} /></label>
    <Show when={editing()}><Button danger disabled={Boolean(useCount(editing()!.id)) || busy()} onClick={() => setDeleting(true)}>删除能力</Button></Show>
    <Show when={error()}><div role="alert" class="form-error">{error()}</div></Show>
  </div></Modal>
  <Modal open={importing()} title="导入 mcpServers" okText="导入" confirmLoading={busy()} okButtonProps={{ disabled: !importText().trim() }} onCancel={() => { setImporting(false); setImportText(""); }} onOk={() => { void perform(async isCurrent => { await importMcpServices(parseJson(importText())); if (isCurrent()) { setImporting(false); setImportText(""); } }); }}><TextArea aria-label="mcpServers JSON" rows={12} autocomplete="off" spellcheck={false} value={importText()} placeholder={'{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}'} onInput={event => setImportText(event.currentTarget.value)} /><p class="form-note">整体校验并保存；名称冲突时不导入任何项。导入后在服务环境中选择，测试连接或 Agent 使用时启动进程。</p><Show when={error()}><div role="alert" class="form-error">{error()}</div></Show></Modal>
  <Modal open={deleting()} title="删除能力" okText="确认删除" confirmLoading={busy()} okButtonProps={{ danger: true }} onCancel={() => setDeleting(false)} onOk={() => { const row = editing(); if (row) void perform(async isCurrent => { await deleteMcpService(row.id); if (isCurrent()) { setDeleting(false); setOpen(false); setAuthorization(""); setStdio(""); } }); }}><p>删除 {editing()?.name}？</p><Show when={error()}><div role="alert">{error()}</div></Show></Modal>
  <Modal open={tested() !== null} title="连接测试" okText="关闭" onOk={() => setTested(null)} onCancel={() => setTested(null)}><For each={tested() ?? []} fallback={<p>未提供工具</p>}>{tool => <p><code>{tool.name}</code> · {tool.readOnly ? "只读" : "非只读"}</p>}</For></Modal>
  <Show when={configuring()}>{key => <CapabilityConfigurationDialog capability={key()} onClose={() => setConfiguring(null)} />}</Show>
  </main>;
}
