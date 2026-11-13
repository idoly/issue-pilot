import { Button, Segmented, Select, Skeleton } from "../ui";
import { createEffect, createSignal, lazy, Loading, Match, onCleanup, Show, Switch, untrack } from "solid-js";

import { getIssue, type IssueDetail, type IssueExecutionItem } from "../data/client";
import { createLatestTask } from "../data/latest";
import { parseIssueKey } from "../../../domain/contracts";
import { DingtalkImportButton } from "./DingtalkImportDialog";
import { AgentPanel } from "./AgentPanel";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { OverviewView } from "./OverviewView";
import { IssueSearchDialog } from "./IssueSearchDialog";
import { IssueQueue } from "./IssueQueue";
import { IssueWorkspace } from "./IssueWorkspace";
import type { SourcePanel } from "./CodeBrowser";

import { createIssueList } from "./issue-list";

function summaryChanged(detail: IssueDetail | IssueExecutionItem, summary: IssueExecutionItem): boolean {
  // The server revision covers Issue, Workspace and Agent state in one token.
  if (detail.revision && summary.revision) return detail.revision !== summary.revision;
  // Partial fixtures and older projections without a revision keep the explicit field comparison.
  const fields = ["title", "priority", "type", "status", "assignee", "assigneeSubject", "environmentKey", "updatedAt"] as const;
  return (
    fields.some((field) => detail[field] !== summary[field]) ||
    detail.service.key !== summary.service.key ||
    detail.service.name !== summary.service.name ||
    ("workspace" in detail ? detail.workspace.status : detail.workspaceStatus) !== summary.workspaceStatus ||
    Boolean(detail.agentRunning) !== summary.agentRunning
  );
}

const CodeBrowser = lazy(() => import("./CodeBrowser"));
const SettingsView = lazy(() => import("./SettingsView"), { export: "SettingsView" });
type AppView = "dashboard" | "issues" | "configuration";
const viewOptions: Array<{ value: AppView; label: string }> = [
  { value: "dashboard", label: "首页" },
  { value: "issues", label: "工单" },
  { value: "configuration", label: "配置" },
];

function AgentWorkspace(props: {
  issue: IssueDetail;
  refreshError: string;
  sourceAgentOpen: boolean;
  sourceExpanded: boolean;
  sourceDetailsOpen: boolean;
  onCloseSource: () => void;
  onRefresh: (issueKey: string) => Promise<unknown>;
  onToggleAgent: () => void;
  onToggleDetails: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onResize: (panel: SourcePanel, size: number) => void;
}) {
  const { agentDrafts, currentUser } = useApplicationResources();
  return (
    <section
      class={`agent-workspace${props.sourceExpanded ? " source-open" : ""}${props.sourceExpanded && !props.sourceAgentOpen ? " agent-closed" : ""}`}
      aria-label={`${props.issue.id} 智能体工作区`}
    >
      <Show when={props.refreshError}>
        <div class="workspace-error" role="alert">
          工单详情刷新失败：{props.refreshError}
        </div>
      </Show>
      <AgentPanel issue={props.issue} drafts={agentDrafts} hidden={props.sourceExpanded && !props.sourceAgentOpen} onRefresh={props.onRefresh} userSubject={currentUser()?.subject} />
      <Show when={props.sourceExpanded}>
        <CodeBrowser
          issueKey={props.issue.id}
          repositoryVersion={JSON.stringify([props.issue.environmentKey, props.issue.status, props.issue.workspace.status, props.issue.workspace.sourceAvailable, props.issue.repositories])}
          contentVersion={props.issue.updatedAt}
          development={props.issue.environmentKey === "dev"}
          agentOpen={props.sourceAgentOpen}
          detailsOpen={props.sourceDetailsOpen}
          onClose={props.onCloseSource}
          onToggleAgent={props.onToggleAgent}
          onToggleDetails={props.onToggleDetails}
          onDirtyChange={props.onDirtyChange}
          onResize={props.onResize}
        />
      </Show>
    </section>
  );
}

function CurrentUserIdentity(props: { onChange: (subject: string) => void }) {
  const { currentUser, people } = useApplicationResources();
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
        onChange={(subject) => {
          if (typeof subject === "string" && subject !== currentUser()?.subject) props.onChange(subject);
        }}
      />
    </div>
  );
}

function linkedIssueFromUrl(): string {
  return parseIssueKey(new URLSearchParams(window.location.search).get("issue") ?? "") ?? "";
}

