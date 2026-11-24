import {
  createSelectController,
  Select as SelectRoot,
  SelectEmpty,
  SelectContent,
  SelectInput,
  SelectItem,
  SelectItemIndicator,
  SelectList,
  SelectStatus,
  SelectTrigger,
  type ListFilter,
} from "@ui-sdk/solid/select";
import { createEffect, createMemo, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ChevronDown, X } from "./icons";

export interface SelectOption {
  value: string;
  label: JSX.Element;
  disabled?: boolean;
}
type CommonProps<Option extends SelectOption> = {
  options: readonly Option[];
  "aria-label": string;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  allowClear?: boolean;
  onClear?: () => void;
  showSearch?: boolean | { filterOption: (input: string, option: Option) => boolean };
  optionRender?: (option: Option) => JSX.Element;
  labelRender?: (option: Option) => JSX.Element;
  maxTagCount?: number;
  popupClass?: string;
  popupMatchSelectWidth?: number;
  listHeight?: number;
  notFoundContent?: string;
};
type SelectProps<Option extends SelectOption> = CommonProps<Option> &
  ({ mode: "multiple"; value: string[]; onChange: (value: string[]) => void } | { mode?: undefined; value?: string | undefined; onChange: (value: Option["value"]) => void });

export function Select<const Option extends SelectOption>(props: SelectProps<Option>) {
  const controller = createSelectController<string, boolean>();
  let trigger: HTMLElement | undefined, search: HTMLInputElement | undefined;
  const focusControl = () => (controller.isOpen() && search?.isConnected ? search : trigger)?.focus();
  const inactive = () => props.disabled || props.loading;
  const multiple = () => props.mode === "multiple";
  const searchable = () => props.showSearch !== false && (Boolean(props.showSearch) || multiple());
  const values = () => (Array.isArray(props.value) ? props.value : props.value === undefined ? [] : [props.value]);
  const options = createMemo(() => new Map(props.options.map((option) => [option.value, option])), { name: "selectOptionsByValue" });
  const label = (value: string) => {
    const option = options().get(value);
    return option ? (props.labelRender?.(option) ?? option.label) : value;
  };
  const text = (value: string) => {
    const label = options().get(value)?.label;
    return typeof label === "string" ? label : value;
  };
  const filter: ListFilter<string> = (item, input) => {
    const option = options().get(item.value);
    return !!option && (typeof props.showSearch === "object" ? props.showSearch.filterOption(input, option) : `${item.value} ${item.label}`.toLowerCase().includes(input.trim().toLowerCase()));
  };
  createEffect(
    () => Boolean(inactive()),
    (disabled) => {
      if (disabled) controller.close();
    },
    { name: "closeInactiveSelect" },
  );
  const backspace: JSX.EventHandler<HTMLElement, KeyboardEvent> = (event) => {
    if (event.key === "Backspace" && !event.isComposing && event.keyCode !== 229 && !inactive() && props.mode === "multiple" && !controller.getQuery() && props.value.length) {
      event.preventDefault();
      props.onChange(props.value.slice(0, -1));
    }
  };
  return (
    <div class={`ui-select ${multiple() ? "ui-select-multiple" : ""} ${inactive() ? "is-disabled" : ""}`}>
      <SelectRoot<string, boolean>
        multiple={multiple()}
        value={props.value ?? null}
        disabled={inactive()}
        loop
        virtualFocus
        modal={false}
        controller={controller}
        filter={filter}
        itemToLabel={text}
        onValueChange={(value, details) => {
          // Consumers may switch identity or write configuration. Only choosing an item is a commit.
          if (details.reason !== "item-press" || inactive()) {
            details.cancel();
            return;
          }
          if (props.mode === "multiple" && Array.isArray(value)) {
            props.onChange(value);
            controller.setQuery("");
          } else if (props.mode !== "multiple" && typeof value === "string") props.onChange(value);
        }}
      >
        <SelectTrigger
          ref={(element) => {
            trigger = element;
          }}
          aria-label={props["aria-label"]}
          class="ui-select-selector"
          aria-disabled={inactive() ? "true" : undefined}
          onKeyDown={backspace}
          render={(attrs) => <div {...attrs} tabindex={inactive() ? -1 : 0} />}
        >
          <span class="ui-select-content">
            <Show when={values().length} fallback={<span class="ui-select-placeholder">{props.placeholder ?? "请选择"}</span>}>
              <Show when={multiple()} fallback={<span class="ui-select-item-content">{label(values()[0]!)}</span>}>
                <For each={values().slice(0, props.maxTagCount)}>
                  {(value) => (
                    <span class="ui-select-token">
                      <span>{label(value)}</span>
                      <button
                        type="button"
                        tabindex={-1}
                        aria-label={`移除 ${value}`}
                        disabled={inactive()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (props.mode === "multiple") props.onChange(props.value.filter((v) => v !== value));
                          focusControl();
                        }}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  )}
                </For>
                <Show when={values().length > (props.maxTagCount ?? Infinity)}>
                  <span class="ui-select-token">+{values().length - (props.maxTagCount ?? 0)}</span>
                </Show>
              </Show>
            </Show>
          </span>
          <ChevronDown size={13} />
        </SelectTrigger>
        <Show when={props.allowClear && values().length}>
          <button
            type="button"
            class="ui-select-clear"
            disabled={inactive()}
            aria-label={`清除 ${props["aria-label"]}`}
            onClick={() => {
              props.onClear?.();
              focusControl();
            }}
          >
            <X size={12} />
          </button>
        </Show>
        <SelectContent
          class={`ui-select-popup ${props.popupClass ?? ""}`}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          container={trigger?.closest("dialog")}
          style={{
            width: props.popupMatchSelectWidth !== undefined ? `${props.popupMatchSelectWidth}px` : "max(160px,var(--anchor-width))",
            "max-width": "calc(100vw - 16px)",
            "--select-list-height": `min(${props.listHeight ?? 300}px, var(--available-height, 300px) - ${searchable() ? 53 : 8}px)`,
          }}
        >
          <Show when={searchable()}>
            <SelectInput
              ref={(element) => {
                search = element;
              }}
              class="ui-select-search"
              aria-label={`搜索 ${props["aria-label"]}`}
              onKeyDown={backspace}
            />
          </Show>
          <SelectList class="ui-select-options">
            <For each={props.options}>
              {(option) => (
                <SelectItem class="ui-select-popup-list-item" value={option.value} label={text(option.value)} disabled={option.disabled}>
                  {props.optionRender?.(option) ?? option.label}
                  <SelectItemIndicator class="ui-select-check" />
                </SelectItem>
              )}
            </For>
          </SelectList>
          <Show when={searchable()}>
            <SelectStatus class="visually-hidden">{(state) => (state.count > 0 ? `找到 ${state.count} 项` : null)}</SelectStatus>
          </Show>
          <SelectEmpty class="ui-select-empty">{props.notFoundContent ?? "没有匹配项"}</SelectEmpty>
        </SelectContent>
      </SelectRoot>
    </div>
  );
}
