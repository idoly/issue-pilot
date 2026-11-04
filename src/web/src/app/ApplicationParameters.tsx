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
const numberFields: Array<{ key: NumberKey; label: string; unit: "count" | "seconds" | "minutes" | "hours" | "mib"; note: string; minimum?: number }> = [
  { key: "maxConcurrentIssues", label: "同时运行的工单", unit: "count", note: "调高后排队工单立即开始；调低不中断正在运行的轮次。" },
  { key: "modelResponseIdleMs", label: "模型响应超时", unit: "seconds", note: "超过该时间没有输出即判定失败，从下一轮开始生效。" },
  { key: "workspaceRetentionMs", label: "工作区保留时长", unit: "hours", note: "已解决工单的工作区超过该时长后可在维护时回收。" },
  { key: "workspaceHighWaterBytes", label: "磁盘高水位", unit: "mib", note: "总占用超过高水位时按时间回收，0 表示不按占用回收。", minimum: 0 },
  { key: "workspaceTargetBytes", label: "回收目标", unit: "mib", note: "按占用回收时降到该值以下，需小于高水位。", minimum: 0 },
  { key: "workspaceMaintenanceIntervalMs", label: "维护周期", unit: "minutes", note: "0 表示不自动维护；修改后重新计时。", minimum: 0 },
  { key: "capabilityConnectionMs", label: "外部连接超时", unit: "seconds", note: "SLS CLI 等外部连接的建立超时。" },
  { key: "mcpExecutionMs", label: "MCP 调用超时", unit: "seconds", note: "外部 MCP 单次调用与工具发现的超时。" },
  { key: "dmsExecutionMs", label: "DMS 查询超时", unit: "seconds", note: "DMS MCP 单次查询的超时。" },
  { key: "slsExecutionMs", label: "SLS 查询超时", unit: "seconds", note: "SLS CLI 单次查询的超时。" },
];
const listFields: Array<{ key: ListKey; label: string; note: string }> = [
  { key: "dingtalkAttachmentHosts", label: "钉钉附件主机", note: "只从这些 HTTPS 主机下载附件，每行一个。" },
  { key: "networkAllowedDomains", label: "Agent 网络基础白名单", note: "本地命令可访问的域名，每行一个；个人组可选择追加更多。" },
];
const unitDivisors: Record<string, number> = { count: 1, seconds: 1_000, minutes: minute, hours: hour, mib };
const unitPlaceholders: Record<string, string> = { count: "例如 10", seconds: "例如 300", minutes: "例如 15", hours: "例如 168", mib: "例如 20480" };

function display(value: number, unit: string): string {
  return String(Math.round(value / unitDivisors[unit]!));
}

function parse(text: string, unit: string, bounds: { minimum: number; maximum: number }): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim()) * unitDivisors[unit]!;
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
    const unit = (key: NumberKey) => numberFields.find((field) => field.key === key)!.unit;
    setState(value);
    setNumbers(Object.fromEntries(numberFields.map((field) => [field.key, display(value.values[field.key], unit(field.key))])) as Partial<Record<NumberKey, string>>);
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
      const value = parse(numbers()[field.key] ?? "", field.unit, bounds);
      if (value === null) {
        setError(
          `${field.label} 需为 ${field.minimum ?? Math.ceil(bounds.minimum / unitDivisors[field.unit]!)} 到 ${Math.floor(bounds.maximum / unitDivisors[field.unit]!)} 之间的整数（${field.unit === "count" ? "个" : field.unit === "seconds" ? "秒" : field.unit === "minutes" ? "分钟" : field.unit === "hours" ? "小时" : "MiB"}）。`,
        );
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
    <section class="user-management-card" aria-label="运行参数">
      <header class="user-management-header">
        <div>
          <strong>运行参数</strong>
          <span>保存后立即生效，无需重启应用；修改不会中断正在运行的工单。</span>
        </div>
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
          <div class="parameters-grid">
            <For each={numberFields}>
              {(field) => (
                <label>
                  <span>{field.label}</span>
                  <Input
                    aria-label={field.label}
                    inputmode="numeric"
                    value={numbers()[field.key] ?? ""}
                    placeholder={unitPlaceholders[field.unit]}
                    disabled={loading() || saving()}
                    onInput={(event) => setNumbers((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                  <small>{field.note}</small>
                </label>
              )}
            </For>
            <For each={listFields}>
              {(field) => (
                <label class="parameters-wide">
                  <span>{field.label}</span>
                  <textarea
                    class="parameters-textarea"
                    aria-label={field.label}
                    rows={4}
                    value={lists()[field.key] ?? ""}
                    disabled={loading() || saving()}
                    onInput={(event) => setLists((current) => ({ ...current, [field.key]: event.currentTarget.value }))}
                  />
                  <small>{field.note}</small>
                </label>
              )}
            </For>
          </div>
          <div class="parameters-actions">
            <Button type="primary" loading={saving()} disabled={loading()} onClick={() => void save()}>
              保存参数
            </Button>
            <span>未填写的项使用项目根配置的默认值。</span>
          </div>
        </Show>
      </Show>
    </section>
  );
}
