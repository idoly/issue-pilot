import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";
import { ChevronDown, X } from "./icons";

export interface SelectOption { value: string; label: JSX.Element; disabled?: boolean }
type CommonProps<Option extends SelectOption> = {
  options: readonly Option[];
  "aria-label": string;
  disabled?: boolean;
  loading?: boolean;
  size?: "small";
  placeholder?: string;
  allowClear?: boolean;
  onClear?: () => void;
  showSearch?: boolean | { filterOption: (input: string, option: Option) => boolean };
  optionRender?: (option: Option) => JSX.Element;
  labelRender?: (option: Option) => JSX.Element;
  maxTagCount?: number;
  popupClass?: string;
  popupMatchSelectWidth?: boolean | number;
  listHeight?: number;
  notFoundContent?: string;
};
type SelectProps<Option extends SelectOption> = CommonProps<Option> & (
  | { mode: "multiple"; value: string[]; onChange: (value: string[]) => void }
  | { mode?: undefined; value?: string | undefined; onChange: (value: Option["value"]) => void }
);

export function Select<const Option extends SelectOption>(props: SelectProps<Option>) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [active, setActive] = createSignal(0, { ownedWrite: true });
  const [position, setPosition] = createSignal<JSX.CSSProperties>({}, { ownedWrite: true });
  let root!: HTMLDivElement;
  let trigger!: HTMLDivElement;
  let popup: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  const multiple = () => props.mode === "multiple";
  const searchable = () => props.showSearch !== false && (Boolean(props.showSearch) || multiple());
  const selected = () => Array.isArray(props.value) ? props.value : props.value === undefined ? [] : [props.value];
  const optionByValue = (value: string) => props.options.find((option) => option.value === value);
  const visible = createMemo(() => props.options.filter((option) => {
    if (!query().trim()) return true;
    return typeof props.showSearch === "object" ? props.showSearch.filterOption(query(), option) : `${option.value} ${typeof option.label === "string" ? option.label : ""}`.toLowerCase().includes(query().trim().toLowerCase());
  }));
  const place = () => {
    if (!open() || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(typeof props.popupMatchSelectWidth === "number" ? props.popupMatchSelectWidth : Math.max(rect.width, 160), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(props.listHeight ?? 300, Math.max(below, above) - (searchable() ? 45 : 0));
    const up = below < Math.min(180, props.listHeight ?? 300) && above > below;
    setPosition({ position: "fixed", left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`, width: `${width}px`, ...(up ? { bottom: `${Math.max(8, window.innerHeight - rect.top + 4)}px` } : { top: `${rect.bottom + 4}px` }), "--select-list-height": `${Math.max(80, height)}px` });
  };
  const close = (focus = false) => { setOpen(false); setQuery(""); if (focus) trigger.focus(); };
  const show = () => {
    if (props.disabled || props.loading) return;
    setOpen(true); setActive(Math.max(0, visible().findIndex((option) => selected().includes(option.value)))); place();
    queueMicrotask(() => { if (open()) { place(); search?.focus(); } });
  };
  const choose = (option: Option) => {
    if (props.disabled || props.loading || option.disabled) return;
    if (props.mode === "multiple") {
      props.onChange(selected().includes(option.value) ? selected().filter((value) => value !== option.value) : [...selected(), option.value]);
      setQuery("");
      queueMicrotask(() => search?.focus());
    } else { props.onChange(option.value); close(true); }
  };
  const move = (direction: number) => {
    const options = visible();
    if (!options.length) return;
    let next = active();
    for (let step = 0; step < options.length; step += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActive(next);
    popup?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)?.scrollIntoView?.({ block: "nearest" });
  };
  const onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent> = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    if (event.key === "Backspace" && props.mode === "multiple" && !query() && selected().length) { event.preventDefault(); props.onChange(selected().slice(0, -1)); return; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!open()) show(); else move(event.key === "ArrowDown" ? 1 : -1); return; }
    if (open() && ["Home", "End"].includes(event.key)) { event.preventDefault(); setActive(event.key === "Home" ? 0 : Math.max(0, visible().length - 1)); return; }
    if (event.key === "Enter" || event.key === " " && event.target === trigger) {
      event.preventDefault();
      if (!open()) show(); else { const option = visible()[active()]; if (option) choose(option); }
    }
  };
  createEffect(() => ({ disabled: props.disabled, loading: props.loading }), ({ disabled, loading }) => { if (disabled || loading) close(); });
  const outside = (event: MouseEvent) => {
    const path = event.composedPath();
    if (open() && !path.includes(root) && !(popup && path.includes(popup))) close();
  };
  document.addEventListener("click", outside);
  window.addEventListener("resize", place);
  document.addEventListener("scroll", place, true);
  onCleanup(() => { document.removeEventListener("click", outside); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); });
  const label = (value: string) => {
    const option = optionByValue(value);
    return option ? props.labelRender?.(option) ?? option.label : value;
  };
  return <div ref={root} class={`ui-select ${multiple() ? "ui-select-multiple" : ""} ${props.disabled ? "is-disabled" : ""}`}>
    <div ref={trigger} class="ui-select-selector" role="combobox" tabindex={props.disabled ? -1 : 0} aria-label={props["aria-label"]} aria-expanded={open() ? "true" : "false"} aria-controls={open() ? `${id}-list` : undefined} aria-haspopup="listbox" aria-disabled={props.disabled || props.loading ? "true" : undefined} aria-activedescendant={open() && visible()[active()] ? `${id}-option-${active()}` : undefined} onKeyDown={onKeyDown} onClick={() => open() ? close() : show()}>
      <span class="ui-select-content"><Show when={selected().length} fallback={<span class="ui-select-placeholder">{props.placeholder ?? "请选择"}</span>}>
        <Show when={multiple()} fallback={<span class="ui-select-item-content">{label(selected()[0]!)}</span>}>
          <For each={selected().slice(0, props.maxTagCount ?? Number.POSITIVE_INFINITY)}>{(value) => <span class="ui-select-token"><span>{label(value)}</span><button type="button" tabindex={-1} aria-label={`移除 ${value}`} disabled={props.disabled || props.loading} onClick={(event) => { event.stopPropagation(); if (props.mode === "multiple") props.onChange(selected().filter((item) => item !== value)); }}><X size={11} /></button></span>}</For>
          <Show when={selected().length > (props.maxTagCount ?? Number.POSITIVE_INFINITY)}><span class="ui-select-token">+{selected().length - (props.maxTagCount ?? 0)}</span></Show>
        </Show>
      </Show></span>
      <Show when={props.allowClear && selected().length}><button type="button" class="ui-select-clear" disabled={props.disabled || props.loading} aria-label={`清除 ${props["aria-label"]}`} onClick={(event) => { event.stopPropagation(); props.onClear?.(); }}><X size={12} /></button></Show><ChevronDown size={13} />
    </div>
    <Show when={open()}><Portal><div ref={popup} class={`ui-select-popup ${props.popupClass ?? ""}`} style={position()} onKeyDown={onKeyDown}>
      <Show when={searchable()}><input ref={search} class="ui-select-search" aria-label={`搜索 ${props["aria-label"]}`} role="searchbox" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setActive(0); }} /></Show>
      <div role="listbox" id={`${id}-list`} aria-label={props["aria-label"]} aria-multiselectable={multiple() ? "true" : undefined} class="ui-select-options"><For each={visible()} fallback={<div class="ui-select-empty">{props.notFoundContent ?? "没有匹配项"}</div>}>{(option, index) => <div role="option" id={`${id}-option-${index()}`} data-option-index={index()} class="ui-select-popup-list-item" aria-selected={selected().includes(option.value) ? "true" : "false"} aria-disabled={option.disabled ? "true" : undefined} data-active={active() === index() ? "true" : undefined} onMouseEnter={() => setActive(index())} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>{props.optionRender?.(option) ?? option.label}<Show when={selected().includes(option.value)}><span class="ui-select-check" aria-hidden="true" /></Show></div>}</For></div>
    </div></Portal></Show>
  </div>;
}
