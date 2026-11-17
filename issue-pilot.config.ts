const gibibyte = 1024 ** 3;

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Freezes a configuration literal recursively; one call per section keeps unused sections removable from bundles. */
function deepFreeze<const T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}

// Sections shared with the Web bundle. Keep server-only values (identities, hosts, paths, network policy)
// out of these so the browser build never serializes them.
const regional = deepFreeze({
  locale: "zh-CN",
  timeZone: "Asia/Shanghai",
});

const web = deepFreeze({
  host: "0.0.0.0",
  port: 4173,
  agentStreamReconnectMs: 1_000,
  agentStreamStaleMs: 45_000,
  agentToolOutputCharacters: 40_000,
  filePreviewBytes: 20 * 1024 * 1024,
  sourceAutoSaveDebounceMs: 500,
  sourceRefreshMs: 2_000,
  sourceBlameDebounceMs: 200,
  sourceSearchConcurrency: 3,
  sourceSearchPageMatches: 100,
  sourceSearchDebounceMs: 200,
  sourceDiffMs: 200,
  sourceHighlightCharacters: 200_000,
  markdownCacheEntries: 512,
  markdownCacheCharacters: 4 * 1024 * 1024,
});

const defaults = deepFreeze({
  environments: { prod: "正式", test: "测试", dev: "开发" },
  deployment: { baseBranch: "main" },
});

const limits = deepFreeze({
  filesystemNameBytes: 255,
  // readBytes bounds the whole text file buffered for line paging; responseBytes bounds each returned page.
  mcpServer: {
    // Bound the encoded JSON before parsing; room for a full-size Base64 attachment and metadata.
    requestBytes: 32 * 1024 * 1024,
    responseBytes: 1024 * 1024,
    readBytes: 64 * 1024 * 1024,
    // Inbound MCP is decoded in memory; the HTTP upload path streams to disk and is not bounded here.
    attachmentBytes: 20 * 1024 * 1024,
    attachmentTotalBytes: 20 * 1024 * 1024,
    attachments: 20,
    pageItems: 100,
    textLines: 1000,
  },
  agentMessageChars: 50_000,
  relatedIssues: 20,
  agentImage: {
    fileBytes: 20 * 1024 * 1024,
    requestBytes: 40 * 1024 * 1024,
    files: 20,
  },
  sourceBrowser: {
    directoryEntries: 500,
    fileBytes: 64 * 1024 * 1024,
    searchQueryCharacters: 200,
    searchMatches: 1_000,
    historyCommits: 100,
    changeFiles: 500,
    commandMs: 5_000,
    commandOutputBytes: 2 * 1024 * 1024,
  },
  process: {
    commandOutputBytes: 5 * 1024 * 1024,
    terminationGraceMs: 1_000,
    gitOperationMs: 120_000,
    gitOutputBytes: 2 * 1024 * 1024,
    diskUsageMs: 120_000,
    diskUsageOutputBytes: 1024 * 1024,
  },
  capability: {
    resultBytes: 1024 * 1024,
    dingtalk: { tableFields: 200, descriptionCharacters: 8000, labelCharacters: 512 },
    mcp: { tools: 200 },
    dms: { databases: 20, firstHandshakeMs: 12_000, retryDelayMs: 1_000, maxRetryDelayMs: 5_000 },
    sls: {
      pageResults: 100,
      queryChars: 4096,
      traceIdChars: 36,
      traceWindowSeconds: 24 * 60 * 60,
      defaultWindowSeconds: 15 * 60,
      futureToleranceSeconds: 5 * 60,
    },
  },
});

/** Browser-safe projection. Web code and modules it imports use only this, so the bundle excludes server-only sections. */
export const sharedConfig = deepFreeze({ regional, web, defaults, limits });

// Pure: the Web bundle drops it entirely because browser code imports only sharedConfig.
export const issuePilotConfig = /* @__PURE__ */ deepFreeze({
  state: {
    directory: "data",
    databaseFile: "issues.db",
    sqliteBusyTimeoutMs: 5_000,
  },
  regional,
  bootstrapUser: { role: "developer" as const, isAdmin: true, subject: "yx4821@xianhengguoji.com", name: "严欣", email: "yx4821@xianhengguoji.com" },
  http: {
    // "selectable": the Web header switcher picks any active user (not authentication).
    // "gateway": a trusted gateway supplies identity; the Web hides the switcher and sends no subject header.
    identity: "selectable" as "selectable" | "gateway",
    host: "0.0.0.0",
    port: 3000,
    logger: true,
    sseHeartbeatMs: 15_000,
    sseRecentEventIds: 4_096,
    sseQueuedBytes: 8 * 1024 * 1024,
    // Graceful stop waits for in-flight requests; stalled connections are destroyed after this.
    shutdownGraceMs: 30_000,
  },
  web,
  workspace: {
    taskConcurrency: 4,
    // Leave disabled until the operator has verified local snapshot recovery.
    sharedCheckoutHighWaterBytes: 0,
    sharedCheckoutTargetBytes: 4 * gibibyte,
  },
  // Defaults for parameters admins change under 配置 → 参数; saved values live in SQLite and apply without restart.
  parameters: {
    maxConcurrentIssues: 10,
    modelResponseIdleMs: 5 * 60 * 1000,
    workspaceRetentionMs: 7 * 24 * 60 * 60 * 1000,
    workspaceHighWaterBytes: 20 * gibibyte,
    workspaceTargetBytes: 16 * gibibyte,
    workspaceMaintenanceIntervalMs: 15 * 60 * 1000,
    capabilityConnectionMs: 10_000,
    mcpExecutionMs: 120_000,
    dmsExecutionMs: 120_000,
    slsExecutionMs: 30_000,
    dingtalkAttachmentHosts: ["alidocs2.oss-cn-zhangjiakou.aliyuncs.com"],
    networkMode: "open" as const,
    networkAllowedDomains: ["registry.npmjs.org", "registry.npmmirror.com", "repo.maven.apache.org", "repo1.maven.org", "github.com", "*.githubusercontent.com"],
  },
  defaults,
  runtime: {
    sourceBrowser: { gitExecutable: "git", searchExecutable: "rg" },
  },
  limits,
});
