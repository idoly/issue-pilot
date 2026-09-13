import { createSignal, onCleanup } from "solid-js";

import { listIssues, type IssueExecutionItem } from "../data/client";
import { Dashboard } from "./Dashboard";
import { Statistics } from "./Statistics";

const refreshIntervalMs = 10_000;

export function OverviewView(props: { onSelectIssue: (issueKey: string) => void }) {
  const [issues, setIssues] = createSignal<IssueExecutionItem[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  const [refreshing, setRefreshing] = createSignal(false, { ownedWrite: true });
  let requestGeneration = 0;
  let requestController: AbortController | undefined;

  const refresh = () => {
    const generation = ++requestGeneration;
    requestController?.abort();
    requestController = new AbortController();
    setRefreshing(true);
    void listIssues(requestController.signal).then((value) => {
      if (generation !== requestGeneration) return;
      setIssues(value);
      setLoadError("");
    }).catch((error) => {
      if (generation !== requestGeneration || requestController?.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "首页数据加载失败");
    }).finally(() => {
      if (generation === requestGeneration) {
        setLoading(false);
        setRefreshing(false);
      }
    });
  };

  refresh();
  const refreshTimer = window.setInterval(refresh, refreshIntervalMs);
  onCleanup(() => {
    window.clearInterval(refreshTimer);
    requestGeneration += 1;
    requestController?.abort();
  });

  return (
    <main class="overview-view">
      <Dashboard issues={issues()} loading={loading()} loadError={loadError()} refreshing={refreshing()} onRefresh={refresh} onSelectIssue={props.onSelectIssue} />
      <Statistics issues={issues()} />
    </main>
  );
}
