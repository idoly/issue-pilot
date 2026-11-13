import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, PasswordInput, Select, Skeleton } from "../ui";
import { errorMessage, loadApplicationParameters, updateApplicationParameters, type ApplicationParameterEditorState, type ApplicationParameterKey, type ApplicationParameters } from "../data/client";
import { createLatestTask } from "../data/latest";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

type NumberKey = { [Key in ApplicationParameterKey]: ApplicationParameters[Key] extends number ? Key : never }[ApplicationParameterKey];
type ListKey = { [Key in ApplicationParameterKey]: ApplicationParameters[Key] extends readonly string[] ? Key : never }[ApplicationParameterKey];

// Durations are edited in the unit the field declares; sizes in MiB. The stored value is always milliseconds or bytes.
const minute = 60_000,
  hour = 60 * minute,
  mib = 1024 ** 2;
const units = {
  count: { name: "个", divisor: 1, example: "10" },
  seconds: { name: "秒", divisor: 1_000, example: "300" },
  minutes: { name: "分钟", divisor: minute, example: "15" },
  hours: { name: "小时", divisor: hour, example: "168" },
  mib: { name: "MiB", divisor: mib, example: "20480" },
};
const numberFields: Array<{ key: NumberKey; label: string; unit: keyof typeof units; note: string; minimum?: number }> = [
  { key: "maxConcurrentIssues", label: "同时运行的工单", unit: "count", note: "调高放行队列，调低不中断运行" },
  { key: "modelResponseIdleMs", label: "模型响应超时", unit: "seconds", note: "无输出即超时，下次计时生效" },
  { key: "workspaceRetentionMs", label: "工作区保留时长", unit: "hours", note: "已解决工单到期可回收" },
  { key: "workspaceHighWaterBytes", label: "磁盘高水位", unit: "mib", note: "超限按占用回收，0 关闭", minimum: 0 },
  { key: "workspaceTargetBytes", label: "回收目标", unit: "mib", note: "回收到此值以下，须低于高水位", minimum: 0 },
  { key: "workspaceMaintenanceIntervalMs", label: "维护周期", unit: "minutes", note: "保存后重新计时，0 停止定期维护", minimum: 0 },
  { key: "capabilityConnectionMs", label: "SLS 连接超时", unit: "seconds", note: "SLS CLI 建连，下次查询生效" },
  { key: "mcpExecutionMs", label: "MCP 调用超时", unit: "seconds", note: "工具发现与单次调用" },
  { key: "dmsExecutionMs", label: "DMS 查询超时", unit: "seconds", note: "单次 MCP 查询" },
  { key: "slsExecutionMs", label: "SLS 查询超时", unit: "seconds", note: "单次 CLI 查询" },
];
const listKeys = ["dingtalkAttachmentHosts", "networkAllowedDomains"] as const satisfies readonly ListKey[];
const emptySearchDraft = { enabled: false, accountId: "", token: "", clearToken: false };

function parse(text: string, divisor: number, bounds: { minimum: number; maximum: number }): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (divisor === 1 && match[2] !== undefined)) return null;
  // Convert decimal units exactly: floating point multiplication can reject 1.001 seconds or round sub-byte values.
  const fraction = match[2] ?? "";
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(match[1] + fraction) * BigInt(divisor);
  if (scaled % scale !== 0n) return null;
  const value = Number(scaled / scale);
  return Number.isSafeInteger(value) && value >= bounds.minimum && value <= bounds.maximum ? value : null;
}

