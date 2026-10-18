import { createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "@solidjs/web";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { Button } from "../ui";
import { createSourceModel, monaco, sourceEditorOptions } from "./monaco";

export function SourceDiff(props: { value: { path: string; before: string; after: string }; toolbar: HTMLElement; onOpen: () => void; disabled: boolean }) {
  let container!: HTMLDivElement;
  let code: monaco.editor.IStandaloneDiffEditor | undefined, models: monaco.editor.IDiffEditorModel | undefined;
  let current: typeof props.value | undefined, changed: monaco.IDisposable | undefined;
  const [split, setSplit] = createSignal(window.innerWidth > 1550, { ownedWrite: true });
  const [counts, setCounts] = createSignal({ added: 0, removed: 0 }, { ownedWrite: true });
  createEffect(() => ({ value: props.value, split: split() }), state => {
    if (!code) {
      code = monaco.editor.createDiffEditor(container, {
        ...sourceEditorOptions, readOnly: true, originalEditable: false, renderSideBySide: state.split,
        useInlineViewWhenSpaceIsLimited: false, hideUnchangedRegions: { enabled: false }, maxComputationTime: issuePilotConfig.web.sourceDiffMs,
        renderOverviewRuler: true, renderMarginRevertIcon: false, ariaLabel: "代码差异",
      });
      changed = code.onDidUpdateDiff(() => {
        let added = 0, removed = 0;
        for (const change of code!.getLineChanges() ?? []) {
          if (change.modifiedStartLineNumber) added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
          if (change.originalStartLineNumber) removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
        }
        setCounts({ added, removed });
      });
    }
    code.updateOptions({ renderSideBySide: state.split });
    if (current !== state.value) {
      const previous = models;
      models = { original: createSourceModel(state.value.path, state.value.before), modified: createSourceModel(state.value.path, state.value.after) };
      current = state.value; code.setModel(models); previous?.original.dispose(); previous?.modified.dispose();
    }
  });
  onCleanup(() => { changed?.dispose(); code?.dispose(); models?.original.dispose(); models?.modified.dispose(); });
  return <div class="source-monaco-diff" role="region" aria-label="代码差异">
    <Portal mount={props.toolbar}><div class="source-diff-summary"><span class="added">+{counts().added}</span><span class="removed">−{counts().removed}</span><div><Button size="small" type="text" aria-pressed={split() ? "true" : "false"} onClick={() => setSplit(true)}>并排</Button><Button size="small" type="text" aria-pressed={split() ? "false" : "true"} onClick={() => setSplit(false)}>行内</Button><Button size="small" type="text" disabled={props.disabled} onClick={props.onOpen}>打开文件</Button></div></div></Portal>
    <div ref={container} class="source-monaco-editor" />
  </div>;
}
