import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { errorMessage, updateGlobalAgent, type AgentConfiguration } from "../data/client";

const saveDelayMs = 500;
const copy = (agent: AgentConfiguration): AgentConfiguration => ({ ...agent, runtime: structuredClone(agent.runtime) });

export function createAgentConfigurationEditor(
  configuration: Accessor<AgentConfiguration>,
  identity: Accessor<string | null>,
  refresh: () => Promise<AgentConfiguration>,
) {
  const [draft, setDraft] = createSignal(copy(untrack(configuration)), { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0;
  let pending: { value: AgentConfiguration; subject: string | null; generation: number } | undefined, failed: typeof pending;
  let timer: ReturnType<typeof setTimeout> | undefined, active = false, disposed = false, subject = untrack(identity);
  createEffect(() => ({ agent: configuration(), subject: identity() }), value => {
    const changedUser = subject !== value.subject; subject = value.subject;
    if (changedUser) { generation++; clearTimeout(timer); timer = undefined; pending = failed = undefined; setError(""); }
    if (changedUser || !active && !pending) setDraft(copy(value.agent));
  });
  const update = (value: AgentConfiguration) => {
    if (JSON.stringify(value) === JSON.stringify(draft())) return;
    setDraft(value); setError(""); failed = undefined;
    pending = { value, subject: identity(), generation };
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void save(); }, saveDelayMs);
  };
  async function save() {
    if (active || !pending || pending === failed) return;
    clearTimeout(timer); timer = undefined;
    const job = pending; pending = undefined;
    if (job.generation !== generation || job.subject !== identity()) return;
    active = true;
    if (!disposed) { setSaving(true); setError(""); }
    try {
      await updateGlobalAgent(job.value);
      if (!disposed && job.generation === generation && job.subject === identity()) {
        // The application resource loader displays refresh failures separately.
        const saved = await refresh().catch(() => undefined);
        if (saved && !disposed && !pending && job.generation === generation && job.subject === identity()) setDraft(copy(saved));
      }
    } catch (cause) {
      if (job.generation === generation && job.subject === identity()) {
        failed = job; pending ??= job;
        if (!disposed) {
          const code = errorMessage(cause);
          setError(({ agent_model_not_available: "模型当前不可用", agent_thinking_level_not_supported: "模型不支持该思考级别", global_configuration_has_running_issues: "有正在执行的工单，请等待 Agent 结束后再修改配置" } as Record<string, string>)[code] ?? code);
        }
      }
    } finally {
      active = false;
      if (!disposed) setSaving(false);
      if (pending && pending !== failed && !timer) void save();
    }
  }
  onCleanup(() => { disposed = true; clearTimeout(timer); timer = undefined; if (pending !== failed) void save(); });
  return { draft, saving, error, update, retry: () => { failed = undefined; void save(); } };
}
