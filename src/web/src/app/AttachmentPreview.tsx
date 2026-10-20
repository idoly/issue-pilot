import { Button, Modal, Skeleton } from "../ui";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";

import { Copy, Download, Paperclip, ZoomIn, ZoomOut } from "../ui/icons";
import { copyText as copyToClipboard } from "../ui/clipboard";
import { attachmentUrl, fetchAttachment, type IssueDetail } from "../data/client";

import { attachmentPreviewKind } from "./file-preview";

type IssueAttachment = IssueDetail["attachments"][number];

export function AttachmentPreview(props: { issueKey: string; attachment: IssueAttachment | null; onClose: () => void }) {
  const [attempt, setAttempt] = createSignal(0, { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [text, setText] = createSignal("", { ownedWrite: true });
  const [objectUrl, setObjectUrl] = createSignal("", { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [copied, setCopied] = createSignal(false, { ownedWrite: true });
  const [copyError, setCopyError] = createSignal("", { ownedWrite: true });
  const [imageZoom, setImageZoom] = createSignal(1, { ownedWrite: true });
  const [imageDragging, setImageDragging] = createSignal(false, { ownedWrite: true });
  let requestSequence = 0;
  let controller: AbortController | undefined;
  let imageViewport: HTMLDivElement | undefined;
  let imageDrag: { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | undefined;

  const reset = () => {
    requestSequence += 1;
    controller?.abort(); controller = undefined;
    const url = untrack(objectUrl);
    if (url) URL.revokeObjectURL(url);
    setObjectUrl("");
    setText("");
    setError("");
    setCopied(false); setCopyError("");
    setImageZoom(1);
    setImageDragging(false);
    imageDrag = undefined;
    setLoading(false);
  };
  createEffect(
    () => ({ attachment: props.attachment, issueKey: props.issueKey, attempt: attempt() }),
    ({ attachment, issueKey }) => {
      reset();
      if (!attachment || attachmentPreviewKind(attachment) === "unsupported") return;
      const sequence = ++requestSequence;
      controller = new AbortController();
      setLoading(true);
      void fetchAttachment(issueKey, attachment.id, controller.signal).then(async (blob) => {
        if (sequence !== requestSequence) return;
        if (attachmentPreviewKind(attachment) === "text") {
          const content = await blob.text();
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
    const sequence = requestSequence;
    setCopied(false); setCopyError("");
    try {
      await copyToClipboard(text());
      if (sequence === requestSequence) setCopied(true);
    } catch {
      if (sequence === requestSequence) setCopyError("复制失败，请选中文字后手动复制。");
    }
  };

  return (
    <Modal width={960} open={Boolean(props.attachment)} title={props.attachment?.fileName ?? "附件预览"} onOk={props.onClose} onCancel={props.onClose} footer={<>
      <Show when={props.attachment}>{attachment => <a class="ui-button" data-variant="outlined" href={attachmentUrl(props.issueKey, attachment().id)} download={attachment().fileName}><Download size={15} />下载文件</a>}</Show>
      <Button type="primary" onClick={props.onClose}>关闭</Button>
    </>}>
      <div class="attachment-preview">
        <Show when={!loading()} fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
          <Show when={!error()} fallback={<div class="attachment-preview-message is-error" role="alert"><p>{error()}</p><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></div>}>
            <Show when={props.attachment}>{(attachment) => {
              const kind = () => attachmentPreviewKind(attachment());
              return <Show when={kind() !== "unsupported"} fallback={<div class="attachment-preview-message" role="status"><Paperclip size={24} /><p>此格式不支持内嵌预览，请下载查看</p></div>}>
                <Show when={kind() !== "text"} fallback={<div class="attachment-text-preview-shell"><div class="attachment-preview-toolbar"><Button icon={<Copy size={14} />} onClick={() => { void copyText(); }}>{copied() ? "已复制" : "复制文字"}</Button></div><Show when={copyError()}><div class="create-error" role="alert">{copyError()}</div></Show><pre class="attachment-text-preview" tabindex="0">{text()}</pre></div>}>
                  <Show when={kind() !== "image"} fallback={<div class="attachment-image-preview-shell"><div class="attachment-preview-toolbar"><Button class="icon-button" type="text" shape="circle" icon={<ZoomOut size={15} />} disabled={imageZoom() <= 1} title="缩小" aria-label="缩小" onClick={() => changeImageZoom(imageZoom() / 1.25)} /><button type="button" class="attachment-zoom-value" title="恢复 100%" aria-label="恢复 100%" onClick={() => changeImageZoom(1)}>{Math.round(imageZoom() * 100)}%</button><Button class="icon-button" type="text" shape="circle" icon={<ZoomIn size={15} />} disabled={imageZoom() >= 4} title="放大" aria-label="放大" onClick={() => changeImageZoom(imageZoom() * 1.25)} /></div><div ref={imageViewport} class={`attachment-image-viewport${imageZoom() > 1 ? " is-pannable" : ""}${imageDragging() ? " is-dragging" : ""}`} onWheel={handleImageWheel} onPointerDown={beginImageDrag} onPointerMove={moveImageDrag} onPointerUp={endImageDrag} onPointerCancel={endImageDrag}><div class="attachment-image-stage" style={{ width: `${imageZoom() * 100}%`, height: `${imageZoom() * 100}%` }}><img class="attachment-image-preview" src={objectUrl()} alt={attachment().fileName} draggable={false} /></div></div></div>}>
                    <iframe class="attachment-pdf-preview" src={objectUrl()} title={`预览 ${attachment().fileName}`} />
                  </Show>
                </Show>
              </Show>;
            }}</Show>
          </Show>
        </Show>
      </div>
    </Modal>
  );
}
