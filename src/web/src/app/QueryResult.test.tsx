import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, createStore, reconcile } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail, RunEvent } from "../data/client";
import * as client from "../data/client";
import { ConversationItem } from "./AgentPanel";
import { ConversationProjection, resultText, type ConversationEntry } from "./conversation";
import { QueryResult } from "./QueryResult";

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function fullReadFixture() {
  const entry = tool(Array.from({ length: 65 }, (_, id) => ({ id, message: "complete evidence ".repeat(40) })));
  const text = resultText(entry);
  entry.result!.displayTruncated = true;
  entry.result!.queryResult = { sessionId: "session", entryId: "entry" };
  entry.result!.content = [{ type: "text", text: "bounded preview" }];
  return { entry, text };
}

describe("saved complete query reads", () => {
  it("reads only on demand, retries without querying, then pages the retained rows locally", async () => {
    const { entry, text } = fullReadFixture();
    const read = vi.spyOn(client, "readIssueQueryResult").mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(text);
    const view = render(() => <QueryResult issueKey="ISSUE-20261114-001" entry={entry} text={resultText(entry)} />);
    try {
      expect(read).not.toHaveBeenCalled();
      expect(screen.queryByRole("table")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "查看完整结果" }));
      await screen.findByRole("alert");
      expect(view.container.querySelector("pre")!.textContent).toBe("bounded preview");
      fireEvent.click(screen.getByRole("button", { name: "重新读取完整结果" }));
      await screen.findByRole("table");
      expect(read.mock.calls[1]!.slice(0, 2)).toEqual(["ISSUE-20261114-001", { sessionId: "session", entryId: "entry" }]);
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("51–65 / 65 条");
      fireEvent.click(screen.getByRole("radio", { name: "原文" }));
      await waitFor(() => expect(view.container.querySelector("pre")!.textContent).toBe(text));
      expect(read).toHaveBeenCalledTimes(2);
      expect(entry.result!.displayTruncated).toBe(true);
      expect(resultText(entry)).toBe("bounded preview");
    } finally {
      view.unmount();
    }
  });

  for (const change of ["identity", "result", "issue", "unmount"] as const)
    it(`aborts the old read and rejects late content after ${change} changes`, async () => {
      const { entry, text } = fullReadFixture();
      const [user, setUser] = createSignal("alice", { ownedWrite: true });
      const [issue, setIssue] = createSignal("ISSUE-20261114-001", { ownedWrite: true });
      const [value, setValue] = createSignal(entry, { ownedWrite: true });
      let resolve!: (text: string) => void;
      const read = vi.spyOn(client, "readIssueQueryResult").mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const view = render(() => <QueryResult issueKey={issue()} userSubject={user()} entry={value()} text={resultText(value())} />);
      try {
        fireEvent.click(screen.getByRole("button", { name: "查看完整结果" }));
        await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        if (change === "identity") setUser("bob");
        else if (change === "result") setValue({ ...entry, result: { ...entry.result!, queryResult: { sessionId: "session", entryId: "other" } } });
        else if (change === "issue") setIssue("ISSUE-20261114-002");
        else view.unmount();
        await waitFor(() => expect(read.mock.calls[0]![2].aborted).toBe(true));
        resolve(text);
        await Promise.resolve();
        expect(screen.queryByRole("table")).toBeNull();
      } finally {
        if (change !== "unmount") view.unmount();
      }
    });

  it("projects saved nested evidence once and keeps its reference when live summaries arrive", () => {
    const { entry } = fullReadFixture();
    const projection = new ConversationProjection();
    const envelope = { id: "entry", issueId: "issue", createdAt: entry.startedAt };
    const result = entry.result!;
    projection.apply({ ...envelope, event: { type: "tool_execution_end", toolCallId: "script/1", parentToolCallId: "script", toolName: "service_query", isError: false, result } });
    projection.apply({
      ...envelope,
      id: "raw-end",
      event: {
        type: "tool_execution_end",
        toolCallId: "script/1",
        parentToolCallId: "script",
        toolName: "service_query",
        isError: false,
        result: { content: result.content, details: result.details },
      },
    });
    projection.apply({ ...envelope, id: "overlap", event: { type: "tool_execution_end", toolCallId: "script/1", parentToolCallId: "script", toolName: "service_query", isError: false, result } });
    expect(projection.snapshot()).toHaveLength(1);
    expect(projection.snapshot()[0]).toMatchObject({ parentToolCallId: "script", status: "complete", result: { queryResult: { sessionId: "session", entryId: "entry" } } });
  });
});

