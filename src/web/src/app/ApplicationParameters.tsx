import { createEffect, createSignal, For, Show } from "solid-js";
import { Button, Input, Skeleton } from "../ui";
import { errorMessage, loadApplicationParameters, updateApplicationParameters, type ApplicationParameterKey, type ApplicationParameterState, type ApplicationParameters } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

type NumberKey = { [Key in ApplicationParameterKey]: ApplicationParameters[Key] extends number ? Key : never }[ApplicationParameterKey];
type ListKey = Exclude<ApplicationParameterKey, NumberKey>;

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
  { key: "capabilityConnectionMs", label: "外部连接超时", unit: "seconds", note: "建立外部连接" },
  { key: "mcpExecutionMs", label: "MCP 调用超时", unit: "seconds", note: "工具发现与单次调用" },
  { key: "dmsExecutionMs", label: "DMS 查询超时", unit: "seconds", note: "单次 MCP 查询" },
  { key: "slsExecutionMs", label: "SLS 查询超时", unit: "seconds", note: "单次 CLI 查询" },
];
const listFields: Array<{ key: ListKey; label: string; note: string }> = [
  { key: "dingtalkAttachmentHosts", label: "钉钉附件主机", note: "每行一个 HTTPS 主机" },
  { key: "networkAllowedDomains", label: "Agent 网络基础白名单", note: "每行一个域名，个人组可追加" },
];

function parse(text: string, divisor: number, bounds: { minimum: number; maximum: number }): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim()) * divisor;
  return Number.isSafeInteger(value) && value >= bounds.minimum && value <= bounds.maximum ? value : null;
}

/** Admin view of the parameters that apply without restart. Values save together so cross-field rules stay consistent. */
export function ApplicationParametersView() {
  const { currentUser } = useApplicationResources();
  const [state, setState] = createSignal<ApplicationParameterState | null>(null, { ownedWrite: true });
  const [numbers, setNumbers] = createSignal<Partial<Record<NumberKey, string>>>({}, { ownedWrite: true });
  const [lists, setLists] = createSignal<Partial<Record<ListKey, string>>>({}, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  let generation = 0;
  const isAdmin = () => currentUser()?.isAdmin === true;
  const apply = (value: ApplicationParameterState) => {
    setState(value);
    setNumbers(Object.fromEntries(numberFields.map((field) => [field.key, String(Math.round(value.values[field.key] / units[field.unit].divisor))])) as Partial<Record<NumberKey, string>>);
    setLists(Object.fromEntries(listFields.map((field) => [field.key, value.values[field.key].join("\n")])) as Partial<Record<ListKey, string>>);
  };
  const load = async () => {
    const owner = ++generation;
    setLoading(true);
    setError("");
    try {
      const value = await loadApplicationParameters();
      if (owner === generation) {
        apply(value);
        setConflict(false);
      }
    } catch (cause) {
      if (owner === generation) setError(errorMessage(cause));
    } finally {
      if (owner === generation) setLoading(false);
    }
  };
  const save = async () => {
    const current = state();
    if (!current || saving()) return;
    const overrides: Partial<ApplicationParameters> = {};
    for (const field of numberFields) {
      const bounds = current.bounds.numbers[field.key];
      const unit = units[field.unit];
      const value = parse(numbers()[field.key] ?? "", unit.divisor, bounds);
      if (value === null) {
        setError(`${field.label} 需为 ${field.minimum ?? Math.ceil(bounds.minimum / unit.divisor)} 到 ${Math.floor(bounds.maximum / unit.divisor)} 之间的整数（${unit.name}）。`);
        return;
      }
      // Unchanged fields stay as the project default so later configuration changes still reach them.
      if (value !== current.defaults[field.key]) (overrides as Record<string, unknown>)[field.key] = value;
    }
    for (const field of listFields) {
      const entries = (lists()[field.key] ?? "")
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
      // Same rule as the numbers: an unchanged list keeps following the project default.
      if (entries.join("\n") !== current.defaults[field.key].join("\n")) (overrides as Record<string, unknown>)[field.key] = entries;
    }
    setSaving(true);
    setError("");
    setConflict(false);
    const owner = generation;
    try {
      const value = await updateApplicationParameters({ expectedRevision: current.revision, overrides });
      if (owner === generation) apply(value);
    } catch (cause) {
      if (owner === generation) {
        setError(settingsError(cause));
        if (errorMessage(cause) === "configuration_changed") setConflict(true);
      }
    } finally {
      if (owner === generation) setSaving(false);
    }
  };
  createEffect(
    () => currentUser()?.subject ?? "",
    (identity, previous) => {
      if (identity === previous || !identity) return;
      generation++;
      setState(null);
      if (isAdmin()) void load();
      else setLoading(false);
    },
  );
  return (
    <section class="user-management-card parameters-card" aria-label="运行参数">
      <header class="user-management-header parameters-header">
        <div>
          <strong>运行参数</strong>
          <span>（保存即生效，不中断运行中的工单）</span>
        </div>
        <Show when={isAdmin() && state()}>
          <Button type="primary" loading={saving()} disabled={loading()} onClick={() => void save()}>
            保存参数
          </Button>
        </Show>
      </header>
      <Show when={!isAdmin()}>
        <p class="parameters-hint">只有管理人员可以查看和修改运行参数。</p>
      </Show>
      <Show when={isAdmin()}>
        <Show when={error()}>
          <div role="alert" class="user-management-error">
            {error()}
            <Show when={conflict()}>
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
          <div class="parameters-grid" role="region" aria-label="参数表单" tabindex={0}>
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
                    inputmode="numeric"
                    value={numbers()[field.key] ?? ""}
                    placeholder={`例如 ${units[field.unit].example}`}
                    disabled={loading() || saving()}
                    onInput={(event) => setNumbers((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                </label>
              )}
            </For>
            <For each={listFields}>
              {(field) => (
                <label>
                  <span>
                    {field.label}
                    <small id={`parameter-note-${field.key}`}>（{field.note}）</small>
                  </span>
                  <textarea
                    class="parameters-textarea"
                    aria-label={field.label}
                    aria-describedby={`parameter-note-${field.key}`}
                    rows={3}
                    value={lists()[field.key] ?? ""}
                    disabled={loading() || saving()}
                    onInput={(event) => setLists((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                </label>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}
