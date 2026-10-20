import { createEffect, onCleanup, untrack } from "solid-js";
import { createSourceModel, monaco, sourceEditorOptions } from "./monaco";
import { sourceLanguage } from "./source-language";

type Reveal = { line: number; column: number; length: number };
export function SourceText(props: { path: string; value: string; readonly: boolean; reveal?: Reveal; onInput: (value: string) => void; onSave: () => void; onPosition: (line: number, column: number) => void }) {
  let container!: HTMLDivElement;
  let code: monaco.editor.IStandaloneCodeEditor | undefined, model: monaco.editor.ITextModel | undefined;
  let path = "", reveal: Reveal | undefined, synchronizing = false;
  const subscriptions: monaco.IDisposable[] = [];
  createEffect(() => ({ path: props.path, value: props.value, readonly: props.readonly, reveal: props.reveal }), value => {
    if (!code) {
      code = monaco.editor.create(container, { ...sourceEditorOptions, model: null });
      subscriptions.push(code.onDidChangeModelContent(() => untrack(() => {
        if (!synchronizing && model) props.onInput(model.getValue(monaco.editor.EndOfLinePreference.LF));
      })), code.onDidChangeCursorPosition(event => untrack(() => props.onPosition(event.position.lineNumber, event.position.column))));
      code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => untrack(props.onSave));
    }
    synchronizing = true;
    try {
      if (!model || path !== value.path) {
        const previous = model;
        model = createSourceModel(value.path, value.value); path = value.path;
        code.setModel(model); previous?.dispose();
      } else if (model.getValue(monaco.editor.EndOfLinePreference.LF) !== value.value) model.setValue(value.value);
      const language = sourceLanguage(value.path, value.value);
      if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
      code.updateOptions({ readOnly: value.readonly, ariaLabel: `代码内容 ${value.path}` });
      if (value.reveal && value.reveal !== reveal) {
        reveal = value.reveal;
        const start = model.validatePosition({ lineNumber: reveal.line, column: reveal.column });
        const end = model.getPositionAt(model.getOffsetAt(start) + reveal.length);
        code.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
        code.revealPositionInCenterIfOutsideViewport(start); code.focus();
        untrack(() => props.onPosition(end.lineNumber, end.column));
      }
    } finally { synchronizing = false; }
  });
  onCleanup(() => { for (const subscription of subscriptions) subscription.dispose(); code?.dispose(); model?.dispose(); });
  return <div ref={container} class="source-monaco-editor" />;
}
