import { Select, Skeleton } from "@idoly/ant-design-solid";
import { createMemo, createSignal, For, Show } from "solid-js";

import { listIssues, type IssueListItem } from "../data/client";
import { typeLabel } from "./model";

export function Statistics() {
  const [issues, setIssues] = createSignal<IssueListItem[]>([], { ownedWrite: true });
  const [period, setPeriod] = createSignal("30d", { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });

  void listIssues().then(setIssues).catch((reason) => {
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
    const counts = new Map<string, { key: string; name: string; count: number }>();
    for (const issue of filteredIssues()) {
      const current = counts.get(issue.service.key) ?? { ...issue.service, count: 0 };
      current.count += 1;
      counts.set(issue.service.key, current);
    }
    return [...counts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  });
  const types = createMemo(() => Object.entries(typeLabel).map(([key, name]) => ({
    key,
    name,
    count: filteredIssues().filter((issue) => issue.type === key).length,
  })).filter((type) => type.count > 0).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)));
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
