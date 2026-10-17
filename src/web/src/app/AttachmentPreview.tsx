import { Button, Modal, Skeleton } from "../ui";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";

import { Copy, Download, Paperclip, ZoomIn, ZoomOut } from "../ui/icons";
import { ExcelPreview } from "./ExcelPreview";
import { attachmentUrl, fetchAttachment, type IssueDetail } from "../data/client";

type IssueAttachment = IssueDetail["attachments"][number];
type AttachmentPreviewKind = "image" | "text" | "pdf" | "excel" | "unsupported";

function attachmentPreviewKind(attachment: IssueAttachment): AttachmentPreviewKind {
  if (/\.(xlsx|xls)$/i.test(attachment.fileName)) return "excel";
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType)) return "image";
  if (attachment.mediaType === "application/pdf") return "pdf";
  if (attachment.mediaType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(attachment.mediaType) || /\.(txt|log|md|csv|json|xml|ya?ml|properties)$/i.test(attachment.fileName)) return "text";
  return "unsupported";
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : ""));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("attachment_preview_failed")));
    reader.readAsText(blob);
  });
}

export function AttachmentPreview(props: { issueKey: string; attachment: IssueAttachment | null; onClose: () => void }) {
  const [excelBlob, setExcelBlob] = createSignal<Blob | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [text, setText] = createSignal("", { ownedWrite: true });
  const [objectUrl, setObjectUrl] = createSignal("", { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [copied, setCopied] = createSignal(false, { ownedWrite: true });
  const [imageZoom, setImageZoom] = createSignal(1, { ownedWrite: true });
  const [imageDragging, setImageDragging] = createSignal(false, { ownedWrite: true });
  let requestSequence = 0;
  let imageViewport: HTMLDivElement | undefined;
  let imageDrag: { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | undefined;

  const reset = () => {
    requestSequence += 1;
    const url = untrack(objectUrl);
    if (url) URL.revokeObjectURL(url);
    setObjectUrl("");
    setExcelBlob(null);
    setText("");
    setError("");
    setCopied(false);
    setImageZoom(1);
    setImageDragging(false);
    imageDrag = undefined;
    setLoading(false);
  };
  createEffect(
    () => ({ attachment: props.attachment, issueKey: props.issueKey }),
    ({ attachment, issueKey }) => {
      reset();
      if (!attachment || attachmentPreviewKind(attachment) === "unsupported") return;
      const sequence = ++requestSequence;
      setLoading(true);
      void fetchAttachment(issueKey, attachment.id).then(async (blob) => {
        if (sequence !== requestSequence) return;
        if (attachmentPreviewKind(attachment) === "excel") { setExcelBlob(blob); return; }
        if (attachmentPreviewKind(attachment) === "text") {
          const content = await readBlobText(blob);
          if (sequence === requestSequence) setText(content);
        } else {
          setObjectUrl(URL.createObjectURL(blob));
        }
      }).catch((cause) => {
        if (sequence === requestSequence) setError(cause instanceof Error ? cause.message : "attachment_preview_failed");
      }).finally(() => {
        if (sequence === requestSequence) setLoading(false);
      });
    },
  );
  onCleanup(reset);

  const changeImageZoom = (requestedZoom: number, focusX?: number, focusY?: number) => {
    const previousZoom = imageZoom();
    const nextZoom = Math.min(4, Math.max(1, Math.round(requestedZoom * 100) / 100));
    if (nextZoom === previousZoom) return;
    const viewport = imageViewport;
    const x = focusX ?? (viewport?.clientWidth ?? 0) / 2;
    const y = focusY ?? (viewport?.clientHeight ?? 0) / 2;
    const contentX = (viewport?.scrollLeft ?? 0) + x;
    const contentY = (viewport?.scrollTop ?? 0) + y;
    setImageZoom(nextZoom);
    if (viewport) requestAnimationFrame(() => {
      const ratio = nextZoom / previousZoom;
      viewport.scrollLeft = contentX * ratio - x;
      viewport.scrollTop = contentY * ratio - y;
    });
  };
  const handleImageWheel = (event: WheelEvent) => {
    event.preventDefault();
    const viewport = imageViewport;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    changeImageZoom(imageZoom() * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - bounds.left, event.clientY - bounds.top);
  };
  const beginImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageZoom() <= 1 || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    imageDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    setImageDragging(true);
  };
  const moveImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageDrag?.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewport.scrollLeft = imageDrag.scrollLeft - (event.clientX - imageDrag.x);
    viewport.scrollTop = imageDrag.scrollTop - (event.clientY - imageDrag.y);
  };
  const endImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageDrag?.pointerId !== event.pointerId) return;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    imageDrag = undefined;
    setImageDragging(false);
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
    } catch {
      setError("clipboard_write_failed");
    }
  };

  return (
    <Modal width={860} open={Boolean(props.attachment)} title={props.attachment?.fileName ?? "附件预览"} okText="关闭" cancelText="取消" onOk={props.onClose} onCancel={props.onClose}>
      <div class="attachment-preview">
        <Show when={!loading()} fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
          <Show when={!error()} fallback={<div class="workspace-error" role="alert">{error()}</div>}>
            <Show when={props.attachment}>{(attachment) => {
              const kind = () => attachmentPreviewKind(attachment());
              return <Show when={kind() !== "excel"} fallback={<Show when={excelBlob()}>{(blob) => <ExcelPreview blob={blob()} fileName={attachment().fileName} />}</Show>}><Show when={kind() !== "unsupported"} fallback={<div class="attachment-preview-unsupported"><Paperclip size={24} /><strong>此格式不支持内嵌预览</strong><a href={attachmentUrl(props.issueKey, attachment().id)} download={attachment().fileName}><Download size={15} />下载附件</a></div>}>
                <Show when={kind() !== "text"} fallback={<div class="attachment-text-preview-shell"><div class="attachment-preview-toolbar"><Button icon={<Copy size={14} />} onClick={() => { void copyText(); }}>{copied() ? "已复制" : "复制文字"}</Button></div><pre class="attachment-text-preview" tabindex="0">{text()}</pre></div>}>
                  <Show when={kind() !== "image"} fallback={<div class="attachment-image-preview-shell"><div class="attachment-preview-toolbar"><Button class="icon-button" type="text" shape="circle" icon={<ZoomOut size={15} />} disabled={imageZoom() <= 1} title="缩小" aria-label="缩小" onClick={() => changeImageZoom(imageZoom() / 1.25)} /><button type="button" class="attachment-zoom-value" title="恢复 100%" aria-label="恢复 100%" onClick={() => changeImageZoom(1)}>{Math.round(imageZoom() * 100)}%</button><Button class="icon-button" type="text" shape="circle" icon={<ZoomIn size={15} />} disabled={imageZoom() >= 4} title="放大" aria-label="放大" onClick={() => changeImageZoom(imageZoom() * 1.25)} /></div><div ref={imageViewport} class={`attachment-image-viewport${imageZoom() > 1 ? " is-pannable" : ""}${imageDragging() ? " is-dragging" : ""}`} onWheel={handleImageWheel} onPointerDown={beginImageDrag} onPointerMove={moveImageDrag} onPointerUp={endImageDrag} onPointerCancel={endImageDrag}><div class="attachment-image-stage" style={{ width: `${imageZoom() * 100}%`, height: `${imageZoom() * 100}%` }}><img class="attachment-image-preview" src={objectUrl()} alt={attachment().fileName} draggable={false} /></div></div></div>}>
                    <iframe class="attachment-pdf-preview" src={objectUrl()} title={`预览 ${attachment().fileName}`} />
                  </Show>
                </Show>
              </Show></Show>;
            }}</Show>
          </Show>
        </Show>
      </div>
    </Modal>
  );
}