describe("DMS response view", () => {
  it("renders the upstream Markdown table safely with source metadata and a lossless raw view", async () => {
    const entry = tool();
    entry.result = {
      details: { provider: "aliyun-dms-mcp", environment: "prod", service: "example", instanceAlias: "primary", schema: "orders" },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tool: "executeScript",
            result: { content: [{ type: "text", text: "| id | state |\n| --- | --- |\n| 1 | pending |\n\n<button>spoofed control</button><script>alert(1)</script>" }] },
          }),
        },
      ],
    };
    const text = resultText(entry),
      view = viewResult(entry);
    try {
      await screen.findByRole("table");
      expect(screen.getByText("prod / example / primary / orders")).toBeTruthy();
      expect(screen.getByRole("cell", { name: "pending" })).toBeTruthy();
      expect(view.container.querySelector("script")).toBeNull();
      expect(screen.queryByRole("button", { name: "spoofed control" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      fireEvent.click(screen.getByRole("radio", { name: "原文" }));
      await waitFor(() => expect(view.container.querySelector("pre")!.textContent).toBe(text));
    } finally {
      view.unmount();
    }
  });
  for (const result of [
    { content: [{ type: "text", text: "|a|\n|-|\n|b|" }], isError: true },
    { content: [{ type: "image", data: "invalid" }] },
    { content: [{ type: "text", text: "x".repeat(41_000) }] },
  ])
    it("keeps failed, mixed-media and oversized Markdown responses as raw evidence", () => {
      const entry = tool();
      entry.result = { details: { provider: "aliyun-dms-mcp" }, content: [{ type: "text", text: JSON.stringify({ tool: "executeScript", result }) }] };
      const view = viewResult(entry);
      try {
        expect(screen.queryByRole("table")).toBeNull();
        expect(screen.queryByRole("radiogroup")).toBeNull();
        expect(view.container.querySelector("pre")!.textContent).toBe(resultText(entry));
      } finally {
        view.unmount();
      }
    });
});
const query = {
  region: "cn-hangzhou",
  project: "example-project",
  logstore: "application-log",
  from: 1_700_000_000,
  to: 1_700_003_600,
  timezone: "Asia/Shanghai",
  queryMode: "query",
  order: "newest_first",
  pagination: "offset",
  possiblyIncomplete: false,
};
function tool(records: unknown[] = [{ message: "hello" }]): ToolEntry {
  const metadata = { ...query, returnedRows: records.length };
  return {
    id: "sls-call",
    kind: "tool",
    toolCallId: "sls-call",
    name: "service_query",
    status: "complete",
    startedAt: "2026-11-14T00:00:00.000Z",
    arguments: { capability: "sls", environment: "prod", service: "example" },
    result: { details: { provider: "aliyun-sls-cli", ...metadata }, content: [{ type: "text", text: JSON.stringify({ query: metadata, records }) }] },
  };
}
function viewResult(entry: ToolEntry) {
  return render(() => <QueryResult entry={entry} text={resultText(entry)} />);
}

