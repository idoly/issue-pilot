import { Button, Skeleton } from "../ui";
import { createMemo, For, Show } from "solid-js";

import type { IssueExecutionItem } from "../data/client";
import { ChevronRight, RefreshCw } from "../ui/icons";
import { useApplicationResources } from "./ApplicationResources";
import { environmentName, relativeTime } from "./model";

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
  onSelectIssue: (issueKey: string, userSubject?: string) => void;
}) {
  const { catalog } = useApplicationResources();
  const activeIssues = createMemo(() => props.issues.filter((issue) => issue.status !== "resolved"));
  const focusIssues = createMemo(() =>
    activeIssues()
      .map((issue) => ({ issue, rank: attentionRank(issue), updatedAt: Date.parse(issue.updatedAt) }))
      .sort((left, right) => left.rank - right.rank || right.updatedAt - left.updatedAt)
      .map((row) => row.issue),
  );
  const running = createMemo(() => activeIssues().filter((issue) => issue.agentRunning || issue.workspaceStatus === "running" || issue.workspaceStatus === "preparing").length);
  const failed = createMemo(() => activeIssues().filter((issue) => issue.workspaceStatus === "failed").length);
  const unassigned = createMemo(() => activeIssues().filter((issue) => !issue.assigneeSubject).length);

  return (
    <section class="dashboard-workspace">
      <header class="dashboard-header">
        <div>
          <h1>运营总览</h1>
        </div>
        <Button aria-label="刷新运营总览" icon={<RefreshCw size={14} />} loading={props.refreshing} onClick={props.onRefresh}>
          刷新
        </Button>
      </header>
      <Show
        when={!props.loading}
        fallback={
          <div class="dashboard-loading">
            <Skeleton active paragraph={{ rows: 10 }} />
          </div>
        }
      >
        <Show when={props.loadError}>
          <div class="dashboard-error" role="alert">
            {props.loadError}
          </div>
        </Show>
        <Show when={!props.loadError || props.issues.length > 0}>
          <section class="dashboard-summary" aria-label="当前运营状态">
            <div>
              <span>活动工单</span>
              <strong>{activeIssues().length}</strong>
            </div>
            <div>
              <span>正在执行</span>
              <strong>{running()}</strong>
            </div>
            <div>
              <span>执行失败</span>
              <strong>{failed()}</strong>
            </div>
            <div>
              <span>未分配</span>
              <strong>{unassigned()}</strong>
            </div>
          </section>
          <div class="dashboard-operations">
            <section class="dashboard-attention" aria-label="团队工单动态">
              <div class="dashboard-section-heading">
                <h2 title="异常和执行中优先，其余按最近更新排序">团队工单动态</h2>
              </div>
              <div class="dashboard-attention-list" role="list">
                <For each={focusIssues()} keyed={(row) => row.id} fallback={<div class="dashboard-empty">当前没有未解决工单</div>}>
                  {(issue) => {
                    const state = () => executionState(issue());
                    return (
                      <div role="listitem">
                        <button type="button" class="dashboard-attention-item" onClick={() => props.onSelectIssue(issue().id, issue().assigneeSubject ?? undefined)}>
                          <span class={`execution-state ${state().key}`}>
                            <i />
                            {state().label}
                          </span>
                          <div>
                            <strong title={issue().title}>{issue().title}</strong>
                            <span>
                              <code>{issue().id}</code> · {issue().service.name} / {environmentName(catalog().environments, issue().environmentKey)}
                            </span>
                          </div>
                          <span class="dashboard-assignee">{issue().assignee ?? "未分配"}</span>
                          <time datetime={issue().updatedAt} title={new Date(issue().updatedAt).toLocaleString()}>
                            {relativeTime(issue().updatedAt)}
                          </time>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </section>
          </div>
        </Show>
      </Show>
    </section>
  );
}
