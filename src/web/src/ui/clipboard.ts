export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* The HTTP deployment can still use the browser's selection-based copy. */ }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text; input.readOnly = true;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(input);
  try {
    input.focus({ preventScroll: true }); input.select();
    if (!document.execCommand("copy")) throw new Error("clipboard_write_failed");
  } finally {
    input.remove(); active?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) if (document.contains(range.commonAncestorContainer)) selection.addRange(range); }
  }
}
