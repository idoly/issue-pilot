import { Select, Skeleton } from "../ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { loadWorkspaceStats, type IssueListItem, type WorkspaceStats } from "../data/client";
import { fileSize, statusLabel, typeLabel } from "./model";

type InsightView = "output" | "distribution" | "team" | "resources";
type StatisticsPeriod = "7d" | "30d" | "90d";

export function Statistics(props: { issues: IssueListItem[] }) {
  const [workspaceStats, setWorkspaceStats] = createSignal<WorkspaceStats | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  const [view, setView] = createSignal<InsightView>("distribution", { ownedWrite: true });
  const [period, setPeriod] = createSignal<StatisticsPeriod>("30d", { ownedWrite: true });
  const controller = new AbortController();

  void loadWorkspaceStats(controller.signal).then(setWorkspaceStats).catch((reason) => {
    if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "Workspace 统计加载失败");
  }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  onCleanup(() => controller.abort());

  const periodDays = createMemo(() => Number.parseInt(period(), 10));
  const filteredIssues = createMemo(() => {
    const threshold = Date.now() - periodDays() * 24 * 60 * 60_000;
    return props.issues.filter((issue) => new Date(issue.createdAt ?? issue.updatedAt).getTime() >= threshold);
  });
  const completed = createMemo(() => filteredIssues().filter((issue) => issue.status === "resolved").length);
  const completionRate = createMemo(() => filteredIssues().length ? Math.round(completed() / filteredIssues().length * 1000) / 10 : 0);
  const dailyCompletion = createMemo(() => Math.round(completed() / periodDays() * 10) / 10);
  const services = createMemo(() => {
    const rows = new Map<string, { name: string; count: number }>();
    for (const issue of filteredIssues()) {
      const row = rows.get(issue.service.key) ?? { name: issue.service.name, count: 0 };
      row.count += 1; rows.set(issue.service.key, row);
    }
    return [...rows.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  });
  const types = createMemo(() => Object.entries(typeLabel).map(([key, name]) => ({ key, name, count: filteredIssues().filter((issue) => issue.type === key).length })).filter((item) => item.count > 0).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)));
  const assignees = createMemo(() => {
    const rows = new Map<string, { name: string; completed: number; active: number }>();
    for (const issue of filteredIssues()) {
      const key = issue.assigneeSubject ?? "unassigned";
      const row = rows.get(key) ?? { name: issue.assignee ?? "未分配", completed: 0, active: 0 };
      if (issue.status === "resolved") row.completed += 1;
      else row.active += 1;
      rows.set(key, row);
    }
    return [...rows.values()].sort((left, right) => right.active - left.active || right.completed - left.completed || left.name.localeCompare(right.name));
  });
  const storedWorkspaces = createMemo(() => [...(workspaceStats()?.workspaces ?? [])].filter((workspace) => workspace.bytes > 0).sort((left, right) => right.bytes - left.bytes || left.issueKey.localeCompare(right.issueKey)));
  const automaticRelease = createMemo(() => storedWorkspaces().filter((workspace) => workspace.issueStatus === "resolved" && workspace.releasable));
  const automaticReleaseBytes = createMemo(() => automaticRelease().reduce((total, workspace) => total + workspace.bytes, 0));
  const capacityPercent = createMemo(() => {
    const stats = workspaceStats();
    if (!stats?.policy.highWaterBytes) return 0;
    return Math.min(100, stats.totalBytes / stats.policy.highWaterBytes * 100);
  });
  const retentionLabel = () => {
    const hours = workspaceStats()?.policy.retentionHours;
    if (hours === null || hours === undefined) return "保留期回收关闭";
    return hours % 24 === 0 ? `已解决保留 ${hours / 24} 天` : `已解决保留 ${hours} 小时`;
  };
  const releaseState = (workspace: WorkspaceStats["workspaces"][number]) => {
    if (workspace.issueStatus !== "resolved") return "解决后纳入";
    if (workspace.releasable) return "等待策略回收";
    const labels: Record<string, string> = {
      issue_already_running: "Agent 运行中", workspace_busy: "Agent 运行中", workspace_has_changes: "存在未提交改动",
      workspace_has_untracked_files: "存在未知文件", workspace_repository_missing: "仓库目录缺失",
      development_repository_state_invalid: "仓库状态异常", workspace_path_does_not_match_repository: "仓库路径不一致",
      repository_workspace_name_conflict: "仓库目录名冲突", workspace_path_outside_issue_root: "路径异常",
    };
    return workspace.blockedReason ? (labels[workspace.blockedReason] ?? "安全检查未通过") : "安全检查未通过";
  };

  return (
    <section class="statistics-workspace insight-workspace" aria-label="运营洞察">
      <header class="statistics-header insight-header">
        <div><span>补充视图</span><h2>运营洞察</h2><small>完整统计收纳在固定高度视图中</small></div>
        <Select aria-label="统计周期" value={period()} onChange={(value) => { if (value) setPeriod(value); }} options={[{ value: "7d", label: "最近 7 天" }, { value: "30d", label: "最近 30 天" }, { value: "90d", label: "最近 90 天" }]} />
      </header>
      <nav class="insight-tabs" role="tablist" aria-label="统计分类">
        <button type="button" role="tab" aria-selected={view() === "output" ? "true" : "false"} class={view() === "output" ? "selected" : ""} onClick={() => setView("output")}>产出</button>
        <button type="button" role="tab" aria-selected={view() === "distribution" ? "true" : "false"} class={view() === "distribution" ? "selected" : ""} onClick={() => setView("distribution")}>分布</button>
        <button type="button" role="tab" aria-selected={view() === "team" ? "true" : "false"} class={view() === "team" ? "selected" : ""} onClick={() => setView("team")}>团队</button>
        <button type="button" role="tab" aria-selected={view() === "resources" ? "true" : "false"} class={view() === "resources" ? "selected" : ""} onClick={() => setView("resources")}>资源</button>
      </nav>
      <div class="insight-panel" role="tabpanel" hidden={view() !== "output"}>
        <section class="metric-strip" aria-label="周期产出指标">
          <div><span>周期新增</span><strong>{filteredIssues().length}</strong><small>所选周期内创建</small></div>
          <div><span>周期解决</span><strong>{completed()}</strong><small>已完成工单</small></div>
          <div><span>解决率</span><strong>{completionRate()}%</strong><small>解决数 / 新增数</small></div>
          <div><span>日均解决</span><strong>{dailyCompletion()}</strong><small>平均每日完成</small></div>
        </section>
      </div>
      <div class="insight-panel" role="tabpanel" hidden={view() !== "distribution"}>
        <div class="distribution-grid">
          <section class="statistics-section"><div class="statistics-title"><h2>服务工单量</h2><span>按服务计数</span></div><div class="compact-scroll service-ranking-scroll"><For each={services()} fallback={<div class="empty-band">周期内暂无服务工单</div>}>{(service) => <div class="ranking-row"><span>{service.name}</span><div><i style={{ width: `${service.count / (services()[0]?.count ?? 1) * 100}%` }} /></div><strong>{service.count}</strong></div>}</For></div></section>
          <section class="statistics-section"><div class="statistics-title"><h2>工单类型</h2><span>共 {filteredIssues().length} 个</span></div><div class="compact-scroll"><For each={types()} fallback={<div class="empty-band">周期内暂无工单</div>}>{(type) => <div class="type-row"><i /><span>{type.name} / {type.key}</span><strong>{type.count}</strong><small>{Math.round(type.count / filteredIssues().length * 100)}%</small></div>}</For></div></section>
        </div>
      </div>
      <div class="insight-panel" role="tabpanel" hidden={view() !== "team"}>
        <section class="statistics-section compact-panel" aria-labelledby="assignee-summary-title"><div class="statistics-title"><h2 id="assignee-summary-title">个人处理情况</h2><span>最近 {periodDays()} 天</span></div><div class="assignee-table compact-scroll"><div class="assignee-head"><span>处理人</span><span>完成</span><span>处理中</span><span>合计</span></div><For each={assignees()} fallback={<div class="empty-band">周期内暂无工单</div>}>{(row) => <div><strong>{row.name}</strong><span>{row.completed}</span><span>{row.active}</span><span>{row.completed + row.active}</span></div>}</For></div></section>
      </div>
      <div class="insight-panel" role="tabpanel" hidden={view() !== "resources"}>
        <section class="statistics-section resource-full-panel" aria-labelledby="workspace-capacity-title" aria-busy={loading() ? "true" : "false"}>
          <div class="statistics-title"><h2 id="workspace-capacity-title">Workspace 存储</h2><span>{storedWorkspaces().length} 个占用空间</span></div>
          <Show when={!loading()} fallback={<div aria-busy="true"><Skeleton active paragraph={{ rows: 4 }} /></div>}><Show when={!loadError()} fallback={<div class="queue-error" role="alert">{loadError()}</div>}><Show when={workspaceStats()}>{(stats) => <>
            <div class="workspace-compact-summary"><div class="workspace-current-usage"><span>当前占用</span><strong>{fileSize(stats().totalBytes)}</strong></div><div><span>容量上限</span><strong>{stats().policy.highWaterBytes > 0 ? fileSize(stats().policy.highWaterBytes) : "未启用"}</strong></div><div class="workspace-reclaim"><span>待自动回收</span><strong>{fileSize(automaticReleaseBytes())}</strong></div></div>
            <div class="workspace-capacity-control">
              <Show when={stats().policy.highWaterBytes > 0}><div class="workspace-capacity-meter" aria-label={`Workspace 容量使用 ${Math.round(capacityPercent())}%`}><div><i style={{ width: `${capacityPercent()}%` }} /></div><span>{Math.round(capacityPercent())}%</span></div></Show>
              <div class="workspace-policy">{stats().policy.maintenanceIntervalMinutes > 0 ? `每 ${stats().policy.maintenanceIntervalMinutes} 分钟自动检查` : "自动检查已关闭"} · {retentionLabel()}</div>
            </div>
            <div class="workspace-compact-list compact-scroll"><div class="workspace-compact-head"><span>工单</span><span>状态</span><span>占用</span><span>自动回收</span></div><For each={storedWorkspaces()} fallback={<div class="empty-band">当前没有占用空间的开发 Workspace</div>}>{(workspace) => <div><strong>{workspace.issueKey}</strong><span>{statusLabel[workspace.issueStatus]}</span><span>{fileSize(workspace.bytes)}</span><small>{releaseState(workspace)}</small></div>}</For></div>
          </>}</Show></Show></Show>
        </section>
      </div>
    </section>
  );
}
