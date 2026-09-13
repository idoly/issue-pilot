import { createSignal } from "solid-js";

import type { IssueListItem } from "../data/client";
import { Dashboard } from "./Dashboard";
import { Statistics } from "./Statistics";

export function OverviewView(props: { onSelectIssue: (issueKey: string) => void }) {
  const [issues, setIssues] = createSignal<IssueListItem[]>([], { ownedWrite: true });
  return (
    <main class="overview-view">
      <Dashboard onSelectIssue={props.onSelectIssue} onIssues={setIssues} />
      <Statistics issues={issues()} />
    </main>
  );
}
