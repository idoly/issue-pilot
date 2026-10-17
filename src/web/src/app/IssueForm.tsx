import { Button, Modal, Segmented, Select, TextArea } from "../ui";
import { createSignal, For, Show } from "solid-js";

import { Maximize2, Paperclip, Trash2 } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
import type { IssueDetail, IssueExecutionItem } from "../data/client";
import { fileSize } from "./model";

export function selectedChoice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

export function DescriptionField(props: { value: () => string; inputLabel: string; expandLabel: string; onChange: (value: string) => void }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [mode, setMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const open = () => { setDraft(props.value()); setMode("edit"); setExpanded(true); };
  return (
    <div class="description-field">
      <div class="description-field-header"><span>描述</span><Button class="icon-button" type="text" shape="circle" icon={<Maximize2 size={14} />} title={props.expandLabel} aria-label={props.expandLabel} onClick={open} /></div>
      <TextArea aria-label={props.inputLabel} autoSize={{ minRows: 3, maxRows: 5 }} value={props.value()} onInput={(event) => props.onChange(event.currentTarget.value)} />
      <Modal open={expanded()} title="编辑描述" okText="应用" cancelText="取消" onOk={() => { props.onChange(draft()); setExpanded(false); }} onCancel={() => setExpanded(false)}>
        <div class="markdown-editor-toolbar"><Segmented size="small" aria-label="描述编辑模式" value={mode()} options={[{ value: "edit", label: "编辑" }, { value: "preview", label: "预览" }]} onChange={setMode} /></div>
        <Show when={mode() === "edit"} fallback={<div class="description-markdown-preview"><Show when={draft().trim()} fallback={<span class="muted">暂无内容</span>}><Markdown source={draft()} /></Show></div>}>
          <TextArea class="description-expanded-input" aria-label="放大描述编辑器" value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} />
        </Show>
      </Modal>
    </div>
  );
}

interface RelatedIssueOption {
  value: string;
  label: string;
  title: string;
  searchText: string;
  candidate: IssueExecutionItem;
}

export function RelatedIssueSelect(props: {
  candidates: IssueExecutionItem[];
  value: string[];
  loading?: boolean;
  inputLabel: string;
  onChange: (value: string[]) => void;
}) {
  const options = () => props.candidates.map((candidate): RelatedIssueOption => ({
    value: candidate.id,
    label: candidate.id,
    title: candidate.title,
    searchText: `${candidate.id} ${candidate.title} ${candidate.service.key} ${candidate.service.name}`.toLowerCase(),
    candidate,
  }));
  return (
    <div class="multi-select-trigger related-issue-select">
      <Select<RelatedIssueOption>
        mode="multiple"
        aria-label={props.inputLabel}
        loading={props.loading}
        value={props.value}
        onChange={props.onChange}
        options={options()}
        showSearch={{ filterOption: (input, option) => option.searchText.includes(input.trim().toLowerCase()) }}
        optionRender={(option) => (
          <div class="related-issue-option" title={`${option.candidate.id} · ${option.candidate.title}`}>
            <div><strong>{option.candidate.id}</strong><span>{option.candidate.service.name}</span></div>
            <small>{option.candidate.title}</small>
          </div>
        )}
        maxTagCount={2}
        listHeight={420}
        popupClass="related-issue-popup"
        popupMatchSelectWidth
        placeholder="搜索工单号、标题或服务"
        notFoundContent="没有匹配的工单"
      />
    </div>
  );
}

export function AttachmentPicker(props: {
  files: () => File[];
  existingFiles?: () => IssueDetail["attachments"];
  inputLabel: string;
  onRemoveExisting?: (id: string) => void;
  onFilesChange: (files: File[]) => void;
  onError: (message: string) => void;
}) {
  let input: HTMLInputElement | undefined;
  const existingFiles = () => props.existingFiles?.() ?? [];
  const totalCount = () => existingFiles().length + props.files().length;
  const selectFiles = (selected: File[]) => {
    props.onFilesChange([...props.files(), ...selected]);
    props.onError("");
  };
  return (
    <div class="attachment-picker">
      <input ref={input} class="visually-hidden" type="file" multiple aria-label={props.inputLabel} onChange={(event) => {
        selectFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      <div class="attachment-picker-header"><span>附件 <small>{totalCount()}</small></span><Button icon={<Paperclip size={14} />} onClick={() => input?.click()}>添加附件</Button></div>
      <Show when={totalCount()}>
        <div class="attachment-file-list">
          <For each={existingFiles()}>{(file) => <div class="attachment-file"><span><strong>{file.fileName}</strong><small>{file.mediaType} · {fileSize(file.size)}</small></span><Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.fileName}`} aria-label={`移除${file.fileName}`} onClick={() => props.onRemoveExisting?.(file.id)} /></div>}</For>
          <For each={props.files()}>{(file, index) => <div class="attachment-file"><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><Button class="icon-button" type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.name}`} aria-label={`移除${file.name}`} onClick={() => props.onFilesChange(props.files().filter((_, itemIndex) => itemIndex !== index()))} /></div>}</For>
        </div>
      </Show>
    </div>
  );
}
