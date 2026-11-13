import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { errorMessage, listIssues, type IssueDetail, type IssueExecutionItem } from "../data/client";
import { createLatestTask } from "../data/latest";

interface IssueEntity {
  summary: IssueExecutionItem;
  detail?: IssueDetail;
}

function summaryFromDetail(detail: IssueDetail): IssueExecutionItem {
  return {
    id: detail.id,
    title: detail.title,
    priority: detail.priority,
    type: detail.type,
    status: detail.status,
    assignee: detail.assignee,
    assigneeSubject: detail.assigneeSubject,
    service: detail.service,
    environmentKey: detail.environmentKey,
    revision: detail.revision,
    ...(detail.createdAt ? { createdAt: detail.createdAt } : {}),
    updatedAt: detail.updatedAt,
    workspaceStatus: detail.workspace.status,
    agentRunning: detail.agentRunning === true,
    resolvedAt: detail.resolvedAt ?? null,
  };
}

/**
 * One application-owned entity map for the queue, overview, statistics and selected detail.
 * Summaries and details of the same Issue share an entry; the server revision decides when
 * the detail must be refetched, so views do not maintain parallel copies.
 */
export function createIssueList(scope: Accessor<string | false> = () => "issues") {
  const [entities, setEntities] = createSignal<ReadonlyMap<string, IssueEntity>>(new Map(), { equals: false });
  let previousItems: IssueExecutionItem[] = [];
  const items = createMemo(() => {
    const next = [...entities().values()].map(({ summary }) => summary);
    // Detail-only updates keep the same summary objects; a stable array prevents list effects from re-running.
    if (next.length === previousItems.length && next.every((item, index) => item === previousItems[index])) return previousItems;
    previousItems = next;
    return next;
  });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [refreshing, setRefreshing] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const latest = createLatestTask();
  let disposed = false;
  const cancel = () => {
    latest.cancel();
    setRefreshing(false);
  };
  const refresh = async () => {
    if (disposed) return;
    const request = latest.begin();
    setRefreshing(true);
    try {
      const values = await listIssues(request.signal);
      if (!request.isCurrent()) return;
      setEntities((previous) => {
        const next = new Map<string, IssueEntity>();
        for (const summary of values) {
          const detail = previous.get(summary.id)?.detail;
          next.set(summary.id, detail ? { summary, detail } : { summary });
        }
        return next;
      });
      setError("");
    } catch (cause) {
      if (request.isCurrent() && !request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
      request.finish();
    }
  };
  createEffect(scope, (active) => {
    if (active) void refresh();
    else cancel();
  });
  // Automatic samples never cancel slow reads. Explicit mutations/refreshes supersede older snapshots.
  const sample = () => {
    if (!document.hidden && scope() && !latest.active) void refresh();
  };
  const timer = window.setInterval(sample, 10_000);
  document.addEventListener("visibilitychange", sample);
  onCleanup(() => {
    disposed = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", sample);
    cancel();
  });
  const setDetail = (detail: IssueDetail) => {
    if (disposed) return;
    setEntities((previous) => {
      const next = new Map(previous);
      // Keep the list summary (and its ordering/createdAt) until the next list refresh.
      next.set(detail.id, { summary: previous.get(detail.id)?.summary ?? summaryFromDetail(detail), detail });
      return next;
    });
  };
  const clearDetail = (id: string) => {
    setEntities((previous) => {
      const entity = previous.get(id);
      if (!entity?.detail) return previous;
      const next = new Map(previous);
      next.set(id, { summary: entity.summary });
      return next;
    });
  };
  return {
    items,
    detail: (id: string) => entities().get(id)?.detail,
    setDetail,
    clearDetail,
    loading,
    refreshing,
    error,
    refresh,
    created(issue: IssueExecutionItem) {
      if (disposed) return;
      cancel();
      setEntities((previous) => {
        const next = new Map<string, IssueEntity>();
        const detail = previous.get(issue.id)?.detail;
        next.set(issue.id, detail ? { summary: issue, detail } : { summary: issue });
        for (const [id, entity] of previous) if (id !== issue.id) next.set(id, entity);
        return next;
      });
      void refresh();
    },
  };
}

export type IssueListResource = ReturnType<typeof createIssueList>;
