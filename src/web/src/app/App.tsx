import { ConfigProvider, Layout, Segmented, Select, Skeleton, theme } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, lazy, Match, Show, Switch } from "solid-js";

import { getIssue, type IssueDetail } from "../data/client";
import { AgentPanel } from "./AgentPanel";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { ConfigurationView } from "./ConfigurationView";
import { IssueQueue } from "./IssueQueue";
import { IssueWorkspace } from "./IssueWorkspace";
import { Statistics } from "./Statistics";
import { UserManagement } from "./UserManagement";
import type { WorkbenchPartLayout } from "./CodeBrowser";
import "@idoly/ant-design-solid/styles.css";

const CodeBrowser = lazy(() => import("./CodeBrowser"));
type AppView = "issues" | "statistics" | "configuration" | "users";
const viewOptions: Array<{ value: AppView; label: string }> = [
  { value: "issues", label: "工单" },
  { value: "statistics", label: "统计" },
  { value: "configuration", label: "配置" },
  { value: "users", label: "用户" },
];
const appTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#176b5b",
    colorPrimaryHover: "#248171",
    colorPrimaryActive: "#105448",
    borderRadius: "6px",
    colorInfo: "#1677ff",
  },
};

function AgentWorkbench(props: { issue: IssueDetail; sourceAgentOpen: boolean; sourceExpanded: boolean; sourceDetailsOpen: boolean; onCloseSource: () => void; onLayout: (layout: WorkbenchPartLayout) => void; onPartVisibility: (agentOpen: boolean, detailsOpen?: boolean) => void; onRefresh: (issueKey: string) => Promise<IssueDetail>; onToggleAgent: () => void; onToggleDetails: () => void }) {
  return (
    <section class={`agent-workbench${props.sourceExpanded ? " source-open" : ""}`} aria-label={`${props.issue.id} 智能体工作区`}>
      <AgentPanel issue={props.issue} hidden={props.sourceExpanded && !props.sourceAgentOpen} onRefresh={props.onRefresh} />
      <Show when={props.sourceExpanded}><CodeBrowser issueKey={props.issue.id} development={props.issue.environmentKey === "dev"} agentOpen={props.sourceAgentOpen} detailsOpen={props.sourceDetailsOpen} onClose={props.onCloseSource} onLayout={props.onLayout} onPartVisibility={props.onPartVisibility} onToggleAgent={props.onToggleAgent} onToggleDetails={props.onToggleDetails} /></Show>
    </section>
  );
}

function CurrentUserIdentity() {
  const { currentUser, selectCurrentUser, people } = useApplicationResources();
  const name = () => currentUser()?.name || currentUser()?.subject || "本地用户";
  return (
    <div class="identity" title={`${name()} · ${currentUser()?.email ?? ""}`}>
      <span>{name().slice(0, 1)}</span>
      <Select
        aria-label="当前用户"
        size="small"
        value={currentUser()?.subject}
        options={people().map((user) => ({ value: user.subject, label: `${user.name} · ${user.email}` }))}
        labelRender={(selected) => people().find((user) => user.subject === selected.value)?.email ?? selected.label}
        popupMatchSelectWidth={320}
        onChange={(subject) => { if (typeof subject === "string") selectCurrentUser(subject); }}
      />
    </div>
  );
}

function ResourceBackedIssueQueue(props: { selectedId: string; refreshToken: number; hidden: boolean; onSelect: (id: string) => void }) {
  const { currentUser } = useApplicationResources();
  return <IssueQueue selectedId={props.selectedId} userSubject={currentUser()?.subject ?? ""} refreshToken={props.refreshToken} hidden={props.hidden} onSelect={props.onSelect} />;
}

