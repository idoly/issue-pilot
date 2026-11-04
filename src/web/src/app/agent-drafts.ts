import { createSignal, type Accessor } from "solid-js";

import { PasteEditorModel } from "./paste-editor";

export interface AgentDraftImage {
  file: File;
  url: string;
}

export interface AgentDraftRecord {
  text: string;
  images: AgentDraftImage[];
  pasteEditor: PasteEditorModel;
  error: string;
  /** A message from this record is in flight; remounted panels must show it and must not resend. */
  sending: boolean;
}

function emptyDraft(): AgentDraftRecord {
  return { text: "", images: [], pasteEditor: new PasteEditorModel(), error: "", sending: false };
}

function revoke(images: readonly AgentDraftImage[]): void {
  for (const image of images) URL.revokeObjectURL(image.url);
}

/**
 * Application-scoped drafts and send failures, keyed by Issue. Panel navigation and per-Issue
 * remounts must not discard unsent work; identity changes clear everything via `clearAll`.
 */
export class AgentDraftStore {
  private readonly records = new Map<string, AgentDraftRecord>();
  private readonly version = createSignal(0, { ownedWrite: true });
  readonly revision: Accessor<number> = this.version[0];
  private readonly setVersion = this.version[1];

  get(issueId: string): AgentDraftRecord {
    let record = this.records.get(issueId);
    if (!record) {
      record = emptyDraft();
      this.records.set(issueId, record);
    }
    return record;
  }

  isCurrent(issueId: string, record: AgentDraftRecord): boolean {
    return this.records.get(issueId) === record;
  }

  /** Unsent text, images or an in-flight send would be lost on reload. */
  hasPending(): boolean {
    for (const record of this.records.values()) if (record.sending || record.text.trim().length > 0 || record.images.length) return true;
    return false;
  }

  /** Notify mounted panels that a record changed outside them, such as a send finishing after navigation. */
  touch(): void {
    this.setVersion((value) => value + 1);
  }

  clear(issueId: string): void {
    const record = this.records.get(issueId);
    if (!record) return;
    revoke(record.images);
    this.records.delete(issueId);
    this.setVersion((value) => value + 1);
  }

  clearAll(): void {
    for (const record of this.records.values()) revoke(record.images);
    this.records.clear();
    this.setVersion((value) => value + 1);
  }
}

export const defaultAgentDraftStore = new AgentDraftStore();

/** Test and identity-change reset for panels that use the default store. */
export function clearAgentDrafts(): void {
  defaultAgentDraftStore.clearAll();
}
