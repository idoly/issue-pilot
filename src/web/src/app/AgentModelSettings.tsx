import { createSignal, Show } from "solid-js";
import { Button, Skeleton, Tag } from "../ui";
import { updateAgentConfiguration } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { ModelCredentialDialog, modelSummary } from "./ModelCredentialDialog";

export function AgentModelSettings() {
  const { configuration, configurationLoaded, configurationError, currentUser, refreshConfiguration } = useApplicationResources();
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const current = () => configuration().agent;
  const saved = async () => { await refreshConfiguration().catch(() => undefined); setOpen(false); };
  return <Show when={currentUser()?.isAdmin}>
    <section class="user-management-card shared-credentials" aria-label="共享 API Key">
      <header class="user-management-header">
        <div><strong>共享 API Key</strong><span>个人未配置时使用<Show when={configurationLoaded()}> · {modelSummary(current())}</Show></span></div>
        <Show when={configurationLoaded()} fallback={<Show when={!configurationError()}><Skeleton active paragraph={{ rows: 1 }} /></Show>}>
          <span class="settings-row-actions"><Tag color={current().apiKeyConfigured ? "green" : "default"}>{current().apiKeyConfigured ? "已配置" : "未配置"}</Tag><Button size="small" onClick={() => setOpen(true)}>{current().apiKeyConfigured ? "更新凭据" : "设置凭据"}</Button></span>
        </Show>
      </header>
      <Show when={configurationError()}><div role="alert" class="user-management-error">{configurationError()}<Button size="small" onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div></Show>
    </section>
    <ModelCredentialDialog open={open()} title="共享 API Key" models={configuration().agentModels} initial={current()} keyConfigured={current().apiKeyConfigured} onClose={() => setOpen(false)}
      onSave={async (selection, apiKey) => { await updateAgentConfiguration({ ...selection, runtime: current().runtime, ...(apiKey ? { apiKey: { mode: "replace" as const, value: apiKey } } : {}) }); await saved(); }}
      onClear={async () => { await updateAgentConfiguration({ provider: current().provider, model: current().model, thinkingLevel: current().thinkingLevel, codemode: current().codemode, runtime: current().runtime, apiKey: { mode: "clear" } }); await saved(); }} />
  </Show>;
}
