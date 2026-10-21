import { createEffect, createSignal, For, Show } from "solid-js";
import { Button } from "../ui";
import { Download, File, RefreshCw } from "../ui/icons";
import { errorMessage, issueWorkFileUrl, listIssueWorkFiles, type IssueDetail, type IssueWorkFile } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { fileSize } from "./model";

export function IssueFiles(props: { issue: IssueDetail; hidden?: boolean }) {
  const { currentUser } = useApplicationResources();
  const [directory, setDirectory] = createSignal("", { ownedWrite: true });
  const [files, setFiles] = createSignal<IssueWorkFile[]>([], { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [refresh, setRefresh] = createSignal(0, { ownedWrite: true });
  createEffect(() => `${props.issue.id}:${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, () => {
    setDirectory(""); setFiles([]); setError("");
  });
  createEffect(() => ({ key: props.issue.id, subject: currentUser()?.subject, role: currentUser()?.role, directory: directory(), updatedAt: props.issue.updatedAt, hidden: props.hidden, refresh: refresh() }), (input) => {
    const controller = new AbortController();
    let current = true;
    setFiles([]); setError(""); setLoading(false);
    if (input.hidden || !input.subject) return;
    setLoading(true);
    void listIssueWorkFiles(input.key, input.directory, controller.signal).then((rows) => {
      if (current) setFiles(rows);
    }).catch((cause) => {
      if (current && !controller.signal.aborted) setError(errorMessage(cause));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  });
  const category = (file: IssueWorkFile) => {
    if (file.kind === "directory") return props.issue.repositories.some(repo => repo.name === file.path) ? "代码仓库" : "目录";
    if (file.kind === "link") return "链接（不提供下载）";
    if (file.kind === "special") return "特殊文件（不提供下载）";
    if (props.issue.attachments.some(a => a.workingFileName === file.path)) return "附件工作副本";
    return "工作文件";
  };
  const parent = () => directory().split("/").slice(0, -1).join("/");
  return <section class="attachment-band" aria-labelledby="working-files-title">
    <div class="band-title"><File size={16} /><h2 id="working-files-title">工作文件</h2><span>{directory() || "工单根目录"}</span><Button size="small" aria-label="刷新工作文件" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></Button></div>
    <Show when={directory()}><Button size="small" onClick={() => setDirectory(parent())}>返回上级</Button></Show>
    <Show when={error()}><div role="alert">{error()}</div></Show>
    <Show when={loading()}><div class="empty-band">正在读取文件…</div></Show>
    <Show when={!loading() && !error()}>
      <For each={files()} fallback={<div class="empty-band">暂无工作文件</div>}>{file => <div class="issue-attachment-row">
        <File size={15} />
        <Show when={file.kind === "directory"} fallback={<span class="attachment-file-info"><strong>{file.name}</strong><small>{category(file)} · {fileSize(file.size)}</small></span>}>
          <button type="button" class="attachment-preview-trigger" onClick={() => setDirectory(file.path)}><span class="attachment-file-info"><strong>{file.name}</strong><small>{category(file)}</small></span></button>
        </Show>
        <Show when={file.kind === "file"}><a class="attachment-download-link" href={issueWorkFileUrl(props.issue.id, file.path)} download={file.name} aria-label={`下载工作文件 ${file.name}`}><Download size={15} /></a></Show>
      </div>}</For>
    </Show>
  </section>;
}
