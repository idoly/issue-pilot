import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Input, Modal, Select } from "../ui";
import { canUseIssueWorkMode, importDingtalkRecords, issueScopeForWorkMode, loadDingtalkSource, type DingtalkImportResponse, type DingtalkSourceResponse, type IssuePriority, type IssueWorkMode, type Person } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { priorityOptions, workModeOptions } from "./model";

const errors: Record<string, string> = {
  invalid_dingtalk_record_url: "请输入包含 dentryUuid、sheetId 和 rowId 的钉钉单条记录链接。",
  dingtalk_mcp_not_configured: "尚未启用钉钉 MCP 连接，请检查配置文件。",
  dingtalk_configuration_invalid: "钉钉配置无效，请检查钉钉偏好配置。",
  dingtalk_connection_failed: "钉钉连接失败，请检查连接和凭证。",
  dingtalk_read_failed: "钉钉读取失败，请重试或检查记录访问权限。",
  dingtalk_fields_changed: "字段映射不存在或有重名，请检查个人或共享字段映射。",
  dingtalk_columns_required: "请配置钉钉标题字段映射。",
  dingtalk_record_not_found: "记录不存在或无权访问。",
  dingtalk_record_invalid: "记录标题为空或内容超出工单长度，请检查记录。",
  dingtalk_attachment_host_not_allowed: "附件下载地址尚未受信任，请检查附件存储配置。",
  dingtalk_attachment_download_failed: "附件下载失败，工单未创建，可重试。",
  dingtalk_attachment_size_changed: "附件大小已变化，请重试。",
  invalid_dingtalk_attachments: "附件信息无效，请检查记录。",
  dingtalk_request_cancelled_or_timed_out: "导入已取消或超时；请先核对是否已有工单，再重试。",
  invalid_current_subject: "当前用户已停用或不存在。",
  developer_role_required: "当前用户无权使用所选处理方式。",
  invalid_service_for_work_mode: "所选服务不支持此处理方式。",
};
const message = (error: unknown) => error instanceof Error ? errors[error.message] ?? "导入失败，请检查配置后重试。" : "导入失败，请重试。";

export function DingtalkImportButton(props: { onCreated: () => void; onOpenIssue: (key: string) => boolean }) {
  const { currentUser } = useApplicationResources();
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  createEffect(() => currentUser()?.subject, (subject, previous) => { if (previous !== undefined && subject !== previous) setOpen(false); });
  return <><Button class="dingtalk-nav-button" disabled={!currentUser()} onClick={() => setOpen(true)}>钉钉</Button><Show when={open() && currentUser()}>{user => <DingtalkImportDialog user={user()} onClose={() => setOpen(false)} onCreated={props.onCreated} onOpenIssue={props.onOpenIssue} />}</Show></>;
}

export function DingtalkImportDialog(props: { user: Person; onClose: () => void; onCreated: () => void; onOpenIssue: (key: string) => boolean }) {
  const { catalog } = useApplicationResources(), subject = untrack(() => props.user.subject);
  const [source, setSource] = createSignal<DingtalkSourceResponse | null>(null, { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [busy, setBusy] = createSignal<"defaults" | "import" | "">("defaults", { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [results, setResults] = createSignal<DingtalkImportResponse[]>([], { ownedWrite: true });
  const [workMode, setWorkMode] = createSignal<IssueWorkMode>("production_analysis", { ownedWrite: true });
  const [service, setService] = createSignal("", { ownedWrite: true });
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  let generation = 0, disposed = false, controller: AbortController | undefined;
  const begin = () => { controller?.abort(); controller = new AbortController(); return { owner: ++generation, signal: controller.signal }; };
  const current = (owner: number) => !disposed && owner === generation;
  onCleanup(() => { disposed = true; generation++; controller?.abort(); });
  const modes = createMemo(() => workModeOptions.filter(option => canUseIssueWorkMode(props.user.role, option.value) && catalog().services.some(service => service.deployments.some(deployment => deployment.environmentKey === issueScopeForWorkMode(option.value).environmentKind))));
  const services = createMemo(() => catalog().services.filter(service => service.deployments.some(deployment => deployment.environmentKey === issueScopeForWorkMode(workMode()).environmentKind)));
  createEffect(() => ({ modes: modes(), mode: workMode(), services: services(), selected: service() }), value => {
    if (!value.modes.some(mode => mode.value === value.mode)) setWorkMode(value.modes[0]?.value ?? "production_analysis");
    if (!value.services.some(service => service.key === value.selected)) setService(value.services[0]?.key ?? "");
  });
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
  const submit = async () => {
    if (busy() || !url().trim() || !service() || !source()?.connection.available) return;
    const task = begin(); setBusy("import"); setError("");
    try {
      const response = await importDingtalkRecords({ url: url().trim(), serviceKey: service(), workMode: workMode(), priority: priority(), startAgent: true }, task.signal);
      if (!current(task.owner)) return;
      if (response.user.subject !== subject) throw new Error("invalid_current_subject");
      setResults(values => [...values.filter(row => row.issueKey !== response.issueKey), response]);
      setUrl("");
      if (response.status === "created") {
        props.onCreated();
        if (props.onOpenIssue(response.issueKey)) props.onClose();
      }
    } catch (error) { if (current(task.owner)) setError(message(error)); }
    finally { if (current(task.owner)) setBusy(""); }
  };
  return <Modal open title="导入" width={800} onOk={() => { void submit(); }} onCancel={props.onClose} footer={<div class="dingtalk-footer"><Button onClick={props.onClose}>关闭</Button><Button type="primary" loading={busy() === "import"} disabled={Boolean(busy()) || !url().trim() || !service() || !source()?.connection.available} onClick={() => { void submit(); }}>导入工单</Button></div>}>
    <div class="dingtalk-import user-form">
      <label><span>钉钉记录链接</span><Input aria-label="钉钉记录链接" value={url()} disabled={Boolean(busy())} placeholder="https://alidocs.dingtalk.com/notable/record?dentryUuid=…&rowId=…&sheetId=…" onInput={event => { setUrl(event.currentTarget.value); setError(""); }} /></label>
      <div class="dingtalk-fields"><label><span>入口服务</span><Select aria-label="导入工单服务" value={service()} disabled={Boolean(busy())} options={services().map(service => ({ value: service.key, label: service.name }))} onChange={setService} /></label><label><span>处理方式</span><Select aria-label="导入工单处理方式" value={workMode()} disabled={Boolean(busy())} options={modes()} onChange={setWorkMode} /></label><label><span>优先级</span><Select aria-label="导入工单优先级" value={priority()} disabled={Boolean(busy())} options={priorityOptions} onChange={setPriority} /></label></div>
      <p class="dingtalk-note">直接导入这一条记录及其附件，不按人员或状态过滤，已有工单不会重复创建。</p>
      <For each={results()}>{row => <p role="status">{row.status === "created" ? "已创建" : `工单已存在${row.assignee ? `，当前处理人：${row.assignee.name || row.assignee.subject}` : "，当前未分配"}`}：<Button type="text" onClick={() => { if (props.onOpenIssue(row.issueKey)) props.onClose(); }}>{row.issueKey}</Button></p>}</For>
      <Show when={error()}><p role="alert" class="form-error">{error()}</p></Show>
    </div>
  </Modal>;
}
