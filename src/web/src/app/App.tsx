import { Button, ConfigProvider, Layout, Segmented, Skeleton, theme } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, Show } from "solid-js";

import { getIssue, type IssueDetail } from "../data/client";
import { ExternalLink, Minimize2, TerminalSquare } from "../ui/icons";
import { AgentPanel } from "./AgentPanel";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { ConfigurationView } from "./ConfigurationView";
import { IssueQueue } from "./IssueQueue";
import { IssueWorkspace } from "./IssueWorkspace";
import { Statistics } from "./Statistics";
import "@idoly/ant-design-solid/base.css";
import "@idoly/ant-design-solid/badge/style.css";
import "@idoly/ant-design-solid/button/style.css";
import "@idoly/ant-design-solid/config-provider/style.css";
import "@idoly/ant-design-solid/checkbox/style.css";
import "@idoly/ant-design-solid/input/style.css";
import "@idoly/ant-design-solid/layout/style.css";
import "@idoly/ant-design-solid/modal/style.css";
import "@idoly/ant-design-solid/segmented/style.css";
import "@idoly/ant-design-solid/select/style.css";
import "@idoly/ant-design-solid/skeleton/style.css";
import "@idoly/ant-design-solid/space/style.css";
import "@idoly/ant-design-solid/tag/style.css";

function AgentWorkbench(props: { issue: IssueDetail; codeExpanded: boolean; codeServerTarget: string | null; onCloseCode: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  return (
    <section class={`agent-workbench${props.codeExpanded ? " code-only" : ""}`} aria-label={`${props.issue.id} 智能体工作区`}>
      <Show when={!props.codeExpanded}><AgentPanel issue={props.issue} onRefresh={props.onRefresh} /></Show>
      <Show when={props.codeServerTarget}>
        {(url) => (
          <section class="code-server-pane" aria-label={`${props.issue.id} code-server`} hidden={!props.codeExpanded}>
            <header class="code-server-header">
              <div><TerminalSquare size={16} /><strong>code-server</strong><small>{props.issue.id}</small></div>
              <span class="code-server-actions">
                <Button type="text" shape="circle" icon={<ExternalLink size={15} />} title="在新窗口打开 code-server" aria-label="在新窗口打开 code-server" onClick={() => window.open(url(), "_blank", "noopener")} />
                <Button type="text" shape="circle" icon={<Minimize2 size={16} />} title="还原 code-server" aria-label="还原 code-server" onClick={props.onCloseCode} />
              </span>
            </header>
            <div class="code-server-frame-wrap"><iframe class="code-server-frame" src={url()} title={`${props.issue.id} code-server 编辑器`} allow="clipboard-read; clipboard-write" /></div>
          </section>
        )}
      </Show>
    </section>
  );
}

function CurrentUserIdentity() {
  const { currentUser } = useApplicationResources();
  const name = () => currentUser()?.name || currentUser()?.subject || "本地用户";
  const detail = () => currentUser()?.email || currentUser()?.subject || "本地工作区";
  return <div class="identity"><span>本地</span><div><strong>{name()}</strong><small>{detail()}</small></div></div>;
}

function ResourceBackedIssueQueue(props: { selectedId: string; refreshToken: number; onSelect: (id: string) => void }) {
  const { currentUser } = useApplicationResources();
  return <IssueQueue selectedId={props.selectedId} userSubject={currentUser()?.subject ?? ""} refreshToken={props.refreshToken} onSelect={props.onSelect} />;
}

export function App() {
  const [view, setView] = createSignal<"issues" | "statistics" | "configuration">("issues", { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal("", { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [codeExpanded, setCodeExpanded] = createSignal(false, { ownedWrite: true });
  const [codeServerTarget, setCodeServerTarget] = createSignal<string | null>(null, { ownedWrite: true });
  let request = 0;
  createEffect(
    () => selectedId(),
    (id) => {
      const currentRequest = ++request;
      setCodeExpanded(false);
      setCodeServerTarget(null);
      if (!id) {
        setIssue(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setIssueError("");
      void getIssue(id).then((value) => {
        if (currentRequest === request) setIssue(value);
      }).catch((error) => {
        if (currentRequest !== request) return;
        setIssue(null);
        setIssueError(error instanceof Error ? error.message : "工单加载失败");
      }).finally(() => {
        if (currentRequest === request) setLoading(false);
      });
    },
  );
  const refreshIssue = async (issueId: string) => {
    const refreshed = await getIssue(issueId);
    if (selectedId() === issueId) setIssue(refreshed);
    return refreshed;
  };
  const appTheme = createMemo(() => ({
    algorithm: theme.defaultAlgorithm,
    token: {
      colorPrimary: "#176b5b",
      colorPrimaryHover: "#248171",
      colorPrimaryActive: "#105448",
      borderRadius: "6px",
      colorInfo: "#1677ff",
    },
  }));

  return (
    <ConfigProvider theme={appTheme()}>
      <ApplicationResourcesProvider>
      <Layout class="app-shell">
        <Layout.Header class="app-header">
          <div class="brand"><span>IP</span><strong>issue-pilot</strong></div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              size="small"
              value={view()}
              options={[{ value: "issues", label: "工单" }, { value: "statistics", label: "统计" }, { value: "configuration", label: "配置" }]}
              onChange={(value) => setView(value as "issues" | "statistics" | "configuration")}
            />
          </div>
          <CurrentUserIdentity />
        </Layout.Header>
        <Layout.Content class={`app-content${codeExpanded() && view() === "issues" ? " code-expanded" : ""}`}>
          <Show when={view() === "issues"} fallback={view() === "statistics" ? <Statistics /> : <ConfigurationView />}>
            <Show when={!codeExpanded()}><ResourceBackedIssueQueue selectedId={selectedId()} refreshToken={issueRefreshToken()} onSelect={setSelectedId} /></Show>
            <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
              <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                {(current) => (
                  <>
                    <AgentWorkbench issue={current()} codeExpanded={codeExpanded()} codeServerTarget={codeServerTarget()} onCloseCode={() => setCodeExpanded(false)} onRefresh={refreshIssue} />
                    <Show when={!codeExpanded()}><IssueWorkspace issue={current()} onOpenCodeServer={(url) => { setCodeServerTarget(url); setCodeExpanded(true); }} onUpdated={async () => { await refreshIssue(current().id); setIssueRefreshToken((value) => value + 1); }} /></Show>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </Layout.Content>
      </Layout>
      </ApplicationResourcesProvider>
    </ConfigProvider>
  );
}
