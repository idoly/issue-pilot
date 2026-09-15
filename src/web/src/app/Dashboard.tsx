import { Button, Skeleton } from "@idoly/ant-design-solid";
import { createMemo, For, Show } from "solid-js";

import type { IssueExecutionItem } from "../data/client";
import { ChevronRight, RefreshCw } from "../ui/icons";
import { useApplicationResources } from "./ApplicationResources";
import { relativeTime } from "./model";

type ExecutionState = "running" | "preparing" | "failed" | "pending";

function executionState(issue: IssueExecutionItem): { key: ExecutionState; label: string } {
  if (issue.agentRunning || issue.workspaceStatus === "running") return { key: "running", label: "执行中" };
  if (issue.workspaceStatus === "preparing") return { key: "preparing", label: "环境准备中" };
  if (issue.workspaceStatus === "failed") return { key: "failed", label: "执行失败" };
  return { key: "pending", label: issue.status === "pending" ? "待确认" : "待执行" };
}

function attentionRank(issue: IssueExecutionItem): number {
  const state = executionState(issue).key;
  return state === "failed" ? 0 : state === "running" || state === "preparing" ? 1 : 2;
}

export function Dashboard(props: {
  issues: IssueExecutionItem[];
  loading: boolean;
  loadError: string;
  refreshing: boolean;
  onRefresh: () => void;
  onSelectIssue: (issueKey: string) => void;
}) {
  const { catalog } = useApplicationResources();
  const activeIssues = createMemo(() => props.issues.filter((issue) => issue.status !== "resolved"));
  const focusIssues = createMemo(() => activeIssues()
    .sort((left, right) => attentionRank(left) - attentionRank(right) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()));
  const running = createMemo(() => activeIssues().filter((issue) => issue.agentRunning || issue.workspaceStatus === "running" || issue.workspaceStatus === "preparing").length);
  const failed = createMemo(() => activeIssues().filter((issue) => issue.workspaceStatus === "failed").length);
  const unassigned = createMemo(() => activeIssues().filter((issue) => !issue.assigneeSubject).length);
  const environmentName = (key: string) => catalog().environments.find((environment) => environment.key === key)?.name ?? key;

  return (
    <section class="dashboard-workspace">
      <header class="dashboard-header">
        <div><span>每 10 秒自动刷新</span><h1>运营总览</h1></div>
        <Button aria-label="刷新运营总览" icon={<RefreshCw size={14} />} loading={props.refreshing} onClick={props.onRefresh}>刷新</Button>
      </header>
      <Show when={!props.loading} fallback={<div class="dashboard-loading"><Skeleton active paragraph={{ rows: 10 }} /></div>}>
        <Show when={!props.loadError} fallback={<div class="dashboard-error" role="alert">{props.loadError}</div>}>
          <section class="dashboard-summary" aria-label="当前运营状态">
            <div><span>活动工单</span><strong>{activeIssues().length}</strong><small>当前所有未解决工单</small></div>
            <div><span>正在执行</span><strong>{running()}</strong><small>Agent / Workspace</small></div>
            <div><span>执行失败</span><strong>{failed()}</strong><small>需要人工检查</small></div>
            <div><span>未分配</span><strong>{unassigned()}</strong><small>当前活动工单</small></div>
          </section>
          <div class="dashboard-operations">
            <section class="dashboard-attention" aria-label="团队工单动态">
              <div class="dashboard-section-heading"><div><span>跨人员视图</span><h2>团队工单动态</h2></div><small>异常和执行中优先，其余按最近更新排序</small></div>
              <div class="dashboard-attention-list" role="list">
                <For each={focusIssues()} fallback={<div class="dashboard-empty">当前没有未解决工单</div>}>
                  {(issue) => { const state = executionState(issue); return (
                    <button type="button" role="listitem" class="dashboard-attention-item" onClick={() => props.onSelectIssue(issue.id)}>
                      <span class={`execution-state ${state.key}`}><i />{state.label}</span>
                      <div><strong>{issue.title}</strong><span><code>{issue.id}</code> · {issue.service.name} / {environmentName(issue.environmentKey)}</span></div>
                      <span class="dashboard-assignee">{issue.assignee ?? "未分配"}</span><time>{relativeTime(issue.updatedAt)}</time><ChevronRight size={15} aria-hidden="true" />
                    </button>
                  ); }}
                </For>
              </div>
            </section>
          </div>
        </Show>
      </Show>
    </section>
  );
}
