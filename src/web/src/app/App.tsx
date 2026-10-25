import { Segmented, Select, Skeleton } from "../ui";
import { createEffect, createSignal, lazy, Match, onCleanup, Show, Switch } from "solid-js";

import { getIssue, type IssueDetail } from "../data/client";
import { DingtalkImportButton } from "./DingtalkImportDialog";
import { AgentPanel } from "./AgentPanel";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { SettingsView } from "./SettingsView";
import { OverviewView } from "./OverviewView";
import { IssueQueue } from "./IssueQueue";
import { IssueWorkspace } from "./IssueWorkspace";
import type { SourcePanel } from "./CodeBrowser";

const CodeBrowser = lazy(() => import("./CodeBrowser"));
type AppView = "dashboard" | "issues" | "configuration";
const viewOptions: Array<{ value: AppView; label: string }> = [
  { value: "dashboard", label: "首页" },
  { value: "issues", label: "工单" },
  { value: "configuration", label: "配置" },
];

function AgentWorkspace(props: { issue: IssueDetail; sourceAgentOpen: boolean; sourceExpanded: boolean; sourceDetailsOpen: boolean; onCloseSource: () => void; onRefresh: (issueKey: string) => Promise<IssueDetail>; onToggleAgent: () => void; onToggleDetails: () => void; onDirtyChange: (dirty: boolean) => void; onResize: (panel: SourcePanel, size: number) => void }) {
  return (
    <section class={`agent-workspace${props.sourceExpanded ? " source-open" : ""}${props.sourceExpanded && !props.sourceAgentOpen ? " agent-closed" : ""}`} aria-label={`${props.issue.id} 智能体工作区`}>
      <AgentPanel issue={props.issue} hidden={props.sourceExpanded && !props.sourceAgentOpen} onRefresh={props.onRefresh} />
      <Show when={props.sourceExpanded}><CodeBrowser issueKey={props.issue.id} repositoryVersion={JSON.stringify([props.issue.environmentKey, props.issue.status, props.issue.workspace.status, props.issue.workspace.sourceAvailable, props.issue.repositories])} contentVersion={props.issue.updatedAt} development={props.issue.environmentKey === "dev"} agentOpen={props.sourceAgentOpen} detailsOpen={props.sourceDetailsOpen} onClose={props.onCloseSource} onToggleAgent={props.onToggleAgent} onToggleDetails={props.onToggleDetails} onDirtyChange={props.onDirtyChange} onResize={props.onResize} /></Show>
    </section>
  );
}

function CurrentUserIdentity(props: { mayChange: () => boolean }) {
  const { currentUser, selectCurrentUser, people } = useApplicationResources();
  const name = () => currentUser()?.name || currentUser()?.subject || "本地用户";
  return (
    <div class="identity" title={`${name()} · ${currentUser()?.email ?? ""}`}>
      <span>{name().slice(0, 1)}</span>
      <Select
        aria-label="当前用户"
        value={currentUser()?.subject}
        options={people().map((user) => ({ value: user.subject, label: `${user.name} · ${user.email}` }))}
        labelRender={(selected) => people().find((user) => user.subject === selected.value)?.email ?? selected.label}
        popupMatchSelectWidth={320}
        onChange={(subject) => { if (typeof subject === "string" && subject !== currentUser()?.subject && props.mayChange()) selectCurrentUser(subject); }}
      />
    </div>
  );
}

function ResourceBackedIssueQueue(props: { selectedId: string; refreshToken: number; hidden: boolean; keepExternalSelection: boolean; onSelect: (id: string) => void }) {
  const { currentUser } = useApplicationResources();
  return <IssueQueue selectedId={props.selectedId} userSubject={currentUser()?.subject ?? ""} refreshToken={props.refreshToken} hidden={props.hidden} keepExternalSelection={props.keepExternalSelection} onSelect={props.onSelect} />;
}

function ResourceBackedOverview(props: { onSelectIssue: (issueKey: string) => void }) {
  const { people, selectCurrentUser, refreshPeople } = useApplicationResources();
  let generation = 0, disposed = false;
  onCleanup(() => { disposed = true; generation++; });
  const open = async (issueKey: string, subject?: string) => {
    const owner = ++generation;
    if (subject && !people().some(user => user.subject === subject)) {
      try { await refreshPeople(); } catch { /* the Issue can still open with the current user */ }
    }
    if (disposed || owner !== generation) return;
    if (subject) selectCurrentUser(subject);
    props.onSelectIssue(issueKey);
  };
  return <OverviewView onSelectIssue={(issueKey, subject) => { void open(issueKey, subject); }} />;
}

