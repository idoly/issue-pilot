import { describe, expect, it } from "vitest";

import { PasteEditorModel } from "./paste-editor";

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");

describe("Pi-style paste editor", () => {
  it("collapses large line and character pastes but keeps short text visible", () => {
    const editor = new PasteEditorModel();
    const short = editor.insert("before ", 7, 7, "short\ttext")!;
    expect(short.value).toBe("before short    text");

    const multiline = editor.insert(short.value, short.selectionStart, short.selectionEnd, lines(11))!;
    expect(multiline.value).toBe("before short    text[paste #1 +11 lines]");

    const long = editor.insert(multiline.value, multiline.selectionStart, multiline.selectionEnd, "x".repeat(1_001))!;
    expect(long.value).toBe("before short    text[paste #1 +11 lines][paste #2 1001 chars]");
    expect(editor.expand(long.value)).toBe(`before short    text${lines(11)}${"x".repeat(1_001)}`);
  });

  it("treats markers as atomic cursor and selection units", () => {
    const editor = new PasteEditorModel();
    const pasted = editor.insert("ab", 1, 1, lines(12))!;
    const markerStart = 1;
    const markerEnd = pasted.selectionStart;

    expect(editor.snapCursor(pasted.value, markerEnd, "backward")).toBe(markerStart);
    expect(editor.snapCursor(pasted.value, markerStart, "forward")).toBe(markerEnd);
    expect(editor.snapCursor(pasted.value, markerStart + 4, "nearest")).toBe(markerStart);
    expect(editor.expandSelection(pasted.value, markerStart + 2, markerEnd - 2)).toEqual({ start: markerStart, end: markerEnd });
  });

  it("deletes a whole marker and renumbers remaining pastes", () => {
    const editor = new PasteEditorModel();
    const first = editor.insert("", 0, 0, lines(11, "first"))!;
    const second = editor.insert(first.value, first.selectionStart, first.selectionEnd, lines(12, "second"))!;
    expect(second.value).toBe("[paste #1 +11 lines][paste #2 +12 lines]");

    const deleted = editor.delete(second.value, first.selectionStart, first.selectionStart, "backward")!;
    expect(deleted.value).toBe("[paste #1 +12 lines]");
    expect(deleted.selectionStart).toBe(0);
    expect(editor.expand(deleted.value)).toBe(lines(12, "second"));
  });

  it("removes a marker when only part of it is selected", () => {
    const editor = new PasteEditorModel();
    const pasted = editor.insert("prefix suffix", 7, 7, lines(11))!;
    const deleted = editor.delete(pasted.value, 9, pasted.selectionStart - 2, "forward")!;
    expect(deleted.value).toBe("prefix suffix");
    expect(editor.expand(deleted.value)).toBe("prefix suffix");
  });

  it("resets paste numbering for a new editor session", () => {
    const editor = new PasteEditorModel();
    expect(editor.insert("", 0, 0, lines(11))!.value).toBe("[paste #1 +11 lines]");
    editor.reset();
    expect(editor.insert("", 0, 0, lines(12))!.value).toBe("[paste #1 +12 lines]");
  });
});