/** Admin view of the parameters that apply without restart. Values save together so cross-field rules stay consistent. */
export function ApplicationParametersView() {
  const { currentUser, refreshCatalog } = useApplicationResources();
  const [state, setState] = createSignal<ApplicationParameterEditorState | null>(null, { ownedWrite: true });
  const [numbers, setNumbers] = createSignal<Partial<Record<NumberKey, string>>>({}, { ownedWrite: true });
  const [lists, setLists] = createSignal<Partial<Record<ListKey, string>>>({}, { ownedWrite: true });
  const [networkMode, setNetworkMode] = createSignal<ApplicationParameters["networkMode"]>("open", { ownedWrite: true });
  const [searchDraft, setSearchDraft] = createSignal(emptySearchDraft, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [saved, setSaved] = createSignal(false, { ownedWrite: true });
  const latest = createLatestTask();
  const isAdmin = () => currentUser()?.isAdmin === true;
  const busy = () => loading() || saving();
  const apply = (value: ApplicationParameterEditorState) => {
    setState(value);
    setNumbers(Object.fromEntries(numberFields.map((field) => [field.key, String(value.values[field.key] / units[field.unit].divisor)])) as Partial<Record<NumberKey, string>>);
    setLists(Object.fromEntries(listKeys.map((key) => [key, value.values[key].join("\n")])) as Partial<Record<ListKey, string>>);
    setNetworkMode(value.values.networkMode);
    setSearchDraft({ ...emptySearchDraft, enabled: value.issueSearch.enabled, accountId: value.issueSearch.accountId });
  };
  const load = async () => {
    const request = latest.begin();
    setLoading(true);
    setError("");
    setSaved(false);
    try {
      const value = await loadApplicationParameters(request.signal);
      if (request.isCurrent()) {
        apply(value);
        setConflict(false);
      }
    } catch (cause) {
      if (request.isCurrent()) setError(errorMessage(cause));
    } finally {
      if (request.isCurrent()) setLoading(false);
      request.finish();
    }
  };
  const save = async () => {
    const current = state();
    if (!isAdmin() || !current || busy()) return;
    setSaved(false);
    const overrides: Partial<ApplicationParameters> = {};
    if (networkMode() !== current.defaults.networkMode) overrides.networkMode = networkMode();
    for (const field of numberFields) {
      const bounds = current.bounds.numbers[field.key];
      const unit = units[field.unit];
      const text = (numbers()[field.key] ?? "").trim();
      // Some unit conversions repeat in decimal; unchanged fields retain the exact stored milliseconds/bytes.
      const value = text === String(current.values[field.key] / unit.divisor) ? current.values[field.key] : parse(text, unit.divisor, bounds);
      if (value === null) {
        const precision = field.unit === "count" ? "整数" : `数值，且可换算为整数${field.unit === "mib" ? "字节" : "毫秒"}`;
        setError(`${field.label} 需为 ${field.minimum ?? bounds.minimum / unit.divisor} 到 ${bounds.maximum / unit.divisor} 之间的${precision}（${unit.name}）。`);
        return;
      }
      // Unchanged fields stay as the project default so later configuration changes still reach them.
      if (value !== current.defaults[field.key]) (overrides as Record<string, unknown>)[field.key] = value;
    }
    for (const key of listKeys) {
      const entries = (lists()[key] ?? "")
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
      // Same rule as the numbers: an unchanged list keeps following the project default.
      if (entries.join("\n") !== current.defaults[key].join("\n")) (overrides as Record<string, unknown>)[key] = entries;
    }
    const { enabled, accountId, token, clearToken } = searchDraft();
    const search = current.issueSearch;
    const searchChanged = enabled !== search.enabled || (enabled && (accountId.trim() !== search.accountId || Boolean(token.trim()))) || clearToken;
    setSaving(true);
    setError("");
    setConflict(false);
    const request = latest.begin();
    try {
      const value = await updateApplicationParameters({
        expectedRevision: current.revision,
        overrides,
        ...(searchChanged
          ? {
              issueSearch: {
                expectedRevision: search.revision,
                enabled,
                accountId: enabled ? accountId : search.accountId,
                apiToken: enabled ? token.trim() || undefined : clearToken ? null : undefined,
              },
            }
          : {}),
      });
      if (request.isCurrent()) {
        apply(value);
        setSaved(true);
        if (search.enabled !== value.issueSearch.enabled) void refreshCatalog().catch(() => undefined);
      }
    } catch (cause) {
      if (request.isCurrent()) {
        setError(settingsError(cause));
        if (errorMessage(cause) === "configuration_changed") setConflict(true);
      }
    } finally {
      if (request.isCurrent()) setSaving(false);
      request.finish();
    }
  };
  createEffect(
    () => ({ subject: currentUser()?.subject ?? "", admin: isAdmin() }),
    (identity, previous) => {
      if (identity.subject === previous?.subject && identity.admin === previous?.admin) return;
      latest.cancel();
      setState(null);
      setSearchDraft(emptySearchDraft);
      setSaving(false);
      setError("");
      setConflict(false);
      setSaved(false);
      if (identity.subject && identity.admin) void load();
      else setLoading(false);
    },
  );
  onCleanup(() => {
    latest.cancel();
  });
  return (
    <form
      class="user-management-card parameters-card"
      aria-label="运行参数"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header class="user-management-header parameters-header">
        <div>
          <strong>运行参数</strong>
          <span>（保存即生效，不中断运行中的工单）</span>
        </div>
        <div class="parameters-actions">
          <Show when={saved()}>
            <span role="status">参数已保存</span>
          </Show>
          <Show when={isAdmin() && state()}>
            <Button type="primary" htmlType="submit" loading={saving()} disabled={loading()}>
              保存参数
            </Button>
          </Show>
        </div>
      </header>
      <Show when={!isAdmin()}>
        <p class="parameters-hint">只有管理人员可以查看和修改运行参数。</p>
      </Show>
      <Show when={isAdmin()}>
        <Show when={error()}>
          <div role="alert" class="user-management-error">
            {error()}
            <Show when={conflict() || !state()}>
              <Button size="small" onClick={() => void load()}>
                重新加载
              </Button>
            </Show>
          </div>
        </Show>
        <Show
          when={state()}
          fallback={
            <Show when={!error()}>
              <Skeleton active paragraph={{ rows: 6 }} />
            </Show>
          }
        >
          <div class="parameters-grid" role="region" aria-label="参数表单" tabindex={0} onInput={() => setSaved(false)}>
            <For each={numberFields}>
              {(field) => (
                <label>
                  <span>
                    {field.label}
                    <small id={`parameter-note-${field.key}`}>
                      （{units[field.unit].name}；{field.note}）
                    </small>
                  </span>
                  <Input
                    aria-label={field.label}
                    aria-describedby={`parameter-note-${field.key}`}
                    inputmode={field.unit === "count" ? "numeric" : "decimal"}
                    value={numbers()[field.key] ?? ""}
                    placeholder={`例如 ${units[field.unit].example}`}
                    disabled={busy()}
                    onInput={(event) => setNumbers((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                </label>
              )}
            </For>
            <section class="parameter-section" aria-labelledby="parameter-network-title">
              <div class="parameter-description">
                <h3 id="parameter-network-title">工单网络访问</h3>
                <p>控制工单 Agent 可以访问的网络。保存后对新连接生效。</p>
              </div>
              <div class="parameter-controls">
                <Select
                  aria-label="工单网络访问"
                  value={networkMode()}
                  options={[
                    { value: "open", label: "开放网络" },
                    { value: "allowlist", label: "域名白名单" },
                  ]}
                  disabled={busy()}
                  onChange={(mode) => {
                    setSaved(false);
                    setNetworkMode(mode);
                  }}
                />
                <Show when={networkMode() === "allowlist"}>
                  <label>
                    <span>Agent 网络基础白名单</span>
                    <textarea
                      class="parameters-textarea"
                      aria-describedby="parameter-network-note"
                      rows={3}
                      value={lists().networkAllowedDomains ?? ""}
                      placeholder="例如 packages.example.com"
                      disabled={busy()}
                      onInput={(event) => setLists((current) => ({ ...current, networkAllowedDomains: event.currentTarget.value }))}
                    />
                  </label>
                  <small id="parameter-network-note">每行一个域名。全局 Agent 配置可追加域名。</small>
                </Show>
              </div>
            </section>
            <section class="parameter-section" aria-labelledby="parameter-attachment-title">
              <div class="parameter-description">
                <h3 id="parameter-attachment-title">钉钉附件主机</h3>
                <p>导入时，只从列表中的 HTTPS 主机下载附件。</p>
              </div>
              <div class="parameter-controls">
                <textarea
                  class="parameters-textarea"
                  aria-labelledby="parameter-attachment-title"
                  aria-describedby="parameter-attachment-note"
                  rows={3}
                  value={lists().dingtalkAttachmentHosts ?? ""}
                  placeholder="例如 files.example.com"
                  disabled={busy()}
                  onInput={(event) => setLists((current) => ({ ...current, dingtalkAttachmentHosts: event.currentTarget.value }))}
                />
                <small id="parameter-attachment-note">每行一个主机名，无需填写 https:// 或路径。</small>
              </div>
            </section>
            <section class="parameter-section" aria-labelledby="parameter-search-title">
              <div class="parameter-description">
                <h3 id="parameter-search-title">工单搜索</h3>
                <p>启用「查找相似工单」。搜索词，以及用于索引的工单标题和描述，会发送给 Cloudflare。</p>
              </div>
              <div class="parameter-controls">
                <Select
                  aria-label="工单搜索"
                  value={searchDraft().enabled ? "enabled" : "disabled"}
                  options={[
                    { value: "disabled", label: "关闭" },
                    { value: "enabled", label: "启用" },
                  ]}
                  disabled={busy()}
                  onChange={(value) => {
                    setSaved(false);
                    setSearchDraft((current) => ({ ...current, enabled: value === "enabled", clearToken: false }));
                  }}
                />
                <Show when={searchDraft().enabled}>
                  <label>
                    <span>Cloudflare Account ID</span>
                    <Input
                      aria-label="Cloudflare Account ID"
                      placeholder="32 位十六进制"
                      value={searchDraft().accountId}
                      maxlength={32}
                      disabled={busy()}
                      onInput={(event) => setSearchDraft((current) => ({ ...current, accountId: event.currentTarget.value }))}
                    />
                  </label>
                  <label>
                    <span>Cloudflare API Token</span>
                    <PasswordInput
                      aria-label="Cloudflare API Token"
                      aria-describedby="parameter-search-token-note"
                      value={searchDraft().token}
                      placeholder={state()?.issueSearch.tokenConfigured ? "已配置，留空保留" : "填写 API Token"}
                      maxlength={1024}
                      disabled={busy()}
                      onInput={(event) => setSearchDraft((current) => ({ ...current, token: event.currentTarget.value }))}
                    />
                  </label>
                  <small id="parameter-search-token-note">需要 Workers AI Read 权限。更换账号时请同时填写新 Token。</small>
                </Show>
                <Show when={!searchDraft().enabled && state()?.issueSearch.tokenConfigured}>
                  <label class="parameter-check">
                    <input
                      type="checkbox"
                      checked={searchDraft().clearToken}
                      disabled={busy()}
                      onChange={(event) => {
                        setSaved(false);
                        setSearchDraft((current) => ({ ...current, clearToken: event.currentTarget.checked }));
                      }}
                    />
                    <span>清除已保存的 Token</span>
                  </label>
                </Show>
              </div>
            </section>
          </div>
        </Show>
      </Show>
    </form>
  );
}