describe("SLS result view", () => {
  it("keeps an open record when only the tool timing changes", async () => {
    const initial = tool();
    const [entry, setEntry] = createSignal(initial, { ownedWrite: true });
    const view = render(() => <QueryResult entry={entry()} text={resultText(entry())} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "查看第 1 条记录" }));
      const dialog = await screen.findByRole("dialog");
      setEntry({ ...initial, durationMs: 1000 });
      await waitFor(() => expect(entry().durationMs).toBe(1000));
      expect(screen.getByRole("dialog")).toBe(dialog);
    } finally {
      view.unmount();
    }
  });
  it("cycles numeric sorting across all pages, keeps nulls last and restores source order", async () => {
    const values = [10, -3, 2, 2, null, undefined, ...Array.from({ length: 55 }, (_, i) => i + 20)];
    const records = values.map((value, index) => (value === undefined ? { label: `row${index}` } : { value, label: `row${index}` }));
    const entry = tool(records);
    const original = resultText(entry);
    const view = viewResult(entry);
    const labels = () => Array.from(view.container.querySelectorAll("tbody tr")).map((row) => row.lastElementChild!.textContent);
    try {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("51–61 / 61 条");
      fireEvent.click(screen.getByRole("button", { name: "按 value 升序排列" }));
      await screen.findByText("1–50 / 61 条");
      expect(labels().slice(0, 4)).toEqual(["row1", "row2", "row3", "row0"]);
      expect(view.container.querySelector('[aria-sort="ascending"]')).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "按 value 降序排列" }));
      await waitFor(() => expect(labels()[0]).toBe("row60"));
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("51–61 / 61 条");
      expect(labels().slice(-2)).toEqual(["row4", "row5"]);
      fireEvent.click(screen.getByRole("button", { name: "恢复原始顺序" }));
      await screen.findByText("1–50 / 61 条");
      expect(labels().slice(0, 6)).toEqual(records.slice(0, 6).map((row) => row.label));
      fireEvent.click(screen.getByRole("button", { name: "按 label 升序排列" }));
      await waitFor(() => expect(labels().slice(0, 12)).toEqual(records.slice(0, 12).map((row) => row.label)));
      expect(resultText(entry)).toBe(original);
    } finally {
      view.unmount();
    }
  });

  it("copies every filtered row in display order as JSON, retaining types and omitted fields", async () => {
    const records = Array.from({ length: 110 }, (_, id) => ({ id, group: id % 2 ? "omit" : "keep", enabled: false, empty: "", nested: { value: null } }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = viewResult(tool(records));
    try {
      fireEvent.input(screen.getByRole("textbox"), { target: { value: "keep" } });
      await screen.findByText("1–50 / 55 条");
      fireEvent.click(screen.getByRole("button", { name: "按 id 升序排列" }));
      await screen.findByRole("button", { name: "按 id 降序排列" });
      fireEvent.click(screen.getByRole("button", { name: "按 id 降序排列" }));
      await screen.findByRole("button", { name: "恢复原始顺序" });
      fireEvent.click(screen.getByRole("button", { name: "复制筛选结果" }));
      await screen.findByText("已复制筛选结果（55 条）");
      expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(records.filter((row) => row.group === "keep").reverse());
      fireEvent.input(screen.getByRole("textbox"), { target: { value: "not present" } });
      await screen.findByText("没有匹配的记录");
      expect(screen.getByRole("button", { name: "复制筛选结果" }).hasAttribute("disabled")).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("keeps long field previews bounded while details and copying retain the complete original", async () => {
    const message = "<script>untrusted</script>\n" + "内容".repeat(160) + "\tend";
    const record = { message, empty: "", zero: 0, enabled: false, absent: null, nested: { list: [1, 2] } };
    const entry = tool([record]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = viewResult(entry);
    try {
      expect(screen.getByRole("table").textContent).not.toContain(message);
      fireEvent.click(screen.getByRole("button", { name: "查看第 1 条记录" }));
      const dialog = await screen.findByRole("dialog", { name: "查询记录 · 第 1 条" });
      expect(dialog.querySelector("pre")!.textContent).toBe(message);
      expect(dialog.querySelector("script")).toBeNull();
      for (const [field, value] of Object.entries(record)) {
        fireEvent.click(within(dialog).getByRole("button", { name: `复制字段 ${field}` }));
        await within(dialog).findByText(`已复制字段 ${field}`);
        expect(writeText).toHaveBeenLastCalledWith(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      }
      fireEvent.click(within(dialog).getByRole("button", { name: "复制整条记录" }));
      await within(dialog).findByText("已复制整条记录");
      expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toEqual(record);
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.input(screen.getByRole("textbox"), { target: { value: "end" } });
      await screen.findByText("1–1 / 1 条");
    } finally {
      view.unmount();
    }
  });

  it("reports copy failure, allows retry and ignores completion belonging to a replaced result", async () => {
    let resolve!: () => void;
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const [entry, setEntry] = createStore(tool([{ id: 1 }]));
    const view = viewResult(entry);
    try {
      // An unavailable clipboard and denied HTTP fallback must produce visible failure.
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      fireEvent.click(screen.getByRole("button", { name: "复制筛选结果" }));
      await screen.findByRole("alert");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      fireEvent.click(screen.getByRole("button", { name: "复制筛选结果" }));
      await screen.findByText("已复制筛选结果（1 条）");
      fireEvent.click(screen.getByRole("button", { name: "查看第 1 条记录" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "复制字段 id" }));
      await within(dialog).findByText("正在复制…");
      expect(within(dialog).getByRole("button", { name: "复制整条记录" }).hasAttribute("disabled")).toBe(true);
      setEntry(reconcile(tool([{ id: 2 }])));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      resolve();
      await waitFor(() => expect(screen.getByRole("button", { name: "复制筛选结果" }).hasAttribute("disabled")).toBe(false));
      expect(screen.queryByText(/已复制/)).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("lets an in-flight copy finish after unmount without writing to a disposed component", async () => {
    let resolve!: () => void;
    const writeText = vi.fn().mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = viewResult(tool());
    fireEvent.click(screen.getByRole("button", { name: "复制筛选结果" }));
    await screen.findByText("正在复制…");
    view.unmount();
    resolve();
    await Promise.resolve();
    expect(screen.queryByText(/已复制/)).toBeNull();
  });

  it("filters and pages only retained rows, preserves their order and original text without requests or source mutation", async () => {
    const entry = tool(Array.from({ length: 105 }, (_, id) => ({ id, message: `row ${id}`, tag: id % 2 === 0 ? "Even" : "Odd" })));
    const original = JSON.stringify(entry);
    const requests = vi.spyOn(globalThis, "fetch");
    const view = viewResult(entry);
    try {
      expect(screen.getByText("example-project / application-log · cn-hangzhou")).toBeTruthy();
      expect(screen.getByText(/2023\/11\/15.*Asia\/Shanghai/)).toBeTruthy();
      const table = () => screen.getByRole("table");
      expect(within(table()).getAllByRole("row")).toHaveLength(51);
      expect(screen.getByText("1–50 / 105 条")).toBeTruthy();
      expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("51–100 / 105 条");
      expect(within(table()).getAllByRole("row")[1]!.textContent).toBe("查看50row 50Even");
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("101–105 / 105 条");
      expect(within(table()).getAllByRole("row")).toHaveLength(6);
      expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(true);
      const input = screen.getByRole("textbox", { name: "筛选本次查询结果" });
      fireEvent.input(input, { target: { value: " eVeN " } });
      await screen.findByText("1–50 / 53 条");
      expect(within(table()).queryByText("row 1", { exact: true })).toBeNull();
      fireEvent.click(screen.getByRole("radio", { name: "原文" }));
      await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
      expect(view.container.querySelector("pre")!.textContent).toBe(resultText(entry));
      fireEvent.click(screen.getByRole("radio", { name: "表格" }));
      await screen.findByText("1–50 / 53 条");
      fireEvent.input(screen.getByRole("textbox"), { target: { value: "no match" } });
      await screen.findByText("没有匹配的记录");
      expect(screen.queryByRole("table")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "清除 筛选本次查询结果" }));
      await screen.findByText("1–50 / 105 条");
      expect(requests).not.toHaveBeenCalled();
      expect(JSON.stringify(entry)).toBe(original);
    } finally {
      requests.mockRestore();
      view.unmount();
    }
  });

  it("keeps sparse, empty, falsy, nested and HTML-like values readable as text", () => {
    const entry = tool([
      { a: 0, b: false, c: null, d: "", e: { nested: [1, "two"] } },
      { b: "<img src=x onerror=alert(1)>", later: "https://example.test/" },
      JSON.parse('{"__proto__":"ordinary field","constructor":"value"}'),
    ]);
    const view = viewResult(entry);
    try {
      const rows = within(screen.getByRole("table")).getAllByRole("row");
      expect(
        within(rows[1]!)
          .getAllByRole("cell")
          .slice(1)
          .map((cell) => cell.textContent),
      ).toEqual(["0", "false", "null", '\"\"', '{"nested":[1,"two"]}', "—", "—", "—"]);
      expect(within(rows[2]!).getAllByRole("cell")[1]!.textContent).toBe("—");
      expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
      expect(screen.getByText("ordinary field")).toBeTruthy();
      expect(view.container.querySelector("img, a")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("distinguishes an empty query from filtering out existing rows", () => {
    const view = viewResult(tool([]));
    try {
      expect(screen.getByText("本次查询未返回记录")).toBeTruthy();
      expect(screen.getByText("本次返回 0 条")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByText("没有匹配的记录")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  const fallbackCases: Array<[string, (entry: ToolEntry) => void]> = [
    [
      "truncated display",
      (entry) => {
        entry.result!.displayTruncated = true;
      },
    ],
    [
      "failed tool",
      (entry) => {
        entry.status = "error";
      },
    ],
    [
      "running tool",
      (entry) => {
        entry.status = "running";
      },
    ],
    [
      "other tool",
      (entry) => {
        entry.name = "codemode";
      },
    ],
    [
      "other provider",
      (entry) => {
        entry.result!.details = { provider: "aliyun-dms-mcp" };
      },
    ],
    [
      "missing provenance",
      (entry) => {
        delete entry.result!.details;
      },
    ],
    [
      "invalid JSON",
      (entry) => {
        entry.result!.content = [{ type: "text", text: "not JSON" }];
      },
    ],
    [
      "SDK display envelope",
      (entry) => {
        entry.result!.content = [{ type: "text", text: `Script completed\nOutput:\n${resultText(entry)}` }];
      },
    ],
    ...[
      ["partial upstream result", { ...query, returnedRows: 1, possiblyIncomplete: true }],
      ["mismatched count", { ...query, returnedRows: 2 }],
      ["invalid time zone", { ...query, returnedRows: 1, timezone: "invalid/timezone" }],
      ["invalid timestamp", { ...query, returnedRows: 1, from: 1e30 }],
    ].map(([name, metadata]): [string, (entry: ToolEntry) => void] => [
      String(name),
      (entry) => {
        entry.result!.content = [{ type: "text", text: JSON.stringify({ query: metadata, records: [{ message: "hello" }] }) }];
      },
    ]),
  ];
  for (const [name, change] of fallbackCases)
    it(`retains the original output for ${name}`, () => {
      const entry = tool();
      change(entry);
      const view = viewResult(entry);
      try {
        expect(screen.queryByRole("table")).toBeNull();
        expect(screen.queryByRole("radiogroup")).toBeNull();
        expect(view.container.querySelector("pre")!.textContent).toBe(resultText(entry));
      } finally {
        view.unmount();
      }
    });
  for (const records of [[1], [null], [[]], [{}], Array.from({ length: 33 }, (_, index) => ({ [`column${index}`]: index }))])
    it("keeps non-tabular or wide rows as original text", () => {
      const entry = tool(records);
      const view = viewResult(entry);
      try {
        expect(screen.queryByRole("table")).toBeNull();
        expect(view.container.querySelector("pre")!.textContent).toBe(resultText(entry));
      } finally {
        view.unmount();
      }
    });

  it("clamps the visible page when an updated result contains fewer rows", async () => {
    const [entry, setEntry] = createStore(tool(Array.from({ length: 60 }, (_, id) => ({ id }))));
    const view = viewResult(entry);
    try {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("51–60 / 60 条");
      setEntry(reconcile(tool([{ id: 4 }])));
      await screen.findByText("1–1 / 1 条");
      expect(screen.getAllByRole("cell")[1]!.textContent).toBe("4");
      expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
    } finally {
      view.unmount();
    }
  });

  for (const saved of [false, true])
    it(`mounts ${saved ? "replayed" : "live"} results only when the tool card is expanded`, async () => {
      const entry = tool();
      const projection = new ConversationProjection([{ ...entry, result: undefined, status: "running" }]);
      const event: RunEvent["event"] = saved
        ? {
            type: "message_end",
            message: {
              role: "toolResult",
              toolCallId: entry.toolCallId,
              toolName: entry.name,
              content: entry.result!.content,
              details: { provider: "aliyun-sls-cli", ...query, returnedRows: 1 },
              isError: false,
              timestamp: 1,
            },
          }
        : { type: "tool_execution_end", toolCallId: entry.toolCallId, toolName: entry.name, result: entry.result!, isError: false };
      projection.apply({ id: "completion", issueId: "fixture", createdAt: entry.startedAt, event });
      const issue: IssueDetail = {
        id: "ISSUE-20261114-001",
        title: "Query result",
        description: "",
        editVersion: "a".repeat(64),
        priority: "p1",
        type: "defect_fix",
        status: "pending",
        assignee: null,
        assigneeSubject: null,
        service: { key: "example", name: "Example" },
        updatedAt: entry.startedAt,
        repositories: [],
        attachments: [],
        comments: [],
        environmentKey: "dev",
        workingDirectory: "/fixture/workspaces/issue",
        workspace: { status: "ready", sourceAvailable: false },
      };
      const view = render(() => <ConversationItem issue={issue} entry={projection.snapshot()[0]!} />);
      try {
        expect(view.container.querySelector("pre, table, .agent-query-result")).toBeNull();
        const card = view.container.querySelector("details")!;
        card.open = true;
        fireEvent(card, new Event("toggle"));
        await screen.findByRole("table");
        expect(screen.getAllByRole("cell")[1]!.textContent).toBe("hello");
        card.open = false;
        fireEvent(card, new Event("toggle"));
        await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
      } finally {
        view.unmount();
      }
    });
});
