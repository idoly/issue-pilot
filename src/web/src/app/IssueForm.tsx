import { Button, Modal, Segmented, TextArea } from "@idoly/ant-design-solid";
import { createSignal, For, Show } from "solid-js";

import { Maximize2, Paperclip, Trash2 } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
import { ISSUE_TYPES_BY_ENVIRONMENT, type IssueDetail, type IssueType } from "../data/client";
import { fileSize } from "./model";

export function selectedStrings(value: unknown, current: string[]): string[] {
  if (value === null || value === undefined) return current;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

export function selectedChoice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

export const environmentLabel: Record<string, string> = { prod: "正式", test: "测试", dev: "开发" };

export function issueTypesForEnvironment(environmentKey: string): IssueType[] {
  return [...(ISSUE_TYPES_BY_ENVIRONMENT[environmentKey as keyof typeof ISSUE_TYPES_BY_ENVIRONMENT] ?? [])];
}

export function bindMultipleSelectBlankToggle(element: HTMLDivElement, setOpen: (open: boolean) => void): void {
  let blankWasOpen = false;
  element.addEventListener("mousedown", (event) => {
    blankWasOpen = event.target instanceof HTMLElement
      && event.target.classList.contains("ads-select-selector")
      && element.querySelector('[role="combobox"]')?.getAttribute("aria-expanded") === "true";
  }, { capture: true });
  element.addEventListener("click", (event) => {
    if (blankWasOpen) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    blankWasOpen = false;
  }, { capture: true });
}

export function DescriptionField(props: { value: () => string; inputLabel: string; expandLabel: string; onChange: (value: string) => void }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [mode, setMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const open = () => { setDraft(props.value()); setMode("edit"); setExpanded(true); };
  return (
    <div class="description-field">
      <div class="description-field-header"><span>描述</span><Button type="text" shape="circle" icon={<Maximize2 size={14} />} title={props.expandLabel} aria-label={props.expandLabel} onClick={open} /></div>
      <TextArea aria-label={props.inputLabel} autoSize={{ minRows: 3, maxRows: 5 }} value={props.value()} onInput={(event) => props.onChange(event.currentTarget.value)} />
      <Modal open={expanded()} title="编辑描述" okText="应用" cancelText="取消" onOk={() => { props.onChange(draft()); setExpanded(false); }} onCancel={() => setExpanded(false)}>
        <div class="markdown-editor-toolbar"><Segmented size="small" aria-label="描述编辑模式" value={mode()} options={[{ value: "edit", label: "编辑" }, { value: "preview", label: "预览" }]} onChange={(value) => setMode(value as "edit" | "preview")} /></div>
        <Show when={mode() === "edit"} fallback={<div class="description-markdown-preview"><Show when={draft().trim()} fallback={<span class="muted">暂无内容</span>}><Markdown source={draft()} /></Show></div>}>
          <TextArea class="description-expanded-input" aria-label="放大描述编辑器" value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} />
        </Show>
      </Modal>
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
          <For each={existingFiles()}>{(file) => <div class="attachment-file"><span><strong>{file.fileName}</strong><small>{file.mediaType} · {fileSize(file.size)}</small></span><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.fileName}`} aria-label={`移除${file.fileName}`} onClick={() => props.onRemoveExisting?.(file.id)} /></div>}</For>
          <For each={props.files()}>{(file, index) => <div class="attachment-file"><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.name}`} aria-label={`移除${file.name}`} onClick={() => props.onFilesChange(props.files().filter((_, itemIndex) => itemIndex !== index()))} /></div>}</For>
        </div>
      </Show>
    </div>
  );
}