export function App() {
  const [view, setView] = createSignal<AppView>("issues", { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal("", { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [sourceExpanded, setSourceExpanded] = createSignal(false, { ownedWrite: true });
  const [sourceAgentOpen, setSourceAgentOpen] = createSignal(true, { ownedWrite: true });
  const [sourceDetailsOpen, setSourceDetailsOpen] = createSignal(true, { ownedWrite: true });
  const [workbenchLayout, setWorkbenchLayout] = createSignal<WorkbenchPartLayout | null>(null, { ownedWrite: true });
  let selectionGeneration = 0;
  const issueRefreshes = new Map<string, number>();
  createEffect(
    () => selectedId(),
    (id) => {
      const currentGeneration = ++selectionGeneration;
      setSourceExpanded(false);
      setWorkbenchLayout(null);
      if (!id) {
        setIssue(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setIssueError("");
      void getIssue(id).then((value) => {
        if (currentGeneration === selectionGeneration) setIssue(value);
      }).catch((error) => {
        if (currentGeneration !== selectionGeneration) return;
        setIssue(null);
        setIssueError(error instanceof Error ? error.message : "工单加载失败");
      }).finally(() => {
        if (currentGeneration === selectionGeneration) setLoading(false);
      });
    },
  );
  const refreshIssue = async (issueKey: string, refreshQueue = false) => {
    const currentGeneration = selectionGeneration;
    const currentRefresh = (issueRefreshes.get(issueKey) ?? 0) + 1;
    issueRefreshes.set(issueKey, currentRefresh);
    if (refreshQueue) setIssueRefreshToken((value) => value + 1);
    const refreshed = await getIssue(issueKey);
    if (currentGeneration === selectionGeneration && issueRefreshes.get(issueKey) === currentRefresh && selectedId() === issueKey) {
      const statusChanged = issue()?.status !== refreshed.status;
      setIssue(refreshed);
      if (!refreshQueue && statusChanged) setIssueRefreshToken((value) => value + 1);
    }
    return refreshed;
  };
  const sourceLayoutStyle = createMemo(() => {
    const layout = workbenchLayout();
    if (!sourceExpanded() || !layout) return undefined;
    return [
      `--source-panel-x:${layout.panel.x}px`,
      `--source-panel-y:${layout.panel.y}px`,
      `--source-panel-width:${layout.panel.width}px`,
      `--source-panel-height:${layout.panel.height}px`,
      `--source-detail-x:${layout.auxiliary.x}px`,
      `--source-detail-y:${layout.auxiliary.y}px`,
      `--source-detail-width:${layout.auxiliary.width}px`,
      `--source-detail-height:${layout.auxiliary.height}px`,
      `--workbench-detail-bg:${layout.theme.background}`,
      `--workbench-detail-fg:${layout.theme.foreground}`,
      `--workbench-detail-muted:${layout.theme.mutedForeground}`,
      `--workbench-detail-border:${layout.theme.border}`,
      `--workbench-input-bg:${layout.theme.inputBackground}`,
      `--workbench-input-fg:${layout.theme.inputForeground}`,
      `--workbench-input-border:${layout.theme.inputBorder}`,
      `--workbench-focus-border:${layout.theme.focusBorder}`,
      `--workbench-button-bg:${layout.theme.buttonBackground}`,
      `--workbench-button-fg:${layout.theme.buttonForeground}`,
      `--workbench-button-hover-bg:${layout.theme.buttonHoverBackground}`,
      `--workbench-hover-bg:${layout.theme.hoverBackground}`,
    ].join(";");
  });
  return (
    <ConfigProvider theme={appTheme} button={{ autoInsertSpace: false }}>
      <ApplicationResourcesProvider>
      <Layout class="app-shell">
        <Layout.Header class="app-header">
          <div class="brand"><span>IP</span><strong>issue-pilot</strong></div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              size="small"
              value={view()}
              options={viewOptions}
              onChange={(value) => setView(value as AppView)}
            />
          </div>
          <CurrentUserIdentity />
        </Layout.Header>
        <Layout.Content class={`app-content${sourceExpanded() && view() === "issues" ? ` source-expanded${workbenchLayout() ? " workbench-ready" : ""}` : ""}`} style={sourceLayoutStyle()} onContextMenu={(event) => { if (sourceExpanded()) { event.preventDefault(); event.stopPropagation(); } }}>
          <Switch>
            <Match when={view() === "issues"}>
              <ResourceBackedIssueQueue selectedId={selectedId()} refreshToken={issueRefreshToken()} hidden={sourceExpanded()} onSelect={setSelectedId} />
              <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
                <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                  {(current) => (
                    <>
                      <AgentWorkbench issue={current()} sourceAgentOpen={sourceAgentOpen()} sourceExpanded={sourceExpanded()} sourceDetailsOpen={sourceDetailsOpen()} onCloseSource={() => setSourceExpanded(false)} onLayout={setWorkbenchLayout} onPartVisibility={(agentOpen, detailsOpen) => { setSourceAgentOpen(agentOpen); if (detailsOpen !== undefined) setSourceDetailsOpen(detailsOpen); }} onRefresh={refreshIssue} onToggleAgent={() => setSourceAgentOpen((open) => !open)} onToggleDetails={() => setSourceDetailsOpen((open) => !open)} />
                      <IssueWorkspace issue={current()} sourcePanel={sourceExpanded()} sourcePanelOpen={sourceDetailsOpen()} onOpenSource={() => {
                        setWorkbenchLayout(null);
                        setSourceAgentOpen(true);
                        setSourceDetailsOpen(typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 600px)").matches);
                        setSourceExpanded(true);
                      }} onUpdated={async () => { await refreshIssue(current().id, true); }} />
                    </>
                  )}
                </Show>
              </Show>
            </Match>
            <Match when={view() === "statistics"}><Statistics /></Match>
            <Match when={view() === "configuration"}><ConfigurationView /></Match>
            <Match when={view() === "users"}><UserManagement /></Match>
          </Switch>
        </Layout.Content>
      </Layout>
      </ApplicationResourcesProvider>
    </ConfigProvider>
  );
}