export function App(props: { initialView?: AppView } = {}) {
  return (
    <ApplicationResourcesProvider>
      <AppWorkspace initialView={props.initialView} />
    </ApplicationResourcesProvider>
  );
}

function AppWorkspace(props: { initialView?: AppView }) {
  const { currentUser, people, refreshPeople, selectCurrentUser, agentDrafts } = useApplicationResources();
  const linkedIssue = linkedIssueFromUrl();
  const [view, setView] = createSignal<AppView>(props.initialView ?? (linkedIssue ? "issues" : "dashboard"), { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal(linkedIssue, { ownedWrite: true });
  const issueList = createIssueList(() => (view() === "configuration" ? false : view()));
  const issue = () => {
    const id = selectedId();
    return id ? (issueList.detail(id) ?? null) : null;
  };
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueReloadToken, setIssueReloadToken] = createSignal(0, { ownedWrite: true });
  const [keepExternalSelection, setKeepExternalSelection] = createSignal(Boolean(linkedIssue), { ownedWrite: true });
  const [queueReveal, setQueueReveal] = createSignal<{ key: string; subject: string } | undefined>(undefined, { ownedWrite: true });
  const [dashboardTarget, setDashboardTarget] = createSignal(linkedIssue, { ownedWrite: true });
  const [sourceExpanded, setSourceExpanded] = createSignal(false, { ownedWrite: true });
  const [sourceAgentOpen, setSourceAgentOpen] = createSignal(true, { ownedWrite: true });
  const [sourceDetailsOpen, setSourceDetailsOpen] = createSignal(true, { ownedWrite: true });
  const [sourceDirty, setSourceDirty] = createSignal(false, { ownedWrite: true });
  const [issueEditDirty, setIssueEditDirty] = createSignal(false, { ownedWrite: true });
  const [sourceSizes, setSourceSizes] = createSignal<Partial<Record<SourcePanel, number>>>({}, { ownedWrite: true });
  const mayNavigate = () => {
    const dirty = (sourceExpanded() && sourceDirty()) || issueEditDirty();
    return !dirty || window.confirm("有未保存的修改，是否放弃这些修改？");
  };
  const maySwitchUser = (subject: string) => subject === currentUser()?.subject || !agentDrafts.hasPending() || window.confirm("切换用户会清除当前用户的 Agent 草稿和未确认的发送记录。是否切换？");
  const initialNavigationIndex: unknown = window.history.state?.issuePilotNavigationIndex;
  let navigationIndex = typeof initialNavigationIndex === "number" && Number.isSafeInteger(initialNavigationIndex) ? initialNavigationIndex : 0;
  let acceptedUrl = window.location.href;
  let restoringHistory = false;
  let assigneeNavigation: { key: string; subject: string | undefined } | undefined;
  const onHistoryNavigation = (event: PopStateEvent) => {
    if (restoringHistory) {
      restoringHistory = false;
      return;
    }
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
    assigneeNavigation = undefined;
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
  const detailTask = createLatestTask();
  onCleanup(detailTask.cancel);
  const readDetail = async (id: string, kind: "selection" | "update" | "sample") => {
    if (untrack(selectedId) !== id || untrack(view) !== "issues") return;
    if (kind === "update") void issueList.refresh();
    const request = detailTask.begin();
    const read = issueList.beginDetailRead();
    const navigation = assigneeNavigation;
    const isCurrent = () => request.isCurrent() && untrack(selectedId) === id && untrack(view) === "issues";
    let published = false;
    try {
      const detail = await getIssue(id, request.signal);
      if (!isCurrent()) return;
      const assignee = detail.assigneeSubject;
      if (navigation && assignee) {
        const canFollow = () => isCurrent() && assigneeNavigation === navigation && (navigation.subject === undefined || currentUser()?.subject === navigation.subject);
        const knowsAssignee = () => people().some((person) => person.subject === assignee);
        if (canFollow() && !knowsAssignee()) await refreshPeople().catch(() => undefined);
        if (canFollow() && knowsAssignee() && maySwitchUser(assignee)) {
          if (assignee !== currentUser()?.subject) selectCurrentUser(assignee);
          setQueueReveal({ key: id, subject: assignee });
        }
      }
      if (!isCurrent()) return;
      read.publish(detail);
      setIssueError("");
      published = true;
    } catch (error) {
      if (!isCurrent()) return;
      if (kind === "selection") issueList.clearDetail(id);
      setIssueError(error instanceof Error ? error.message : "工单加载失败");
      throw error;
    } finally {
      const current = isCurrent();
      request.finish();
      if (current) {
        if (assigneeNavigation === navigation) assigneeNavigation = undefined;
        setLoading(false);
        if (published && read.hasNewerList()) refreshSampledDetail();
      }
    }
  };
  const refreshIssue = (id: string) => readDetail(id, "update");
  function refreshSampledDetail() {
    const current = untrack(issue);
    if (untrack(view) !== "issues" || untrack(loading) || !current || detailTask.active) return;
    const summaries = new Map(untrack(issueList.items).map((item) => [item.id, item]));
    const changed = [current, ...(current.relatedIssues ?? [])].some((detail) => {
      const summary = summaries.get(detail.id);
      return !summary || summaryChanged(detail, summary);
    });
    if (untrack(issueError) || changed) void readDetail(current.id, "sample").catch(() => undefined);
  }
  createEffect(issueList.listVersion, refreshSampledDetail);
  createEffect(
    () => ({ id: selectedId(), reload: issueReloadToken(), active: view() === "issues" }),
    ({ id, active }) => {
      detailTask.cancel();
      setQueueReveal(undefined);
      if (!active || assigneeNavigation?.key !== id) assigneeNavigation = undefined;
      if (!active) return;
      setSourceExpanded(false);
      setSourceDirty(false);
      if (!id) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setIssueError("");
      void readDetail(id, "selection").catch(() => undefined);
    },
  );
  createEffect(
    () => ({ id: selectedId(), currentView: view() }),
    ({ id, currentView }) => {
      const url = new URL(window.location.href);
      url.pathname = "/";
      if (currentView === "issues" && id) url.searchParams.set("issue", id);
      else url.searchParams.delete("issue");
      window.history.replaceState({ ...window.history.state, issuePilotNavigationIndex: navigationIndex, issuePilotView: currentView }, "", url);
      acceptedUrl = url.href;
    },
  );
  createEffect(
    () => ({ current: issue()?.id, target: dashboardTarget(), currentView: view() }),
    ({ current, target, currentView }) => {
      if (!target || current !== target || currentView !== "issues") return;
      setDashboardTarget("");
      if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches) {
        window.requestAnimationFrame(() => issueWorkspace?.scrollIntoView({ block: "start" }));
      }
    },
  );
  const openIssueLink = (key: string, followAssignee = false) => {
    if (!mayNavigate()) return false;
    assigneeNavigation = followAssignee ? { key, subject: currentUser()?.subject } : undefined;
    if (view() === "issues" && selectedId() === key) {
      if (followAssignee) setKeepExternalSelection(true);
      if (followAssignee || !issue() || issueError()) setIssueReloadToken((value) => value + 1);
      return true;
    }
    const url = new URL(`/?issue=${encodeURIComponent(key)}`, window.location.origin);
    window.history.pushState({ ...window.history.state, issuePilotNavigationIndex: ++navigationIndex, issuePilotView: "issues" }, "", url);
    setSourceDirty(false);
    setIssueEditDirty(false);
    setKeepExternalSelection(true);
    setDashboardTarget(key);
    setSelectedId(key);
    setView("issues");
    return true;
  };
  return (
    <>
      <IssueSearchDialog onOpenIssue={(key) => openIssueLink(key, true)} />
      <div class="app-shell">
        <a
          class="skip-link"
          href="#app-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("app-content")?.focus({ preventScroll: true });
          }}
        >
          跳到主要内容
        </a>
        <header class="app-header">
          <div class="brand">
            <span>IP</span>
            <strong>issue-pilot</strong>
          </div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              value={view()}
              options={viewOptions}
              onChange={(value) => {
                if (value !== view() && mayNavigate()) {
                  setSourceDirty(false);
                  setView(value as AppView);
                }
              }}
            />
            <DingtalkImportButton
              onCreated={() => void issueList.refresh()}
              onOpenIssue={(key) => {
                if (!mayNavigate()) return false;
                setKeepExternalSelection(true);
                setDashboardTarget(key);
                setSelectedId(key);
                setView("issues");
                return true;
              }}
            />
          </div>
          <CurrentUserIdentity
            onChange={(subject) => {
              if (!mayNavigate() || !maySwitchUser(subject)) return;
              assigneeNavigation = undefined;
              setQueueReveal(undefined);
              setSourceExpanded(false);
              setSourceDirty(false);
              selectCurrentUser(subject);
            }}
          />
        </header>
        <div
          id="app-content"
          tabindex={-1}
          class={`app-content${sourceExpanded() && view() === "issues" ? ` source-expanded${sourceDetailsOpen() ? "" : " details-hidden"}` : ""}`}
          style={{
            "--source-navigation-user-width": sourceSizes().navigation === undefined ? undefined : `${sourceSizes().navigation}px`,
            "--source-details-user-width": sourceSizes().details === undefined ? undefined : `${sourceSizes().details}px`,
            "--source-agent-user-height": sourceSizes().agent === undefined ? undefined : `${sourceSizes().agent}px`,
          }}
        >
          <Switch>
            <Match when={view() === "dashboard"}>
              <OverviewView issues={issueList} onSelectIssue={(key) => openIssueLink(key, true)} />
            </Match>
            <Match when={view() === "issues"}>
              <IssueQueue
                selectedId={selectedId()}
                userSubject={currentUser()?.subject ?? ""}
                issueList={issueList}
                hidden={sourceExpanded()}
                keepExternalSelection={keepExternalSelection()}
                reveal={queueReveal()}
                onSelect={(issueKey) => {
                  if (!untrack(mayNavigate)) return;
                  if (issueKey === untrack(selectedId)) {
                    // Re-selecting a failed Issue retries its detail load.
                    if (!untrack(issue) || untrack(issueError)) setIssueReloadToken((value) => value + 1);
                    return;
                  }
                  const url = new URL(`/?issue=${encodeURIComponent(issueKey)}`, window.location.origin);
                  window.history.pushState({ ...window.history.state, issuePilotNavigationIndex: ++navigationIndex, issuePilotView: "issues" }, "", url);
                  setSourceDirty(false);
                  setIssueEditDirty(false);
                  setDashboardTarget("");
                  setKeepExternalSelection(false);
                  setSelectedId(issueKey);
                }}
              />
              <Show
                when={!loading()}
                fallback={
                  <main class="issue-loading" aria-busy="true">
                    <Skeleton active paragraph={{ rows: 12 }} />
                  </main>
                }
              >
                <Show
                  when={issue()}
                  fallback={
                    <main class="issue-empty" role={issueError() ? "alert" : undefined}>
                      <strong>{issueError() || "暂无工单"}</strong>
                      <Show when={issueError() && selectedId()}>
                        <Button
                          size="small"
                          onClick={() => {
                            setIssueError("");
                            setIssueReloadToken((value) => value + 1);
                          }}
                        >
                          重试
                        </Button>
                      </Show>
                    </main>
                  }
                >
                  {(current) => (
                    <>
                      <AgentWorkspace
                        refreshError={issueError()}
                        issue={current()}
                        sourceAgentOpen={sourceAgentOpen()}
                        sourceExpanded={sourceExpanded()}
                        sourceDetailsOpen={sourceDetailsOpen()}
                        onCloseSource={() => {
                          setSourceExpanded(false);
                          setSourceDirty(false);
                        }}
                        onDirtyChange={setSourceDirty}
                        onResize={(panel, size) => setSourceSizes((current) => ({ ...current, [panel]: size }))}
                        onRefresh={refreshIssue}
                        onToggleAgent={() => setSourceAgentOpen((open) => !open)}
                        onToggleDetails={() => setSourceDetailsOpen((open) => !open)}
                      />
                      <IssueWorkspace
                        issue={current()}
                        onEditDirtyChange={setIssueEditDirty}
                        elementRef={(element) => {
                          issueWorkspace = element;
                        }}
                        sourcePanel={sourceExpanded()}
                        sourcePanelOpen={sourceDetailsOpen()}
                        onOpenSource={() => {
                          setSourceAgentOpen(true);
                          setSourceDetailsOpen(typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 699px)").matches);
                          setSourceExpanded(true);
                        }}
                        onOpenIssue={openIssueLink}
                        onUpdated={async () => {
                          await refreshIssue(current().id);
                        }}
                        onCreatedFollowUp={(issueKey) => {
                          void issueList.refresh();
                          if (!mayNavigate()) return;
                          setKeepExternalSelection(false);
                          setSelectedId(issueKey);
                        }}
                      />
                    </>
                  )}
                </Show>
              </Show>
            </Match>
            <Match when={view() === "configuration"}>
              <Loading
                fallback={
                  <main class="settings-view" role="status">
                    正在加载配置…
                  </main>
                }
              >
                <SettingsView />
              </Loading>
            </Match>
          </Switch>
        </div>
      </div>
    </>
  );
}
