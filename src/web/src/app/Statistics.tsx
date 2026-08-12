import { Select, Skeleton } from "@idoly/ant-design-solid";
import { createMemo, createSignal, For, Show } from "solid-js";

import { listIssues, loadWorkspaceStats, type IssueListItem, type WorkspaceStats } from "../data/client";
import { fileSize, statusLabel, typeLabel } from "./model";

export function Statistics() {
  const [issues, setIssues] = createSignal<IssueListItem[]>([], { ownedWrite: true });
  const [workspaceStats, setWorkspaceStats] = createSignal<WorkspaceStats | null>(null, { ownedWrite: true });
  const [period, setPeriod] = createSignal("30d", { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });

  void Promise.all([listIssues(), loadWorkspaceStats()]).then(([loadedIssues, loadedWorkspaceStats]) => {
    setIssues(loadedIssues);
    setWorkspaceStats(loadedWorkspaceStats);
  }).catch((reason) => {
    setError(reason instanceof Error ? reason.message : "统计数据加载失败");
  }).finally(() => setLoading(false));

  const filteredIssues = createMemo(() => {
    const days = Number.parseInt(period(), 10);
    const threshold = Date.now() - days * 24 * 60 * 60_000;
    return issues().filter((issue) => new Date(issue.createdAt ?? issue.updatedAt).getTime() >= threshold);
  });
  const completed = createMemo(() => filteredIssues().filter((issue) => issue.status === "resolved").length);
  const active = createMemo(() => filteredIssues().filter((issue) => issue.status !== "resolved").length);
  const unassigned = createMemo(() => filteredIssues().filter((issue) => !issue.assigneeSubject && issue.status !== "resolved").length);
  const urgent = createMemo(() => filteredIssues().filter((issue) => (issue.priority === "p0" || issue.priority === "p1") && issue.status !== "resolved").length);
  const completionRate = createMemo(() => filteredIssues().length ? Math.round(completed() / filteredIssues().length * 1000) / 10 : 0);
  const services = createMemo(() => {
    const serviceCounts = new Map<string, { key: string; name: string; count: number }>();
    for (const issue of filteredIssues()) {
      const serviceStats = serviceCounts.get(issue.service.key) ?? { ...issue.service, count: 0 };
      serviceStats.count += 1;
      serviceCounts.set(issue.service.key, serviceStats);
    }
    return [...serviceCounts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  });
  const types = createMemo(() => Object.entries(typeLabel).map(([key, name]) => ({
    key,
    name,
    count: filteredIssues().filter((issue) => issue.type === key).length,
  })).filter((type) => type.count > 0).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)));
  const assignees = createMemo(() => {
    const assigneeStats = new Map<string, { name: string; completed: number; active: number }>();
    for (const issue of filteredIssues()) {
      const assigneeKey = issue.assigneeSubject ?? "unassigned";
      const stats = assigneeStats.get(assigneeKey) ?? { name: issue.assignee ?? "未分配", completed: 0, active: 0 };
      if (issue.status === "resolved") stats.completed += 1;
      else stats.active += 1;
      assigneeStats.set(assigneeKey, stats);
    }
    return [...assigneeStats.values()].sort((left, right) => right.active - left.active || right.completed - left.completed || left.name.localeCompare(right.name));
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
    if (hours % 24 === 0) return `已解决保留 ${hours / 24} 天`;
    return `已解决保留 ${hours} 小时`;
  };
  const releaseState = (workspace: WorkspaceStats["workspaces"][number]) => {
    if (workspace.issueStatus !== "resolved") return "解决后纳入";
    if (workspace.releasable) return "等待策略回收";
    const labels: Record<string, string> = {
      issue_already_running: "Agent 运行中",
      workspace_busy: "Agent 运行中",
      workspace_has_changes: "存在未提交改动",
      workspace_has_untracked_files: "存在未知文件",
      workspace_repository_missing: "仓库目录缺失",
      development_repository_state_invalid: "仓库状态异常",
      workspace_path_outside_issue_root: "路径异常",
    };
    return workspace.blockedReason ? (labels[workspace.blockedReason] ?? "安全检查未通过") : "安全检查未通过";
  };

  return (
    <main class="statistics-workspace">
      <header class="statistics-header">
        <div><span>最近 {period().replace("d", "")} 天</span><h1>工单处理统计</h1></div>
        <Select aria-label="统计周期" value={period()} onChange={(value) => { if (value === "7d" || value === "30d" || value === "90d") setPeriod(value); }} options={[{ value: "7d", label: "最近 7 天" }, { value: "30d", label: "最近 30 天" }, { value: "90d", label: "最近 90 天" }]} />
      </header>
      <Show when={!loading()} fallback={<div class="queue-loading"><Skeleton active paragraph={{ rows: 10 }} /></div>}>
        <Show when={!error()} fallback={<div class="queue-error" role="alert">{error()}</div>}>
          <section class="metric-strip" aria-label="核心指标">
            <div><span>提出工单</span><strong>{filteredIssues().length}</strong><small>所选周期内创建</small></div>
            <div><span>已完成</span><strong>{completed()}</strong><small>完成率 {completionRate()}%</small></div>
            <div><span>处理中</span><strong>{active()}</strong><small>未解决或关闭</small></div>
            <div><span>高优先级</span><strong>{urgent()}</strong><small>活动 P0 / P1</small></div>
            <div><span>当前未分配</span><strong>{unassigned()}</strong><small>未解决工单</small></div>
          </section>
          <Show when={workspaceStats()}>{(stats) =>
            <section class="statistics-section workspace-capacity-section" aria-labelledby="workspace-capacity-title">
              <div class="statistics-title workspace-capacity-title">
                <div><h2 id="workspace-capacity-title">Workspace 存储</h2><span>{stats().policy.maintenanceIntervalMinutes > 0 ? `每 ${stats().policy.maintenanceIntervalMinutes} 分钟自动检查` : "自动检查已关闭"} · {retentionLabel()}</span></div>
                <span>{storedWorkspaces().length} 个占用空间</span>
              </div>
              <div class="workspace-capacity-metrics">
                <div><span>当前占用</span><strong>{fileSize(stats().totalBytes)}</strong></div>
                <div><span>容量上限</span><strong>{stats().policy.highWaterBytes > 0 ? fileSize(stats().policy.highWaterBytes) : "未启用"}</strong></div>
                <div><span>回收目标</span><strong>{stats().policy.targetBytes > 0 ? fileSize(stats().policy.targetBytes) : "-"}</strong></div>
                <div><span>待自动回收</span><strong>{fileSize(automaticReleaseBytes())}</strong><small>{automaticRelease().length} 个 workspace</small></div>
              </div>
              <Show when={stats().policy.highWaterBytes > 0}>
                <div class="workspace-capacity-meter" aria-label={`Workspace 容量使用 ${Math.round(capacityPercent())}%`}>
                  <div><i style={{ width: `${capacityPercent()}%` }} /></div>
                  <span>{Math.round(capacityPercent())}%</span>
                </div>
              </Show>
              <div class="workspace-capacity-table">
                <div class="workspace-capacity-head"><span>工单</span><span>工单状态</span><span>占用</span><span>自动回收</span></div>
                <For each={storedWorkspaces()} fallback={<div class="empty-band">当前没有占用空间的开发 workspace</div>}>
                  {(workspace) => <div class="workspace-capacity-row"><strong>{workspace.issueKey}</strong><span>{statusLabel[workspace.issueStatus]}</span><span>{fileSize(workspace.bytes)}</span><span class={workspace.issueStatus === "resolved" ? (workspace.releasable ? "release-ready" : "release-blocked") : ""}>{releaseState(workspace)}</span></div>}
                </For>
              </div>
            </section>
          }</Show>
          <div class="statistics-grid">
            <section class="statistics-section">
              <div class="statistics-title"><h2>服务工单量</h2><span>按工单服务计数</span></div>
              <For each={services()} fallback={<div class="empty-band">周期内暂无服务工单</div>}>{(service) => <div class="ranking-row"><span>{service.name}</span><div><i style={{ width: `${service.count / (services()[0]?.count ?? 1) * 100}%` }} /></div><strong>{service.count}</strong></div>}</For>
            </section>
            <section class="statistics-section">
              <div class="statistics-title"><h2>工单类型</h2><span>共 {filteredIssues().length} 个</span></div>
              <For each={types()} fallback={<div class="empty-band">周期内暂无工单</div>}>{(type) => <div class="type-row"><i /><span>{type.name} / {type.key}</span><strong>{type.count}</strong><small>{Math.round(type.count / filteredIssues().length * 100)}%</small></div>}</For>
            </section>
            <section class="statistics-section assignee-section">
              <div class="statistics-title"><h2>个人处理情况</h2><span>按当前处理人</span></div>
              <div class="assignee-table">
                <div class="assignee-head"><span>处理人</span><span>完成</span><span>处理中</span><span>合计</span></div>
                <For each={assignees()} fallback={<div class="empty-band">周期内暂无工单</div>}>{(row) => <div><strong>{row.name}</strong><span>{row.completed}</span><span>{row.active}</span><span>{row.completed + row.active}</span></div>}</For>
              </div>
            </section>
          </div>
        </Show>
      </Show>
    </main>
  );
}
