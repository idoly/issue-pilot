import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../ui";
import { ChevronRight, Download, File, Folder, Repo, RefreshCw } from "../ui/icons";
import { errorMessage, attachmentUrl, fetchAttachment, fetchIssueWorkFile, issueWorkFileUrl, listIssueWorkFiles, type IssueDetail, type IssueWorkFile } from "../data/client";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { AttachmentPreview } from "./AttachmentPreview";
import { attachmentPreviewKind, workingFileMediaType } from "./file-preview";
import { useApplicationResources } from "./ApplicationResources";

export function IssueFiles(props: { issue: IssueDetail; hidden?: boolean }) {
  const { currentUser } = useApplicationResources();
  const originalAttachment = (file: IssueWorkFile) => props.issue.attachments.find(attachment => attachment.storedFileName === file.path);
  const fileName = (file: IssueWorkFile) => originalAttachment(file)?.fileName ?? file.name;
  const [preview, setPreview] = createSignal<IssueWorkFile | null>(null, { ownedWrite: true });
  const previewAttachment = createMemo(() => {
    const file = preview();
    return file ? originalAttachment(file) ?? { id: file.path, fileName: file.name, mediaType: workingFileMediaType(file.name) ?? "application/octet-stream", size: file.size, sha256: "" } : null;
  });
  const canPreview = (file: IssueWorkFile) => {
    if (file.kind !== "file" || file.size > issuePilotConfig.web.outputPreviewBytes) return false;
    const original = originalAttachment(file);
    return original ? attachmentPreviewKind(original) !== "unsupported" : !file.managed && Boolean(workingFileMediaType(file.name));
  };
  const [directory, setDirectory] = createSignal("", { ownedWrite: true });
  const [files, setFiles] = createSignal<IssueWorkFile[]>([], { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [refresh, setRefresh] = createSignal(0, { ownedWrite: true });
  createEffect(() => `${props.issue.id}:${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, () => {
    setDirectory(""); setFiles([]); setError(""); setPreview(null);
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
  const repositoryDirectory = (file: IssueWorkFile) => file.kind === "directory" && props.issue.repositories.some(repo => repo.name === file.path);
  const parent = () => directory().split("/").slice(0, -1).join("/");
  return <section class="attachment-band" aria-labelledby="working-files-title">
    <div class="band-title working-files-heading"><File size={16} /><h2 id="working-files-title">工作目录</h2><Show when={directory()}><span class="working-directory-path" title={directory()}>{directory()}</span></Show><div class="working-files-actions"><Show when={directory()}><Button type="text" size="small" aria-label="返回上级" title="返回上级" onClick={() => setDirectory(parent())}><ChevronRight class="directory-up-icon" size={14} /></Button></Show><Button type="text" size="small" aria-label="刷新工作目录" title="刷新工作目录" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></Button></div></div>
    <Show when={error()}><div role="alert">{error()}</div></Show>
    <Show when={loading()}><div class="empty-band">正在读取文件…</div></Show>
    <Show when={!loading() && !error()}>
      <div class="issue-directory-list"><For each={files()} fallback={<div class="empty-band">目录为空</div>}>{file => <div class="issue-attachment-row" title={file.path}>
        <Show when={file.kind === "directory"} fallback={<File size={15} />}><Show when={repositoryDirectory(file)} fallback={<Folder size={15} />}><Repo size={15} /></Show></Show>
        <Show when={file.kind === "directory"} fallback={<Show when={canPreview(file)} fallback={<span class="attachment-file-info"><strong>{fileName(file)}</strong></span>}><button type="button" class="attachment-preview-trigger" aria-label={`预览工作文件 ${fileName(file)}`} onClick={() => setPreview(file)}><span class="attachment-file-info"><strong>{fileName(file)}</strong></span></button></Show>}>
          <button type="button" class="attachment-preview-trigger" aria-label={`打开目录 ${file.name}`} onClick={() => setDirectory(file.path)}><span class="attachment-file-info"><strong>{file.name}</strong></span></button>
        </Show>
        <Show when={file.kind === "directory"}><ChevronRight class="directory-chevron" size={14} /></Show>
        <Show when={file.kind === "file" && (!file.managed || originalAttachment(file))}><a class="attachment-download-link" href={originalAttachment(file) ? attachmentUrl(props.issue.id, originalAttachment(file)!.id) : issueWorkFileUrl(props.issue.id, file.path)} download={fileName(file)} aria-label={`下载工作文件 ${fileName(file)}`}><Download size={15} /></a></Show>
      </div>}</For></div>
    </Show>
    <AttachmentPreview issueKey={props.issue.id} attachment={previewAttachment()} loadFile={async signal => {
      const file = preview(); if (!file) throw new Error("issue_file_not_found");
      const original = originalAttachment(file);
      if (original) return fetchAttachment(props.issue.id, original.id, signal);
      const blob = await fetchIssueWorkFile(props.issue.id, file.path, signal);
      return new Blob([blob], { type: workingFileMediaType(file.name) ?? "application/octet-stream" });
    }} onClose={() => setPreview(null)} />
  </section>;
}
