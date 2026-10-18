import { Button, Modal, Skeleton } from "../ui";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { errorMessage, fetchOutput, outputUrl, type IssueDetail } from "../data/client";
import { Download } from "../ui/icons";
import { Markdown } from "../ui/Markdown";

type IssueOutput = IssueDetail["outputs"][number];

export function OutputPreview(props: { issueKey: string; output: IssueOutput | null; onClose: () => void }) {
  const [text, setText] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [attempt, setAttempt] = createSignal(0, { ownedWrite: true });
  let controller: AbortController | undefined;
  let generation = 0;
  createEffect(() => ({ issueKey: props.issueKey, output: props.output, attempt: attempt() }), ({ issueKey, output }) => {
    controller?.abort();
    const current = ++generation;
    setText(""); setError(""); setLoading(false);
    if (!output) return;
    if (!/\.(csv|json|jsonl|sql|txt|md|markdown|log|ya?ml|xml|tsv)$/i.test(output.fileName)) {
      setError("此格式暂不支持预览，请下载查看");
      return;
    }
    if (output.size > issuePilotConfig.web.outputPreviewBytes) {
      setError("文件过大，请下载查看完整内容");
      return;
    }
    controller = new AbortController();
    setLoading(true);
    const request = fetchOutput(issueKey, output.fileName, controller.signal).then((content) => {
      if (current !== generation) return;
      if (/\.json$/i.test(output.fileName)) {
        try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Show original content for incomplete JSON. */ }
      }
      setText(content);
    });
    void request.catch((cause) => {
      if (current === generation) setError(errorMessage(cause));
    }).finally(() => { if (current === generation) setLoading(false); });
  });
  onCleanup(() => { generation += 1; controller?.abort(); });

  return <Modal width={960} open={Boolean(props.output)} title={props.output?.fileName ?? "成果文件预览"} okText="关闭" cancelText="取消" onOk={props.onClose} onCancel={props.onClose}>
    <div class="attachment-preview">
      <div class="attachment-preview-toolbar">
        <Show when={error()}><Button onClick={() => setAttempt((value) => value + 1)}>重试</Button></Show>
        <Show when={props.output}>{(output) => <a class="attachment-download-link" href={outputUrl(props.issueKey, output().fileName)} download={output().fileName}><Download size={15} />下载文件</a>}</Show>
      </div>
      <Show when={!loading()} fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
        <Show when={!error()} fallback={<div class="workspace-error" role="alert">{error()}</div>}>
          <Show when={text()} fallback={<div class="empty-band">文件内容为空</div>}>
            <Show when={/\.(md|markdown)$/i.test(props.output?.fileName ?? "")} fallback={<pre class="attachment-text-preview" tabindex="0">{text()}</pre>}>
              <div class="output-markdown-preview"><Markdown source={text()} /></div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  </Modal>;
}
