import { Show } from "solid-js";
import { IssueCreatedError } from "../../../issues/creation-receipt";
import { RequestError } from "../data/client";
import { Button, Modal } from "../ui";

export type CreationProblem = IssueCreatedError | "unknown";
export function creationProblem(error: unknown): CreationProblem | undefined {
  if (error instanceof IssueCreatedError) return error;
  if (error instanceof RequestError) {
    if (error.outcome === "not_committed") return;
    if (error.outcome || (error.status ?? 0) >= 500 || error.status === 408) return "unknown";
  } else if (error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException) return "unknown";
}
export function creationNoticeText(receipt: IssueCreatedError) {
  return receipt.message === "issue_created_enqueue_unconfirmed"
    ? "工单已创建，但无法确认 Agent 是否已入队。请打开工单核对执行状态，不要重复创建。"
    : "工单已创建，但读取回执失败。请打开工单查看，不要重复创建。";
}

/** Opening the recorded key is a read; it never replays the POST or replaces an unrelated draft. */
export function IssueCreationNotice(props: { problem: CreationProblem | undefined; onClose: () => void }) {
  return (
    <Show when={props.problem} keyed>
      {(problem) => (
        <Modal open title={problem === "unknown" ? "创建结果待核对" : "工单已创建"} onOk={props.onClose} onCancel={props.onClose} footer={<Button onClick={props.onClose}>关闭</Button>}>
          {problem === "unknown" ? (
            <p role="alert">无法确认工单是否已创建。请关闭后先到工单列表核对，不要直接重试。</p>
          ) : (
            <>
              <p role="status">{creationNoticeText(problem)}</p>
              <a href={`/?issue=${encodeURIComponent(problem.issueKey)}`} target="_blank" rel="noopener noreferrer">
                打开已创建的工单：{problem.issueKey}（新标签页）
              </a>
            </>
          )}
        </Modal>
      )}
    </Show>
  );
}
