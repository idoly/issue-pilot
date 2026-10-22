import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Input, Modal, Select } from "../ui";
import { canUseIssueWorkMode, DINGTALK_COLUMNS, importDingtalkRecords, issueScopeForWorkMode, loadDingtalkSource, previewDingtalkRecords, type DingtalkColumns, type DingtalkField, type DingtalkImportResponse, type DingtalkPreviewRecord, type DingtalkSourceResponse, type IssuePriority, type IssueWorkMode, type Person } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { priorityOptions, workModeOptions } from "./model";

const labels: Record<keyof DingtalkColumns, string> = { title: "标题字段", description: "描述字段", assignee: "人员字段", status: "状态字段", module: "模块字段", number: "编号字段", attachments: "附件字段" };
const errors: Record<string, string> = {
  invalid_dingtalk_table_url: "请输入包含 sheetId 的钉钉数据表链接。", dingtalk_mcp_not_configured: "尚未启用当前用户的钉钉 MCP 连接，请检查配置文件。",
  dingtalk_person_ambiguous: "钉钉存在同名人员，无法确定当前用户，请检查人员配置。",
  dingtalk_attachment_host_not_allowed: "附件下载地址尚未受信任，请检查钉钉附件存储配置。",
  dingtalk_attachment_download_failed: "附件下载失败，该条工单未创建，可重试。",
  dingtalk_attachment_size_changed: "附件大小已变化，请重新读取表格。",
  invalid_dingtalk_attachments: "钉钉附件信息无效，请检查记录附件。",
  dingtalk_configuration_invalid: "个人钉钉配置无效，请检查 user.yaml。", dingtalk_connection_failed: "钉钉连接失败，请检查当前连接和凭证。",
  dingtalk_read_failed: "钉钉读取失败，请重试或检查表格访问权限。", dingtalk_fields_changed: "表格字段已变化，请重新打开弹窗读取。",
  dingtalk_snapshot_changed: "表格数据或查询条件已变化，请重新读取。", dingtalk_result_too_large: "返回数据过大，请调整读取字段。",
  dingtalk_request_cancelled_or_timed_out: "读取已取消或超时，请重试。", invalid_current_subject: "当前用户已停用或不存在。",
  developer_role_required: "当前用户无权使用所选处理方式。", invalid_service_for_work_mode: "所选服务不支持此处理方式。",
  issue_creation_failed: "工单创建失败，可以重试。",
};
const message = (error: unknown) => error instanceof Error ? errors[error.message] ?? "操作失败，请检查配置后重试。" : "操作失败，请重试。";

export function DingtalkImportButton(props: { onCreated: () => void; onOpenIssue: (key: string) => boolean }) {
  const { currentUser } = useApplicationResources();
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  createEffect(() => currentUser()?.subject, () => { setOpen(false); });
  return <>
    <Button class="dingtalk-nav-button" disabled={!currentUser()} onClick={() => setOpen(true)}>钉钉</Button>
    <Show when={open() && currentUser()}>{user => <DingtalkImportDialog user={user()} onClose={() => setOpen(false)} onCreated={props.onCreated} onOpenIssue={props.onOpenIssue} />}</Show>
  </>;
}

