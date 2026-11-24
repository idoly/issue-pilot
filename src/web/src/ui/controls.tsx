import { Button as SdkButton } from "@ui-sdk/solid/button";
import { Input as SdkInput, InputGroup, InputClear } from "@ui-sdk/solid/input";
import { PasswordInput as PasswordRoot, PasswordInputControl } from "@ui-sdk/solid/password-input";
import { Checkbox as CheckboxRoot, CheckboxIndicator } from "@ui-sdk/solid/checkbox";
import { Textarea } from "@ui-sdk/solid/textarea";
import { createSegmentedControlController, SegmentedControl, SegmentedControlItem } from "@ui-sdk/solid/segmented-control";
import { For, omit, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import "./controls.css";

export type ButtonProps = Omit<Parameters<typeof SdkButton>[0], "type" | "children" | "class"> & {
  type?: "primary" | "text" | "default";
  htmlType?: "button" | "submit" | "reset";
  children?: JSX.Element;
  class?: string;
  size?: "small" | "middle";
  shape?: "circle" | "round";
  loading?: boolean;
  danger?: boolean;
  icon?: JSX.Element;
};

export function Button(props: ButtonProps) {
  const rest = omit(props, "type", "htmlType", "size", "shape", "loading", "danger", "icon", "class", "children", "disabled");
  return (
    <SdkButton
      {...rest}
      type={props.htmlType ?? "button"}
      class={`ui-button ${props.size === "small" ? "ui-button-small" : ""} ${props.shape ? `ui-button-${props.shape}` : ""} ${props.class ?? ""}`}
      data-variant={props.type === "primary" ? "solid" : props.type === "text" ? "text" : "outlined"}
      data-danger={props.danger ? "true" : undefined}
      disabled={props.disabled || props.loading}
      aria-busy={props.loading ? "true" : undefined}
    >
      <Show when={props.loading} fallback={props.icon}>
        <span class="ui-spinner" aria-hidden="true" />
      </Show>
      {props.children}
    </SdkButton>
  );
}

type InputProps = Omit<Parameters<typeof SdkInput>[0], "prefix" | "value" | "class" | "onInput"> & { prefix?: JSX.Element; allowClear?: boolean; value?: string | number; class?: string };
export function Input(props: InputProps) {
  const rest = omit(props, "prefix", "allowClear", "class", "value");
  return (
    <InputGroup class={`ui-input-affix-wrapper ${props.class ?? ""}`}>
      <Show when={props.prefix}>
        <span class="ui-input-prefix" aria-hidden="true">
          {props.prefix}
        </span>
      </Show>
      <SdkInput {...rest} value={props.value === undefined ? undefined : String(props.value)} class="ui-input" />
      <Show when={props.allowClear && props.value && !props.disabled}>
        <InputClear class="ui-select-clear" aria-label={`清除 ${props["aria-label"] ?? "输入"}`}>
          ×
        </InputClear>
      </Show>
    </InputGroup>
  );
}

type PasswordProps = Pick<InputProps, "aria-label" | "aria-describedby" | "maxlength" | "placeholder" | "disabled" | "onValueChange"> & { value: string };
export function PasswordInput(props: PasswordProps) {
  const control = omit(props, "value", "disabled", "onValueChange");
  return (
    <PasswordRoot class="ui-input-affix-wrapper" autoComplete="off" visible={false} value={props.value} disabled={Boolean(props.disabled)} onValueChange={props.onValueChange}>
      <PasswordInputControl {...control} class="ui-input" />
    </PasswordRoot>
  );
}

export function Checkbox(props: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <CheckboxRoot class="ui-checkbox" checked={props.checked} disabled={props.disabled} onCheckedChange={(checked) => props.onChange(checked === true)}>
      <CheckboxIndicator aria-hidden="true" />
    </CheckboxRoot>
  );
}

type TextAreaProps = Omit<Parameters<typeof Textarea>[0], "onInput"> & {
  autoSize?: { minRows: number; maxRows: number };
};
export function TextArea(props: TextAreaProps) {
  const rest = omit(props, "autoSize", "class", "rows");
  return (
    <span class={`ui-textarea-wrapper ${props.class ?? ""}`} style={props.autoSize && { "--textarea-min-rows": props.autoSize.minRows, "--textarea-max-rows": props.autoSize.maxRows }}>
      <Textarea {...rest} rows={props.autoSize?.minRows ?? props.rows ?? 3} class={`ui-textarea${props.autoSize ? " ui-textarea-autosize" : ""}`} />
    </span>
  );
}

export function Tag(props: { color?: string; children?: JSX.Element }) {
  return (
    <span class="ui-tag" data-color={props.color ?? "default"}>
      {props.children}
    </span>
  );
}

export function Badge(props: { status?: "default" | "processing" | "warning" | "success" | "error"; text?: string }) {
  return (
    <span class="ui-badge" data-status={props.status ?? "default"}>
      <i aria-hidden="true" />
      <span class="ui-badge-status-text">{props.text}</span>
    </span>
  );
}

export function Segmented<const T extends string>(props: { options: Array<{ value: T; label: JSX.Element }>; value: T; onChange: (value: T) => void; "aria-label": string }) {
  const controller = createSegmentedControlController<T>();
  return (
    <SegmentedControl<T>
      class="ui-segmented"
      controller={controller}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== "Home" && event.key !== "End") return;
        const target = props.options.at(event.key === "Home" ? 0 : -1);
        if (!target) return;
        event.preventDefault();
        controller.setValue(target.value, { reason: "list-navigation", event });
        // Focus the accepted value, not the requested one: the caller may refuse to discard a draft.
        queueMicrotask(() => controller.focus());
      }}
      aria-label={props["aria-label"]}
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
      loop
    >
      <For each={props.options}>{(option) => <SegmentedControlItem value={option.value}>{option.label}</SegmentedControlItem>}</For>
    </SegmentedControl>
  );
}

export function Skeleton(props: { active?: boolean; paragraph?: { rows: number } }) {
  return (
    <div class={`ui-skeleton ${props.active ? "is-active" : ""}`} aria-busy="true" aria-label="加载中">
      <For each={Array.from({ length: props.paragraph?.rows ?? 3 })}>{() => <span />}</For>
    </div>
  );
}
