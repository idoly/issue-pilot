import { createEffect, For, omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import "./controls.css";

export type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  type?: "primary" | "text" | "default";
  htmlType?: "button" | "submit" | "reset";
  size?: "small" | "middle";
  shape?: "circle" | "round";
  loading?: boolean;
  danger?: boolean;
  icon?: JSX.Element;
};

export function Button(props: ButtonProps) {
  const rest = omit(props, "type", "htmlType", "size", "shape", "loading", "danger", "icon", "class", "children", "disabled");
  return <button {...rest} type={props.htmlType ?? "button"} class={`ui-button ${props.size === "small" ? "ui-button-small" : ""} ${props.shape ? `ui-button-${props.shape}` : ""} ${props.class ?? ""}`} data-variant={props.type === "primary" ? "solid" : props.type === "text" ? "text" : "outlined"} data-danger={props.danger ? "true" : undefined} disabled={props.disabled || props.loading} aria-busy={props.loading ? "true" : undefined}>
    <Show when={props.loading} fallback={props.icon}><span class="ui-spinner" aria-hidden="true" /></Show>{props.children}
  </button>;
}

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "prefix"> & { prefix?: JSX.Element; allowClear?: boolean };
export function Input(props: InputProps) {
  const rest = omit(props, "prefix", "allowClear", "class");
  let element!: HTMLInputElement;
  return <span class={`ui-input-affix-wrapper ${props.class ?? ""}`}><Show when={props.prefix}><span class="ui-input-prefix" aria-hidden="true">{props.prefix}</span></Show><input {...rest} ref={element} class="ui-input" /><Show when={props.allowClear && props.value && !props.disabled}><button type="button" class="ui-select-clear" aria-label={`清除 ${props["aria-label"] ?? "输入"}`} onClick={() => { element.value = ""; element.dispatchEvent(new Event("input", { bubbles: true })); element.focus(); }}>×</button></Show></span>;
}

export function PasswordInput(props: InputProps) { return <Input {...props} type="password" autocomplete="off" />; }

type TextAreaProps = Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "onInput"> & {
  autoSize?: { minRows: number; maxRows: number };
  onInput?: JSX.EventHandler<HTMLTextAreaElement, InputEvent>;
};
export function TextArea(props: TextAreaProps) {
  const rest = omit(props, "autoSize", "class", "onInput");
  let element: HTMLTextAreaElement | undefined;
  const resize = () => {
    if (!element || !props.autoSize) return;
    const style = getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 22;
    const extra = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0) + 2;
    element.style.height = "auto";
    element.style.height = `${Math.min(props.autoSize.maxRows * line + extra, Math.max(props.autoSize.minRows * line + extra, element.scrollHeight))}px`;
    element.style.overflowY = element.scrollHeight > props.autoSize.maxRows * line + extra ? "auto" : "hidden";
  };
  createEffect(() => props.value, () => { queueMicrotask(resize); });
  return <span class={`ui-textarea-wrapper ${props.class ?? ""}`}><textarea {...rest} ref={element} rows={props.autoSize?.minRows ?? props.rows ?? 3} class="ui-textarea" onInput={(event) => { props.onInput?.(event); resize(); }} /></span>;
}

export function Tag(props: { color?: string; children?: JSX.Element }) {
  return <span class="ui-tag" data-color={props.color ?? "default"}>{props.children}</span>;
}

export function Badge(props: { status?: "default" | "processing" | "warning" | "success"; text?: string }) {
  return <span class="ui-badge" data-status={props.status ?? "default"}><i aria-hidden="true" /><span class="ui-badge-status-text">{props.text}</span></span>;
}

export function Toggle(props: { checked: boolean; disabled?: boolean; size?: "small"; "aria-label": string; onChange: (checked: boolean) => void }) {
  return <button type="button" class="ui-switch" role="switch" aria-label={props["aria-label"]} aria-checked={props.checked ? "true" : "false"} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}><span /></button>;
}

export function Segmented<const T extends string>(props: { options: Array<{ value: T; label: JSX.Element }>; value: T; onChange: (value: T) => void; size?: "small"; "aria-label": string }) {
  return <div class="ui-segmented" role="radiogroup" aria-label={props["aria-label"]}><For each={props.options}>{(option, index) => <button type="button" role="radio" aria-checked={props.value === option.value ? "true" : "false"} tabindex={props.value === option.value ? 0 : -1} onClick={() => props.onChange(option.value)} onKeyDown={(event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const count = props.options.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index() + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + count) % count;
    props.onChange(props.options[next]!.value);
    (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
  }}>{option.label}</button>}</For></div>;
}

export function Skeleton(props: { active?: boolean; paragraph?: { rows: number } }) {
  return <div class={`ui-skeleton ${props.active ? "is-active" : ""}`} aria-busy="true" aria-label="加载中"><For each={Array.from({ length: props.paragraph?.rows ?? 3 })}>{() => <span />}</For></div>;
}