export function DingtalkImportDialog(props: { user: Person; onClose: () => void; onCreated: () => void; onOpenIssue: (key: string) => boolean }) {
  const { catalog } = useApplicationResources(), subject = untrack(() => props.user.subject);
  const [source, setSource] = createSignal<DingtalkSourceResponse | null>(null, { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true }), [fields, setFields] = createSignal<DingtalkField[]>([], { ownedWrite: true });
  const [columns, setColumns] = createSignal<Partial<DingtalkColumns>>({}, { ownedWrite: true });
  const [rows, setRows] = createSignal<DingtalkPreviewRecord[]>([], { ownedWrite: true }), [selected, setSelected] = createSignal<Set<string>>(new Set(), { ownedWrite: true });
  const [cursor, setCursor] = createSignal("", { ownedWrite: true }), [scanned, setScanned] = createSignal(0, { ownedWrite: true });
  const [busy, setBusy] = createSignal<"defaults" | "read" | "create" | "">("defaults", { ownedWrite: true }), [error, setError] = createSignal("", { ownedWrite: true });
  const [skippedImported, setSkippedImported] = createSignal(0, { ownedWrite: true });
  const [needsMapping, setNeedsMapping] = createSignal(false, { ownedWrite: true });
  const [results, setResults] = createSignal<DingtalkImportResponse["results"]>([], { ownedWrite: true });
  const [workMode, setWorkMode] = createSignal<IssueWorkMode>("production_analysis", { ownedWrite: true }), [service, setService] = createSignal("", { ownedWrite: true });
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true }), [startAgent, setStartAgent] = createSignal(false, { ownedWrite: true });
  let generation = 0, disposed = false, controller: AbortController | undefined;
  const cursors = new Set<string>();
  const begin = () => { controller?.abort(); controller = new AbortController(); return { owner: ++generation, signal: controller.signal }; };
  const current = (owner: number) => !disposed && owner === generation;
  onCleanup(() => { disposed = true; generation++; controller?.abort(); });
  const modes = createMemo(() => workModeOptions.filter(option => canUseIssueWorkMode(props.user.role, option.value) && catalog().services.some(service => service.deployments.some(deployment => deployment.environmentKey === issueScopeForWorkMode(option.value).environmentKind))));
  const services = createMemo(() => catalog().services.filter(service => service.deployments.some(deployment => deployment.environmentKey === issueScopeForWorkMode(workMode()).environmentKind)));
  createEffect(() => ({ modes: modes(), mode: workMode(), services: services(), selected: service() }), value => {
    if (!value.modes.some(mode => mode.value === value.mode)) setWorkMode(value.modes[0]?.value ?? "production_analysis");
    if (!value.services.some(service => service.key === value.selected)) setService(value.services[0]?.key ?? "");
  });
  const eligible = () => rows().filter(row => row.creatable && !row.issueKey);
  const resetPreview = () => { generation++; controller?.abort(); setBusy(""); setRows([]); setSelected(new Set<string>()); setCursor(""); setScanned(0); setSkippedImported(0); setResults([]); setNeedsMapping(false); setError(""); cursors.clear(); };
  const defaults = async () => {
    const task = begin();
    try {
      const response = await loadDingtalkSource(task.signal);
      if (!current(task.owner)) return;
      if (response.user.subject !== subject) throw new Error("invalid_current_subject");
      setSource(response); setUrl(response.url);
      if (response.environment) setWorkMode(modes().find(mode => issueScopeForWorkMode(mode.value).environmentKind === response.environment)?.value ?? workMode());
    } catch (error) { if (current(task.owner)) setError(message(error)); }
    finally { if (current(task.owner)) setBusy(""); }
  };
  void defaults();
  const read = async (more = false) => {
    if (busy() || !url().trim()) return;
    const previous = more ? rows() : [], previousScanned = more ? scanned() : 0, previousCursor = more ? cursor() : "";
    if (!more) resetPreview();
    const task = begin(); setBusy("read"); setError("");
    try {
      const response = await previewDingtalkRecords({ url: url(), columns: columns(), ...(previousCursor ? { cursor: previousCursor } : {}) }, task.signal);
      if (!current(task.owner)) return;
      if (response.user.subject !== subject) throw new Error("invalid_current_subject");
      if (response.cursor && cursors.has(response.cursor) || response.records.some(row => previous.some(old => old.recordId === row.recordId))) throw new Error("dingtalk_snapshot_changed");
      if (response.cursor) cursors.add(response.cursor);
      setFields(response.fields); setColumns(response.columns); setNeedsMapping(response.needsMapping);
      setRows([...previous, ...response.records.filter(row => !row.issueKey)]); setCursor(response.cursor); setScanned(previousScanned + response.scanned); setSkippedImported(value => (more ? value : 0) + (response.skippedImported ?? 0));
    } catch (error) { if (current(task.owner)) { setRows([]); setSelected(new Set<string>()); setCursor(""); setScanned(0); cursors.clear(); setError(message(error)); } }
    finally { if (current(task.owner)) setBusy(""); }
  };
  const create = async () => {
    if (busy() || !selected().size || !service()) return;
    const records = eligible().filter(row => selected().has(row.recordId)).map(row => ({ recordId: row.recordId, token: row.token }));
    if (!records.length) return;
    const task = begin(); setBusy("create"); setError("");
    try {
      const response = await importDingtalkRecords({ url: url(), columns: columns(), records, serviceKey: service(), workMode: workMode(), priority: priority(), startAgent: startAgent() }, task.signal);
      if (!current(task.owner)) return;
      if (response.user.subject !== subject) throw new Error("invalid_current_subject");
      setResults(values => [...values.filter(old => !response.results.some(row => row.recordId === old.recordId)), ...response.results]);
      const byId = new Map(response.results.map(row => [row.recordId, row]));
      setRows(values => values.filter(row => !byId.get(row.recordId)?.issueKey).map(row => { const result = byId.get(row.recordId); return result?.status === "stale" ? { ...row, creatable: false, reason: result.error ?? "记录已变化，请重新读取" } : row; }));
      setSkippedImported(value => value + response.results.filter(row => row.issueKey).length);
      setSelected(new Set(response.results.filter(row => row.status === "failed").map(row => row.recordId)));
      if (response.results.some(row => row.issueKey)) props.onCreated();
    } catch (error) { if (current(task.owner)) setError(message(error)); }
    finally { if (current(task.owner)) setBusy(""); }
  };
  return <Modal open title="导入" width={1100} onOk={() => { void create(); }} onCancel={props.onClose} footer={<div class="dingtalk-footer"><span>已选择 {selected().size} 条</span><Button onClick={props.onClose}>关闭</Button><Button type="primary" loading={busy() === "create"} disabled={Boolean(busy()) || !selected().size || selected().size > 100 || !service()} onClick={() => { void create(); }}>创建选中工单</Button></div>}>
    <div class="dingtalk-import user-form">
      <p class="dingtalk-identity">当前用户：{props.user.name} · {props.user.email}<Show when={source()}>　筛选人员：{source()!.assignee}　·　{source()!.connection.kind === "personal" ? "账号配置" : "共享连接"}</Show></p>
      <label><span>数据表链接</span><Input aria-label="钉钉数据表链接" value={url()} disabled={Boolean(busy())} placeholder="https://alidocs.dingtalk.com/i/nodes/…?sheetId=…" onInput={event => { resetPreview(); setUrl(event.currentTarget.value); setFields([]); setColumns({}); }} /></label>
      <Show when={fields().length}><div class="dingtalk-fields dingtalk-field-mapping"><For each={DINGTALK_COLUMNS}>{key => <label><span>{labels[key]}{["title", "assignee", "status"].includes(key) ? " *" : ""}</span><Select aria-label={`钉钉${labels[key]}`} value={columns()[key] ?? ""} disabled={Boolean(busy())} options={[{ value: "", label: "请选择" }, ...fields().map(field => ({ value: field.id, label: field.name }))]} onChange={value => { resetPreview(); setColumns(columns => ({ ...columns, [key]: value })); }} /></label>}</For></div></Show>
      <div class="dingtalk-read-actions"><Button loading={busy() === "read"} disabled={Boolean(busy()) || !url().trim() || !source()?.connection.available} onClick={() => { void read(); }}>读取表格</Button></div>
      <p class="dingtalk-note">分页读取整张数据表，只显示当前用户的待处理记录：研发任务状态为“A待安排”，归档状态为“待处理”，忽略链接中的视图筛选。读取仅用于预览，勾选并创建后才会生成工单。</p>
      <Show when={needsMapping()}><p role="status">请选择标题、人员和状态字段，然后重新读取。</p></Show>
      <Show when={source() && !source()!.connection.available}><p role="alert" class="form-error">尚未启用钉钉 MCP 连接，请检查配置文件。</p></Show>
      <Show when={fields().length && !needsMapping() && busy() !== "read" && !error()}><p role="status">已检查 {scanned()} 行，匹配 {rows().length} 条，已过滤 {skippedImported()} 条已有工单{cursor() ? "，还有后续记录" : ""}。</p></Show>
      <Show when={rows().length}><div class="dingtalk-table-scroll"><table class="dingtalk-preview"><thead><tr><th><input type="checkbox" aria-label="选择全部可导入记录" disabled={Boolean(busy()) || !eligible().length} checked={eligible().length > 0 && eligible().every(row => selected().has(row.recordId))} onChange={event => setSelected(event.currentTarget.checked ? new Set(eligible().slice(0, 100).map(row => row.recordId)) : new Set())} /></th><th>标题与描述</th><th>模块</th><th>人员</th><th>状态</th><th>附件</th><th>导入结果</th></tr></thead><tbody><For each={rows()}>{row => <tr><td><input type="checkbox" aria-label={`选择 ${row.title}`} checked={selected().has(row.recordId)} disabled={Boolean(busy()) || !row.creatable || Boolean(row.issueKey) || selected().size >= 100 && !selected().has(row.recordId)} onChange={event => setSelected(values => { const next = new Set(values); if (event.currentTarget.checked) next.add(row.recordId); else next.delete(row.recordId); return next; })} /></td><td><strong>{row.title || "无标题"}</strong><Show when={row.description}><details><summary>查看描述</summary><pre>{row.description}</pre></details></Show><Show when={row.reason}><small>{row.reason}</small></Show></td><td>{row.module || "—"}</td><td>{row.assignee || "—"}</td><td>{row.status || "—"}</td><td><For each={row.attachments ?? []} fallback="—">{file => <div title={file.fileName}>{file.fileName}</div>}</For></td><td><Show when={row.issueKey} fallback={results().find(result => result.recordId === row.recordId)?.status === "failed" ? message(new Error(results().find(result => result.recordId === row.recordId)?.error)) : "未导入"}><Button type="text" onClick={() => { if (props.onOpenIssue(row.issueKey!)) props.onClose(); }}>{row.issueKey}</Button></Show></td></tr>}</For></tbody></table></div></Show>
      <Show when={cursor()}><Button disabled={Boolean(busy()) || rows().length >= 1000} onClick={() => { void read(true); }}>继续读取</Button></Show>
      <div class="dingtalk-fields"><label><span>入口服务</span><Select aria-label="导入工单服务" value={service()} disabled={Boolean(busy())} options={services().map(service => ({ value: service.key, label: service.name }))} onChange={setService} /></label><label><span>处理方式</span><Select aria-label="导入工单处理方式" value={workMode()} disabled={Boolean(busy())} options={modes()} onChange={setWorkMode} /></label><label><span>优先级</span><Select aria-label="导入工单优先级" value={priority()} disabled={Boolean(busy())} options={priorityOptions} onChange={setPriority} /></label></div>
      <label class="dingtalk-start-agent"><input type="checkbox" checked={startAgent()} disabled={Boolean(busy())} onChange={event => setStartAgent(event.currentTarget.checked)} />创建后立即启动 Agent</label>
      <Show when={results().length}><p role="status">创建 {results().filter(row => row.status === "created").length} 条，已存在 {results().filter(row => row.status === "existing").length} 条，需重新读取 {results().filter(row => row.status === "stale").length} 条，失败 {results().filter(row => row.status === "failed").length} 条。</p></Show>
      <Show when={results().some(row => row.issueKey)}><div class="dingtalk-results"><span>已创建或已存在：</span><For each={results().filter(row => row.issueKey)}>{row => <Button type="text" onClick={() => { if (props.onOpenIssue(row.issueKey!)) props.onClose(); }}>{row.issueKey}</Button>}</For></div></Show>
      <Show when={error()}><p role="alert" class="form-error">{error()}</p></Show>
    </div>
  </Modal>;
}
