import { Dashboard } from "./Dashboard";
import { Statistics } from "./Statistics";
import type { IssueListResource } from "./issue-list";

export function OverviewView(props: { issues: IssueListResource; onSelectIssue: (issueKey: string, userSubject?: string) => void }) {
  return (
    <main class="overview-view" aria-label="首页">
      <Dashboard
        issues={props.issues.items()}
        loading={props.issues.loading()}
        loadError={props.issues.error()}
        refreshing={props.issues.refreshing()}
        onRefresh={props.issues.refresh}
        onSelectIssue={props.onSelectIssue}
      />
      <Statistics issues={props.issues.items()} />
    </main>
  );
}
