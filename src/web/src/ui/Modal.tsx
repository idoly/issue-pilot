import { createUniqueId, onCleanup, Show } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";
import { Button, type ButtonProps } from "./controls";
import { X } from "./icons";

interface ModalProps {
  open: boolean;
  title: string;
  width?: number;
  children?: JSX.Element;
  footerExtra?: JSX.Element;
  footer?: JSX.Element;
  okText?: string;
  cancelText?: string;
  confirmLoading?: boolean;
  okButtonProps?: Pick<ButtonProps, "disabled" | "danger">;
  cancelButtonProps?: Pick<ButtonProps, "disabled">;
  onOk: () => void;
  onCancel: () => void;
}

const modalStack: HTMLElement[] = [];
let previousOverflow = "";
let nextLayer = 0;
const focusable = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';

function ModalContent(props: ModalProps) {
  const id = createUniqueId();
  const layer = 1000 + ++nextLayer * 10;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  let panel!: HTMLDivElement;
  let disposed = false;
  const cancel = () => { if (!props.cancelButtonProps?.disabled && !props.confirmLoading) props.onCancel(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (modalStack.at(-1) !== panel || event.defaultPrevented) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key !== "Tab") return;
    const fields = [...panel.querySelectorAll<HTMLElement>(focusable)].filter((element) => !element.closest("[hidden]"));
    const first = fields[0] ?? panel;
    const last = fields.at(-1) ?? panel;
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };
  queueMicrotask(() => {
    if (disposed) return;
    if (!modalStack.length) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    modalStack.push(panel);
    document.addEventListener("keydown", onKeyDown);
    const initial = panel.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),[role="combobox"]');
    (initial ?? panel).focus();
  });
  onCleanup(() => {
    disposed = true;
    document.removeEventListener("keydown", onKeyDown);
    const index = modalStack.indexOf(panel);
    const wasTop = index === modalStack.length - 1;
    if (index >= 0) {
      modalStack.splice(index, 1);
      if (!modalStack.length) document.body.style.overflow = previousOverflow;
      if (wasTop && returnFocus?.isConnected) returnFocus.focus();
    }
  });
  return <Portal><div class="ui-modal-mask" style={{ "z-index": layer }} onClick={(event) => { if (event.target === event.currentTarget && modalStack.at(-1) === panel) cancel(); }}>
    <div ref={panel} class="ui-modal-container" role="dialog" aria-modal="true" aria-labelledby={id} tabindex={-1} style={{ width: `${props.width ?? 560}px` }}>
      <header class="ui-modal-header"><h2 id={id}>{props.title}</h2><Button type="text" shape="circle" icon={<X size={18} />} aria-label="关闭弹窗" disabled={props.confirmLoading || props.cancelButtonProps?.disabled} onClick={cancel} /></header>
      <div class="ui-modal-body">{props.children}</div>
      <footer class="ui-modal-footer">{props.footer === undefined ? <><Button disabled={props.cancelButtonProps?.disabled || props.confirmLoading} onClick={cancel}>{props.cancelText ?? "取消"}</Button><Button type="primary" danger={props.okButtonProps?.danger} disabled={props.okButtonProps?.disabled} loading={props.confirmLoading} onClick={props.onOk}>{props.okText ?? "确定"}</Button></> : props.footer}{props.footerExtra}</footer>
    </div>
  </div></Portal>;
}

export function Modal(props: ModalProps) { return <Show when={props.open}><ModalContent {...props} /></Show>; }