function linkedIssueFromUrl(): string {
  const key = new URLSearchParams(window.location.search).get("issue") ?? "";
  return /^ISSUE-\d{8}-\d{3,}$/i.test(key) ? key.toUpperCase() : "";
}

export function App(props: { initialView?: AppView } = {}) {
  const linkedIssue = linkedIssueFromUrl();
  const [view, setView] = createSignal<AppView>(props.initialView ?? (linkedIssue ? "issues" : "dashboard"), { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal(linkedIssue, { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [keepExternalSelection, setKeepExternalSelection] = createSignal(Boolean(linkedIssue), { ownedWrite: true });
  const [dashboardTarget, setDashboardTarget] = createSignal(linkedIssue, { ownedWrite: true });
  const [sourceExpanded, setSourceExpanded] = createSignal(false, { ownedWrite: true });
  const [sourceAgentOpen, setSourceAgentOpen] = createSignal(true, { ownedWrite: true });
  const [sourceDetailsOpen, setSourceDetailsOpen] = createSignal(true, { ownedWrite: true });
  const [sourceDirty, setSourceDirty] = createSignal(false, { ownedWrite: true });
  const [sourceSizes, setSourceSizes] = createSignal<Partial<Record<SourcePanel, number>>>({}, { ownedWrite: true });
  const mayNavigate = () => !sourceExpanded() || !sourceDirty() || window.confirm("文件有未保存修改，是否放弃这些修改？");
  const initialNavigationIndex: unknown = window.history.state?.issuePilotNavigationIndex;
  let navigationIndex = typeof initialNavigationIndex === "number" && Number.isSafeInteger(initialNavigationIndex) ? initialNavigationIndex : 0;
  let acceptedUrl = window.location.href;
  let restoringHistory = false;
  const onHistoryNavigation = (event: PopStateEvent) => {
    if (restoringHistory) { restoringHistory = false; return; }
    const nextIndex: unknown = event.state?.issuePilotNavigationIndex;
    if (!mayNavigate()) {
      if (typeof nextIndex === "number" && Number.isSafeInteger(nextIndex) && nextIndex !== navigationIndex) {
        restoringHistory = true;
        window.history.go(navigationIndex - nextIndex);
      } else window.history.pushState({ ...window.history.state, issuePilotNavigationIndex: navigationIndex }, "", acceptedUrl);
      return;
    }
    if (typeof nextIndex === "number" && Number.isSafeInteger(nextIndex)) navigationIndex = nextIndex;
    const key = linkedIssueFromUrl();
    setSourceExpanded(false);
    setSourceDirty(false);
    setKeepExternalSelection(Boolean(key));
    setDashboardTarget(key);
    setSelectedId(key);
    setView(key ? "issues" : event.state?.issuePilotView === "configuration" ? "configuration" : "dashboard");
  };
  window.addEventListener("popstate", onHistoryNavigation);
  onCleanup(() => window.removeEventListener("popstate", onHistoryNavigation));
  let issueWorkspace: HTMLElement | undefined;
  let selectionGeneration = 0;
  const issueRefreshes = new Map<string, number>();
  createEffect(
    () => selectedId(),
    (id) => {
      const currentGeneration = ++selectionGeneration;
      setSourceExpanded(false);
      setSourceDirty(false);
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
  createEffect(() => ({ id: selectedId(), currentView: view() }), ({ id, currentView }) => {
    const url = new URL(window.location.href);
    url.pathname = "/";
    if (currentView === "issues" && id) url.searchParams.set("issue", id);
    else url.searchParams.delete("issue");
    window.history.replaceState({ ...window.history.state, issuePilotNavigationIndex: navigationIndex, issuePilotView: currentView }, "", url);
    acceptedUrl = url.href;
  });
  createEffect(() => ({ current: issue()?.id, target: dashboardTarget(), currentView: view() }), ({ current, target, currentView }) => {
    if (!target || current !== target || currentView !== "issues") return;
    setDashboardTarget("");
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches) {
      window.requestAnimationFrame(() => issueWorkspace?.scrollIntoView({ block: "start" }));
    }
  });
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
  return (
      <ApplicationResourcesProvider>
      <div class="app-shell">
        <a class="skip-link" href="#app-content" onClick={event => { event.preventDefault(); document.getElementById("app-content")?.focus({ preventScroll: true }); }}>跳到主要内容</a>
        <header class="app-header">
          <div class="brand"><span>IP</span><strong>issue-pilot</strong></div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              value={view()}
              options={viewOptions}
              onChange={(value) => { if (value !== view() && mayNavigate()) { setSourceDirty(false); setView(value as AppView); } }}
            />
            <DingtalkImportButton onCreated={() => setIssueRefreshToken(value => value + 1)} onOpenIssue={key => {
              if (!mayNavigate()) return false;
              setKeepExternalSelection(true); setDashboardTarget(key); setSelectedId(key); setView("issues");
              return true;
            }} />
          </div>
          <CurrentUserIdentity mayChange={() => { if (!mayNavigate()) return false; setSourceExpanded(false); setSourceDirty(false); return true; }} />
        </header>
        <div id="app-content" tabindex={-1} class={`app-content${sourceExpanded() && view() === "issues" ? ` source-expanded${sourceDetailsOpen() ? "" : " details-hidden"}` : ""}`} style={{ "--source-navigation-user-width": sourceSizes().navigation === undefined ? undefined : `${sourceSizes().navigation}px`, "--source-details-user-width": sourceSizes().details === undefined ? undefined : `${sourceSizes().details}px`, "--source-agent-user-height": sourceSizes().agent === undefined ? undefined : `${sourceSizes().agent}px` }}>
          <Switch>
            <Match when={view() === "dashboard"}><ResourceBackedOverview onSelectIssue={(issueKey) => { setKeepExternalSelection(true); setDashboardTarget(issueKey); setSelectedId(issueKey); setView("issues"); }} /></Match>
            <Match when={view() === "issues"}>
              <ResourceBackedIssueQueue selectedId={selectedId()} refreshToken={issueRefreshToken()} hidden={sourceExpanded()} keepExternalSelection={keepExternalSelection()} onSelect={(issueKey) => { setDashboardTarget(""); setKeepExternalSelection(false); setSelectedId(issueKey); }} />
              <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
                <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                  {(current) => (
                    <>
                      <AgentWorkspace issue={current()} sourceAgentOpen={sourceAgentOpen()} sourceExpanded={sourceExpanded()} sourceDetailsOpen={sourceDetailsOpen()} onCloseSource={() => { setSourceExpanded(false); setSourceDirty(false); }} onDirtyChange={setSourceDirty} onResize={(panel, size) => setSourceSizes(current => ({ ...current, [panel]: size }))} onRefresh={refreshIssue} onToggleAgent={() => setSourceAgentOpen((open) => !open)} onToggleDetails={() => setSourceDetailsOpen((open) => !open)} />
                      <IssueWorkspace issue={current()} elementRef={(element) => { issueWorkspace = element; }} sourcePanel={sourceExpanded()} sourcePanelOpen={sourceDetailsOpen()} onOpenSource={() => {
                        setSourceAgentOpen(true);
                        setSourceDetailsOpen(typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 699px)").matches);
                        setSourceExpanded(true);
                      }} onOpenIssue={(issueKey) => {
                        if (issueKey === selectedId() || !mayNavigate()) return;
                        const url = new URL(`/?issue=${encodeURIComponent(issueKey)}`, window.location.origin);
                        window.history.pushState({ ...window.history.state, issuePilotNavigationIndex: ++navigationIndex, issuePilotView: "issues" }, "", url);
                        setKeepExternalSelection(true);
                        setDashboardTarget(issueKey);
                        setSelectedId(issueKey);
                        setView("issues");
                      }} onUpdated={async () => { await refreshIssue(current().id, true); }} onCreatedFollowUp={(issueKey) => {
                        setIssueRefreshToken((value) => value + 1);
                        if (!mayNavigate()) return;
                        setKeepExternalSelection(false);
                        setSelectedId(issueKey);
                      }} />
                    </>
                  )}
                </Show>
              </Show>
            </Match>
            <Match when={view() === "configuration"}><SettingsView /></Match>
          </Switch>
        </div>
      </div>
      </ApplicationResourcesProvider>
  );
}
