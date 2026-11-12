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

function ModalContent(props: ModalProps) {
  const id = createUniqueId();
  let panel!: HTMLDialogElement;
  let opener: HTMLElement | undefined;
  const cancel = () => {
    if (!props.cancelButtonProps?.disabled && !props.confirmLoading) props.onCancel();
  };
  queueMicrotask(() => {
    if (!panel?.isConnected) return;
    if (document.activeElement instanceof HTMLElement) opener = document.activeElement;
    panel.showModal();
    panel.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled),textarea:not(:disabled),[role="combobox"][tabindex="0"]')?.focus();
  });
  onCleanup(() => {
    panel?.close();
    // Solid can detach the portal before cleanup, bypassing the browser's restoration.
    if (document.activeElement === document.body && opener?.isConnected) opener.focus({ preventScroll: true });
  });
  return (
    <Portal>
      <dialog
        ref={panel}
        class="ui-modal-container"
        aria-labelledby={id}
        style={{ width: `${props.width ?? 560}px` }}
        onCancel={(event) => {
          // Open state and busy cancellation remain owned by the caller.
          event.preventDefault();
          cancel();
        }}
      >
        <header class="ui-modal-header">
          <h2 id={id}>{props.title}</h2>
          <Button type="text" shape="circle" icon={<X size={18} />} aria-label="关闭弹窗" disabled={props.confirmLoading || props.cancelButtonProps?.disabled} onClick={cancel} />
        </header>
        <div class="ui-modal-body">{props.children}</div>
        <footer class="ui-modal-footer">
          {props.footer === undefined ? (
            <>
              <Button disabled={props.cancelButtonProps?.disabled || props.confirmLoading} onClick={cancel}>
                {props.cancelText ?? "取消"}
              </Button>
              <Button type="primary" danger={props.okButtonProps?.danger} disabled={props.okButtonProps?.disabled} loading={props.confirmLoading} onClick={props.onOk}>
                {props.okText ?? "确定"}
              </Button>
            </>
          ) : (
            props.footer
          )}
          {props.footerExtra}
        </footer>
      </dialog>
    </Portal>
  );
}

export function Modal(props: ModalProps) {
  return (
    <Show when={props.open}>
      <ModalContent {...props} />
    </Show>
  );
}
