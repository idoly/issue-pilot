import { createSignal, onCleanup } from "solid-js";

type Range = { current: number; minimum: number; maximum: number };

export function PanelResizeHandle(props: { name: string; class: string; orientation: "vertical" | "horizontal"; reverse?: boolean; range: () => Range; onResize: (size: number) => void }) {
  const [value, setValue] = createSignal<number | undefined>(undefined, { ownedWrite: true });
  let finish: (() => void) | undefined;
  const update = (size: number, range: Range) => {
    const next = Math.round(Math.max(range.minimum, Math.min(range.maximum, size)));
    setValue(next); props.onResize(next);
  };
  onCleanup(() => finish?.());
  return <div class={`source-resize-handle ${props.class}`} role="separator" tabindex="0" aria-label={props.name} aria-orientation={props.orientation} aria-valuenow={value()} onPointerDown={event => {
    if (event.button !== 0) return;
    finish?.(); event.preventDefault();
    const handle = event.currentTarget, pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const range = props.range(), start = props.orientation === "vertical" ? event.clientX : event.clientY;
    const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
    document.body.style.cursor = props.orientation === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const move = (next: PointerEvent) => update(range.current + ((props.orientation === "vertical" ? next.clientX : next.clientY) - start) * (props.reverse ? -1 : 1), range);
    const cancel = (key: KeyboardEvent) => { if (key.key === "Escape") { update(range.current, range); finish?.(); } };
    const end = () => finish?.();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end); window.addEventListener("blur", end);
    window.addEventListener("keydown", cancel);
    finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); window.removeEventListener("keydown", cancel);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = cursor; document.body.style.userSelect = selection; finish = undefined;
    };
  }} onKeyDown={event => {
    const decrease = props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp", increase = props.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    if (![decrease, increase, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const range = props.range();
    update(event.key === "Home" ? range.minimum : event.key === "End" ? range.maximum : range.current + (event.key === increase ? 10 : -10) * (props.reverse ? -1 : 1), range);
  }} />;
}
