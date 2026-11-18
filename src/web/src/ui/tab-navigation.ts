import type { JSX } from "@solidjs/web";

/** Activate a neighbouring tab through its existing click handler. Tab itself keeps native focus order. */
export const navigateTabList: JSX.EventHandler<HTMLElement, KeyboardEvent> = (event) => {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const { key, target, currentTarget } = event;
  if (!(target instanceof HTMLButtonElement) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  const tabs = Array.from(currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button[role="tab"]:enabled'));
  const index = tabs.indexOf(target);
  if (index === -1) return;
  event.preventDefault();
  const last = tabs.length - 1;
  const next = tabs[key === "Home" ? 0 : key === "End" ? last : (index + (key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
  if (next !== target) {
    next.focus();
    next.click();
  }
};
