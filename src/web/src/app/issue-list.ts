import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { errorMessage, listIssues, type IssueExecutionItem } from "../data/client";

/** One application-owned snapshot for the queue, overview and statistics. */
export function createIssueList(scope: Accessor<string | false> = () => "issues") {
  const [items, setItems] = createSignal<IssueExecutionItem[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [refreshing, setRefreshing] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  const cancel = () => {
    generation++;
    controller?.abort();
    controller = undefined;
    setRefreshing(false);
  };
  const refresh = async () => {
    if (disposed) return;
    cancel();
    const owner = generation;
    const request = new AbortController();
    controller = request;
    setRefreshing(true);
    try {
      const values = await listIssues(request.signal);
      if (owner !== generation) return;
      setItems(values);
      setError("");
    } catch (cause) {
      if (owner === generation && !request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (owner === generation) {
        controller = undefined;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };
  createEffect(scope, (active) => {
    if (active) void refresh();
    else cancel();
  });
  // Automatic samples never cancel slow reads. Explicit mutations/refreshes supersede older snapshots.
  const sample = () => {
    if (!document.hidden && scope() && !controller) void refresh();
  };
  const timer = window.setInterval(sample, 10_000);
  document.addEventListener("visibilitychange", sample);
  onCleanup(() => {
    disposed = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", sample);
    cancel();
  });
  return {
    items,
    loading,
    refreshing,
    error,
    refresh,
    created(issue: IssueExecutionItem) {
      if (disposed) return;
      cancel();
      setItems((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      void refresh();
    },
  };
}

export type IssueListResource = ReturnType<typeof createIssueList>;
