import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, Modal, Segmented } from "../ui";
import { copyText } from "../ui/clipboard";
import { Markdown } from "../ui/Markdown";
import { currentUserSubject, readIssueQueryResult } from "../data/client";
import { createLatestTask } from "../data/latest";
import { issuePilotConfig } from "../../../../issue-pilot.config";
import type { ConversationEntry } from "./conversation";

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
const PAGE_SIZE = 50;
const collator = new Intl.Collator("zh-CN", { numeric: true });

function cellText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSlsResult(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!record(value) || !record(value.query) || !Array.isArray(value.records)) return;
  const { query, records } = value;
  if (query.possiblyIncomplete !== false || query.returnedRows !== records.length || !records.every(record)) return;
  if (typeof query.region !== "string" || typeof query.project !== "string" || typeof query.logstore !== "string" || typeof query.timezone !== "string") return;
  if (typeof query.from !== "number" || typeof query.to !== "number") return;
  let timeRange: string;
  try {
    const format = new Intl.DateTimeFormat("zh-CN", { timeZone: query.timezone, dateStyle: "short", timeStyle: "medium", hourCycle: "h23" });
    timeRange = `${format.format(query.from * 1000)} – ${format.format(query.to * 1000)} (${query.timezone})`;
  } catch {
    return;
  }
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))];
  // Bound the mounted cells, including sparse results. Wide or non-tabular results retain their original view.
  if (columns.length > 32 || (records.length > 0 && columns.length === 0)) return;
  const numericColumns = new Set(columns.filter((column) => records.every((row) => !Object.hasOwn(row, column) || row[column] == null || typeof row[column] === "number")));
  const rows = records.map((row, index) => {
    const cells = columns.map((column) => {
      if (!Object.hasOwn(row, column)) return "—";
      const cell = row[column];
      return typeof cell === "string" && cell !== "" ? cell : JSON.stringify(cell);
    });
    return { index, raw: row, cells, search: cells.join("\n").toLowerCase() };
  });
  return { columns, numericColumns, rows, source: `${query.project} / ${query.logstore} · ${query.region}`, timeRange };
}

type SlsResult = NonNullable<ReturnType<typeof readSlsResult>>;

// Expanded cards own their optional full read. Collapse, navigation and identity changes discard it.
export function QueryResult(props: { entry: ToolEntry; text: string; issueKey?: string; userSubject?: string }) {
  const latest = createLatestTask();
  const [complete, setComplete] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [failed, setFailed] = createSignal(false, { ownedWrite: true });
  const key = () => JSON.stringify([props.issueKey, props.userSubject, props.entry.result?.queryResult, props.entry.toolCallId]);
  createEffect(key, () => {
    latest.cancel();
    setComplete(undefined);
    setLoading(false);
    setFailed(false);
  });
  onCleanup(() => latest.cancel());
  const read = async () => {
    const reference = props.entry.result?.queryResult;
    if (!props.issueKey || !reference || loading()) return;
    const task = latest.begin(),
      owner = key(),
      subject = currentUserSubject();
    const current = () => task.isCurrent() && key() === owner && subject === currentUserSubject();
    setLoading(true);
    setFailed(false);
    try {
      const text = await readIssueQueryResult(props.issueKey, reference, task.signal);
      if (current()) setComplete(text);
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setLoading(false);
      task.finish();
    }
  };
  const entry = createMemo(() => (complete() === undefined ? props.entry : { ...props.entry, result: { ...props.entry.result!, displayTruncated: false } }));
  return (
    <>
      <Show when={props.entry.result?.displayTruncated && props.entry.result.queryResult && props.issueKey && complete() === undefined}>
        <div class="agent-query-controls">
          <Button size="small" disabled={loading()} onClick={() => void read()}>
            {loading() ? "正在读取…" : failed() ? "重新读取完整结果" : "查看完整结果"}
          </Button>
          <span class="agent-query-meta">读取已保存的结果，不重新查询</span>
        </div>
        <Show when={failed()}>
          <p role="alert" class="agent-query-meta">
            读取失败，已有内容保留，可重试
          </p>
        </Show>
      </Show>
      <QueryTable entry={entry()} text={complete() ?? props.text} />
    </>
  );
}

