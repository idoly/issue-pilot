const PASTE_MARKER_SOURCE = String.raw`\[paste #(\d+)( (?:\+\d+ lines|\d+ chars))?\]`;

interface MarkerRange {
  id: number;
  start: number;
  end: number;
}

export interface PasteEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function markerRegex(): RegExp {
  return new RegExp(PASTE_MARKER_SOURCE, "g");
}

function normalizePaste(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("");
}

function markerLabel(id: number, content: string): string | null {
  const lines = content.split("\n");
  if (lines.length > 10) return `[paste #${id} +${lines.length} lines]`;
  return content.length > 1_000 ? `[paste #${id} ${content.length} chars]` : null;
}

export class PasteEditorModel {
  private counter = 0;
  private readonly contents = new Map<number, string>();

  reset(): void {
    this.counter = 0;
    this.contents.clear();
  }

  expand(value: string): string {
    return value.replace(markerRegex(), (marker, idText: string) => this.contents.get(Number(idText)) ?? marker);
  }

  insert(value: string, selectionStart: number, selectionEnd: number, pastedText: string): PasteEditResult | null {
    let content = normalizePaste(pastedText);
    if (!content) return null;

    const selection = this.expandSelection(value, selectionStart, selectionEnd);
    const selectedMarkers = this.ranges(value).filter((range) => range.start < selection.end && range.end > selection.start);
    for (const marker of selectedMarkers) this.contents.delete(marker.id);

    const withoutSelection = `${value.slice(0, selection.start)}${value.slice(selection.end)}`;
    const reconciled = this.reconcile(withoutSelection, selection.start, selection.start);
    const insertionPoint = reconciled.selectionStart;
    if (/^[/~.]/.test(content) && /\w/.test(reconciled.value.at(insertionPoint - 1) ?? "")) content = ` ${content}`;

    const nextId = this.counter + 1;
    const marker = markerLabel(nextId, content);
    const inserted = marker ?? content;
    if (marker) {
      this.counter = nextId;
      this.contents.set(nextId, content);
    }
    const nextValue = `${reconciled.value.slice(0, insertionPoint)}${inserted}${reconciled.value.slice(insertionPoint)}`;
    const cursor = insertionPoint + inserted.length;
    return { value: nextValue, selectionStart: cursor, selectionEnd: cursor };
  }

  delete(value: string, selectionStart: number, selectionEnd: number, direction: "backward" | "forward"): PasteEditResult | null {
    const intendedStart = selectionStart === selectionEnd && direction === "backward" ? Math.max(0, selectionStart - 1) : selectionStart;
    const intendedEnd = selectionStart === selectionEnd && direction === "forward" ? Math.min(value.length, selectionEnd + 1) : selectionEnd;
    const touched = this.ranges(value).filter((range) => range.start < intendedEnd && range.end > intendedStart);
    if (!touched.length) return null;

    const start = Math.min(intendedStart, ...touched.map((range) => range.start));
    const end = Math.max(intendedEnd, ...touched.map((range) => range.end));
    for (const marker of touched) this.contents.delete(marker.id);
    return this.reconcile(`${value.slice(0, start)}${value.slice(end)}`, start, start);
  }

  reconcile(value: string, selectionStart: number, selectionEnd: number): PasteEditResult {
    const activeIds = new Set(this.ranges(value).map((range) => range.id));
    for (const id of this.contents.keys()) {
      if (!activeIds.has(id)) this.contents.delete(id);
    }

    const idMap = new Map([...this.contents.keys()].sort((left, right) => left - right).map((id, index) => [id, index + 1]));
    const renumber = (text: string) => text.replace(markerRegex(), (marker, idText: string, suffix: string | undefined) => {
      const nextId = idMap.get(Number(idText));
      return nextId === undefined ? marker : `[paste #${nextId}${suffix ?? ""}]`;
    });
    const nextValue = renumber(value);
    const nextStart = renumber(value.slice(0, selectionStart)).length;
    const nextEnd = renumber(value.slice(0, selectionEnd)).length;
    const nextContents = new Map<number, string>();
    for (const [oldId, newId] of idMap) nextContents.set(newId, this.contents.get(oldId)!);
    this.contents.clear();
    for (const [id, content] of nextContents) this.contents.set(id, content);
    this.counter = this.contents.size;
    return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
  }

  expandSelection(value: string, selectionStart: number, selectionEnd: number): { start: number; end: number } {
    if (selectionStart === selectionEnd) return { start: selectionStart, end: selectionEnd };
    const touched = this.ranges(value).filter((range) => range.start < selectionEnd && range.end > selectionStart);
    if (!touched.length) return { start: selectionStart, end: selectionEnd };
    return {
      start: Math.min(selectionStart, ...touched.map((range) => range.start)),
      end: Math.max(selectionEnd, ...touched.map((range) => range.end)),
    };
  }

  snapCursor(value: string, cursor: number, direction: "backward" | "forward" | "nearest"): number {
    for (const marker of this.ranges(value)) {
      if (direction === "backward" && cursor > marker.start && cursor <= marker.end) return marker.start;
      if (direction === "forward" && cursor >= marker.start && cursor < marker.end) return marker.end;
      if (direction === "nearest" && cursor > marker.start && cursor < marker.end) {
        return cursor - marker.start <= marker.end - cursor ? marker.start : marker.end;
      }
    }
    return cursor;
  }

  private ranges(value: string): MarkerRange[] {
    const ranges: MarkerRange[] = [];
    for (const match of value.matchAll(markerRegex())) {
      const id = Number(match[1]);
      if (!this.contents.has(id)) continue;
      ranges.push({ id, start: match.index, end: match.index + match[0].length });
    }
    return ranges;
  }
}
