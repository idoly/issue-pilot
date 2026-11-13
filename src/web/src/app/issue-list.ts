import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { errorMessage, listIssues, type IssueDetail, type IssueExecutionItem } from "../data/client";
import { createLatestTask } from "../data/latest";

interface IssueEntity {
  summary: IssueExecutionItem;
  summaryRead: number;
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
  let nextRead = 0;
  const [listVersion, setListVersion] = createSignal(0, { ownedWrite: true });
  let disposed = false;
  const cancel = () => {
    latest.cancel();
    setRefreshing(false);
  };
  const refresh = async () => {
    if (disposed) return;
    const request = latest.begin();
    const read = ++nextRead;
    setRefreshing(true);
    try {
      const values = await listIssues(request.signal);
      if (!request.isCurrent()) return;
      setEntities((previous) => {
        const next = new Map<string, IssueEntity>();
        for (const summary of values) {
          const entity = previous.get(summary.id);
          next.set(summary.id, entity && entity.summaryRead > read ? entity : { summary, summaryRead: read, detail: entity?.detail });
        }
        return next;
      });
      setListVersion(read);
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
  const clearDetail = (id: string) => {
    setEntities((previous) => {
      const entity = previous.get(id);
      if (!entity?.detail) return previous;
      const next = new Map(previous);
      next.set(id, { summary: entity.summary, summaryRead: entity.summaryRead });
      return next;
    });
  };
  return {
    items,
    listVersion,
    detail: (id: string) => entities().get(id)?.detail,
    beginDetailRead() {
      const read = ++nextRead;
      return {
        hasNewerList: () => listVersion() > read,
        publish(detail: IssueDetail) {
          if (disposed) return;
          const newerList = listVersion() > read;
          setEntities((previous) => {
            const entity = previous.get(detail.id);
            if (!entity && newerList) return previous;
            const next = new Map(previous);
            // Both projections contain these fields. An earlier request may not roll back a later read.
            if (entity && entity.summaryRead > read) next.set(detail.id, { ...entity, detail });
            else {
              const summary = summaryFromDetail(detail);
              if (!summary.createdAt && entity?.summary.createdAt) summary.createdAt = entity.summary.createdAt;
              next.set(detail.id, { summary, summaryRead: read, detail });
            }
            return next;
          });
        },
      };
    },
    clearDetail,
    loading,
    refreshing,
    error,
    refresh,
    created(issue: IssueExecutionItem) {
      if (disposed) return;
      cancel();
      const read = ++nextRead;
      setEntities((previous) => {
        const next = new Map<string, IssueEntity>();
        const detail = previous.get(issue.id)?.detail;
        next.set(issue.id, { summary: issue, summaryRead: read, detail });
        for (const [id, entity] of previous) if (id !== issue.id) next.set(id, entity);
        return next;
      });
      void refresh();
    },
  };
}

export type IssueListResource = ReturnType<typeof createIssueList>;