function DmsResult(props: { entry: ToolEntry; text: string }) {
  const [mode, setMode] = createSignal<"table" | "raw">("table", { ownedWrite: true });
  const content = createMemo(() => {
    const entry = props.entry;
    if (entry.name !== "service_query" || entry.status !== "complete" || entry.result?.displayTruncated) return;
    if (!record(entry.result?.details) || entry.result.details.provider !== "aliyun-dms-mcp") return;
    // Upstream executeScript returns Markdown text, not typed rows. Render it without reconstructing data.
    // Large responses stay plain text so an explicit full read cannot mount unbounded Markdown tables.
    if (props.text.length > issuePilotConfig.web.agentToolOutputCharacters) return;
    try {
      const value: unknown = JSON.parse(props.text);
      if (!record(value) || value.tool !== "executeScript" || !record(value.result) || value.result.isError === true || !Array.isArray(value.result.content)) return;
      if (!value.result.content.every((part) => record(part) && part.type === "text" && typeof part.text === "string")) return;
      return value.result.content.map((part) => part.text).join("\n");
    } catch {
      return;
    }
  });
  const source = () => {
    const details = props.entry.result?.details;
    return record(details) ? [details.environment, details.service, details.instanceAlias, details.schema].filter((part) => typeof part === "string").join(" / ") : "";
  };
  return (
    <Show when={content()} fallback={<pre class="agent-tool-output">{props.text}</pre>}>
      {(text) => (
        <section class="agent-query-result" aria-label="DMS 查询结果">
          <div class="agent-query-meta">{source()}</div>
          <div class="agent-query-controls">
            <Segmented
              aria-label="查询结果视图"
              options={[
                { value: "table", label: "表格" },
                { value: "raw", label: "原文" },
              ]}
              value={mode()}
              onChange={setMode}
            />
          </div>
          <p class="agent-query-meta">DMS 返回的文本表格，保留服务端格式</p>
          <Show when={mode() === "table"} fallback={<pre class="agent-tool-output">{props.text}</pre>}>
            <div class="agent-query-scroll ip-scrollbar" role="region" aria-label="DMS 查询结果，可滚动" tabindex={0}>
              <Markdown source={text()} cache={false} />
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}

function QueryTable(props: { entry: ToolEntry; text: string }) {
  const tableText = createMemo(() => {
    const entry = props.entry;
    if (entry.name !== "service_query" || entry.status !== "complete" || entry.result?.displayTruncated) return;
    if (!record(entry.result?.details) || entry.result.details.provider !== "aliyun-sls-cli") return;
    return props.text;
  });
  // Tool timing/metadata updates do not change the result's identity or dismiss an open record.
  const result = createMemo(() => {
    const text = tableText();
    return text ? readSlsResult(text) : undefined;
  });
  const [mode, setMode] = createSignal<"table" | "raw">("table", { ownedWrite: true });
  const [filter, setFilter] = createSignal("", { ownedWrite: true });
  const [page, setPage] = createSignal(0, { ownedWrite: true });
  const [sort, setSort] = createSignal<{ column: string; direction: "ascending" | "descending" } | undefined>(undefined, { ownedWrite: true });
  const [selection, setSelection] = createSignal<{ result: SlsResult; row: SlsResult["rows"][number] } | undefined>(undefined, { ownedWrite: true });
  const selected = () => (selection()?.result === result() ? selection()?.row : undefined);
  const [copyState, setCopyState] = createSignal<{ result: SlsResult; message: string; pending?: boolean; error?: boolean } | undefined>(undefined, { ownedWrite: true });
  const copyNotice = () => (copyState()?.result === result() ? copyState() : undefined);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const copy = async (text: string, label: string) => {
    const source = result();
    if (!source || copyState()?.pending) return;
    setCopyState({ result: source, message: "正在复制…", pending: true });
    try {
      await copyText(text);
      if (!disposed) setCopyState({ result: source, message: `已复制${label}` });
    } catch {
      if (!disposed) setCopyState({ result: source, message: "复制失败，请选中文字手动复制", error: true });
    }
  };
  const changeSort = (column: string) => {
    const current = sort();
    setSort(current?.column !== column ? { column, direction: "ascending" } : current.direction === "ascending" ? { column, direction: "descending" } : undefined);
    setPage(0);
  };
  const sortLabel = (column: string) => (sort()?.column !== column ? `按 ${column} 升序排列` : sort()?.direction === "ascending" ? `按 ${column} 降序排列` : "恢复原始顺序");
  const filtered = createMemo(() => {
    const rows = result()?.rows ?? [];
    const term = filter().trim().toLowerCase();
    return term ? rows.filter((row) => row.search.includes(term)) : rows;
  });
  const sorted = createMemo(() => {
    const order = sort();
    const data = result();
    if (!order || !data || !data.columns.includes(order.column)) return filtered();
    return [...filtered()].sort((a, b) => {
      const left = Object.hasOwn(a.raw, order.column) ? a.raw[order.column] : undefined;
      const right = Object.hasOwn(b.raw, order.column) ? b.raw[order.column] : undefined;
      // Missing values and null remain last in both directions. Equal values retain source order.
      if (left == null) return right == null ? 0 : 1;
      if (right == null) return -1;
      const compared = data.numericColumns.has(order.column) ? Number(left) - Number(right) : collator.compare(cellText(left), cellText(right));
      return order.direction === "ascending" ? compared : -compared;
    });
  });
  const pageCount = () => Math.max(1, Math.ceil(filtered().length / PAGE_SIZE));
  const currentPage = () => Math.min(page(), pageCount() - 1);
  const visible = createMemo(() => sorted().slice(currentPage() * PAGE_SIZE, (currentPage() + 1) * PAGE_SIZE));
  return (
    <Show when={result()} fallback={<DmsResult entry={props.entry} text={props.text} />}>
      {(data) => (
        <section class="agent-query-result" aria-label="SLS 查询结果">
          <div class="agent-query-meta">{data().source}</div>
          <div class="agent-query-meta">{data().timeRange}</div>
          <div class="agent-query-controls">
            <Segmented
              aria-label="查询结果视图"
              options={[
                { value: "table", label: "表格" },
                { value: "raw", label: "原文" },
              ]}
              value={mode()}
              onChange={setMode}
            />
            <span class="agent-query-meta">本次返回 {data().rows.length} 条</span>
          </div>
          <Show when={mode() === "table"} fallback={<pre class="agent-tool-output">{props.text}</pre>}>
            <Show when={data().rows.length > 0} fallback={<p class="agent-query-meta">本次查询未返回记录</p>}>
              <Input
                aria-label="筛选本次查询结果"
                placeholder="筛选本次结果，不重新查询"
                value={filter()}
                allowClear
                onInput={(event) => {
                  setFilter(event.currentTarget.value);
                  setPage(0);
                }}
              />
              <div class="agent-query-controls">
                <Button
                  size="small"
                  disabled={sorted().length === 0 || copyState()?.pending}
                  onClick={() =>
                    void copy(
                      JSON.stringify(
                        sorted().map((row) => row.raw),
                        null,
                        2,
                      ),
                      `筛选结果（${sorted().length} 条）`,
                    )
                  }
                >
                  复制筛选结果
                </Button>
                <span class="agent-query-meta">JSON · 包含所有匹配页</span>
              </div>
              <Show
                when={filtered().length > 0}
                fallback={
                  <p class="agent-query-meta" role="status">
                    没有匹配的记录
                  </p>
                }
              >
                <div class="agent-query-scroll ip-scrollbar" role="region" aria-label="查询结果表格，可滚动" tabindex={0}>
                  <table aria-label="SLS 本次查询结果">
                    <thead>
                      <tr>
                        <th scope="col" class="agent-query-row-action">
                          详情
                        </th>
                        <For each={data().columns}>
                          {(column) => (
                            <th scope="col" aria-sort={sort()?.column === column ? sort()?.direction : undefined}>
                              <button type="button" class="agent-query-sort" aria-label={sortLabel(column)} onClick={() => changeSort(column)}>
                                {column} <span aria-hidden="true">{sort()?.column !== column ? "↕" : sort()?.direction === "ascending" ? "↑" : "↓"}</span>
                              </button>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={visible()}>
                        {(row) => (
                          <tr>
                            <td class="agent-query-row-action">
                              <Button size="small" aria-label={`查看第 ${row.index + 1} 条记录`} onClick={() => setSelection({ result: data(), row })}>
                                查看
                              </Button>
                            </td>
                            <For each={row.cells}>{(cell) => <td>{cell.length > 160 ? `${cell.slice(0, 160)}…` : cell}</td>}</For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
              <div class="agent-query-controls">
                <span class="agent-query-meta" role="status">
                  {filtered().length ? `${currentPage() * PAGE_SIZE + 1}–${Math.min((currentPage() + 1) * PAGE_SIZE, filtered().length)}` : "0"} / {filtered().length} 条
                </span>
                <Show when={pageCount() > 1}>
                  <Button size="small" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}>
                    上一页
                  </Button>
                  <Button size="small" disabled={currentPage() === pageCount() - 1} onClick={() => setPage(currentPage() + 1)}>
                    下一页
                  </Button>
                </Show>
              </div>
            </Show>
          </Show>
          <Show when={copyNotice() && !selected()}>
            <p class="agent-query-meta" role={copyNotice()?.error ? "alert" : "status"}>
              {copyNotice()?.message}
            </p>
          </Show>
          <Modal
            open={!!selected()}
            title={`查询记录 · 第 ${(selected()?.index ?? 0) + 1} 条`}
            width={760}
            onOk={() => setSelection(undefined)}
            onCancel={() => setSelection(undefined)}
            footer={
              <>
                <Button
                  disabled={copyState()?.pending}
                  onClick={() => {
                    const row = selected();
                    if (row) void copy(JSON.stringify(row.raw, null, 2), "整条记录");
                  }}
                >
                  复制整条记录
                </Button>
                <Button onClick={() => setSelection(undefined)}>关闭</Button>
              </>
            }
          >
            <div class="query-record">
              <p>
                {data().source}
                <br />
                {data().timeRange}
              </p>
              <Show when={copyNotice()}>
                <p role={copyNotice()?.error ? "alert" : "status"}>{copyNotice()?.message}</p>
              </Show>
              <Show when={selected()}>
                {(row) => (
                  <dl>
                    <For each={Object.keys(row().raw)}>
                      {(column) => (
                        <div class="query-record-field">
                          <dt>
                            {column}
                            <Button size="small" aria-label={`复制字段 ${column}`} disabled={copyState()?.pending} onClick={() => void copy(cellText(row().raw[column]), `字段 ${column}`)}>
                              复制
                            </Button>
                          </dt>
                          <dd>
                            <pre>{row().raw[column] === "" ? '""' : cellText(row().raw[column])}</pre>
                          </dd>
                        </div>
                      )}
                    </For>
                  </dl>
                )}
              </Show>
            </div>
          </Modal>
        </section>
      )}
    </Show>
  );
}
