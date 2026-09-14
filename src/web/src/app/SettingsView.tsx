import { Button, Select, Skeleton } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import { errorMessage, updateGlobalAgent, type AgentConfiguration } from "../data/client";
import { ConfigurationView } from "./ConfigurationView";
import { useApplicationResources } from "./ApplicationResources";
import { selectedChoice } from "./IssueForm";
import { UserManagement } from "./UserManagement";

function GlobalModelConfiguration() {
  const { configuration, configurationLoaded, configurationError, refreshConfiguration } = useApplicationResources();
  const [draft, setDraft] = createSignal<AgentConfiguration>({ provider: "", model: "", thinkingLevel: "off" }, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  createEffect(() => configuration().agent, (agent) => { setDraft({ ...agent }); });
  const providers = createMemo(() => [...new Set(configuration().agentModels.map((model) => model.provider))]);
  const models = createMemo(() => configuration().agentModels.filter((model) => model.provider === draft().provider));
  const selectedModel = createMemo(() => models().find((model) => model.id === draft().model));
  const save = async () => {
    setSaving(true); setSaveError("");
    try {
      await updateGlobalAgent(draft());
      await refreshConfiguration();
    } catch (error) {
      const code = errorMessage(error);
      setSaveError(({ agent_model_not_available: "模型当前不可用", agent_thinking_level_not_supported: "模型不支持该思考级别", global_configuration_has_running_issues: "有正在执行的工单，请等待 Agent 结束后再修改模型" } as Record<string, string>)[code] ?? code);
    } finally { setSaving(false); }
  };
  return (
    <main class="global-configuration">
      <Show when={configurationLoaded()} fallback={<section class="user-management-loading"><Skeleton active paragraph={{ rows: 10 }} /></section>}>
        <Show when={configurationError()}>{(value) => <div class="user-management-error" role="alert">{value()}</div>}</Show>
        <section class="global-model-card" aria-label="全局模型">
          <aside class="global-model-summary">
            <span>当前配置</span>
            <strong>{configuration().agent.model}</strong>
            <code>{configuration().agent.provider}</code>
            <dl>
              <div><dt>思考级别</dt><dd>{configuration().agent.thinkingLevel}</dd></div>
              <div><dt>生效范围</dt><dd>全部服务与环境</dd></div>
            </dl>
          </aside>
          <div class="global-model-body">
            <header><strong>调整 Agent 模型</strong><span>保存后用于所有新启动的 Agent 会话</span></header>
            <div class="global-model-form">
              <label><span>模型服务商</span><Select aria-label="全局模型 provider" value={draft().provider} options={providers().map((provider) => ({ value: provider, label: provider }))} onChange={(value) => { const provider = selectedChoice(value, providers()); if (!provider) return; const model = configuration().agentModels.find((candidate) => candidate.provider === provider); if (model) setDraft({ provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]! }); }} /></label>
              <label><span>模型</span><Select aria-label="全局模型 model" value={draft().model} options={models().map((model) => ({ value: model.id, label: model.id }))} onChange={(value) => { const model = models().find((candidate) => candidate.id === value); if (!model) return; const current = draft(); setDraft({ ...current, model: model.id, thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0]! }); }} /></label>
              <label><span>思考级别</span><Select aria-label="全局模型 thinking level" value={draft().thinkingLevel} options={(selectedModel()?.thinkingLevels ?? []).map((level) => ({ value: level, label: level }))} onChange={(value) => { const thinkingLevel = selectedChoice(value, selectedModel()?.thinkingLevels ?? []); if (thinkingLevel) setDraft({ ...draft(), thinkingLevel }); }} /></label>
              <div class="global-model-actions"><span>保存会关闭已有空闲会话；正在执行的工单不会被中断。</span><Button type="primary" loading={saving()} disabled={saving()} onClick={() => { void save(); }}>保存模型</Button></div>
            </div>
            <Show when={saveError()}>{(value) => <div class="form-error" role="alert">{value()}</div>}</Show>
          </div>
        </section>
      </Show>
    </main>
  );
}

type SettingsPanel = "users" | "model" | "services";

const settingsPanels: Array<{ key: SettingsPanel; label: string }> = [
  { key: "users", label: "用户" },
  { key: "model", label: "模型" },
  { key: "services", label: "服务" },
];

export function SettingsView() {
  const { configurationLoaded, refreshConfiguration } = useApplicationResources();
  let configurationRequested = false;
  createEffect(() => configurationLoaded(), (loaded) => {
    if (loaded || configurationRequested) return;
    configurationRequested = true;
    void refreshConfiguration().catch(() => undefined);
  });
  const [selectedPanel, setSelectedPanel] = createSignal<SettingsPanel>("services", { ownedWrite: true });
  return (
    <main class="settings-view">
      <nav class="settings-tabs" role="tablist" aria-label="配置分类">
        <For each={settingsPanels}>{(panel) => <button type="button" role="tab" aria-selected={selectedPanel() === panel.key ? "true" : "false"} class={selectedPanel() === panel.key ? "selected" : ""} onClick={() => setSelectedPanel(panel.key)}>{panel.label}</button>}</For>
      </nav>
      <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "users"}><UserManagement /></div>
      <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "model"}><GlobalModelConfiguration /></div>
      <div class="settings-panel service-settings-panel" role="tabpanel" hidden={selectedPanel() !== "services"}><ConfigurationView /></div>
    </main>
  );
}
