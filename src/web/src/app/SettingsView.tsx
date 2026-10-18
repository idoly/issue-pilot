import { AGENT_CODEMODE_MODES, type AgentPiSettings } from "../../../domain/contracts";
import { Button, Input, Select, Skeleton, Toggle } from "../ui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { ConfigurationView } from "./ConfigurationView";
import { useApplicationResources } from "./ApplicationResources";
import { selectedChoice } from "./IssueForm";
import { EndpointConfiguration } from "./EndpointConfiguration";
import { CapabilityManagement } from "./CapabilityManagement";
import { RepositoryManagement } from "./RepositoryManagement";
import { UserManagement } from "./UserManagement";

function GlobalAgentConfiguration() {
  const { configuration, configurationLoaded, configurationError, refreshConfiguration, agentEditor } = useApplicationResources();
  const { draft, saving, error: saveError, update: updateDraft, retry } = agentEditor;
  const settings = () => draft().runtime.settings ?? {};
  const updateSettings = (update: (value: AgentPiSettings) => AgentPiSettings) => {
    const current = draft();
    updateDraft({ ...current, runtime: { ...current.runtime, settings: update(current.runtime.settings ?? {}) } });
  };
  const providers = createMemo(() => [...new Set(configuration().agentModels.map(model => model.provider))]);
  const models = createMemo(() => configuration().agentModels.filter(model => model.provider === draft().provider));
  const selectedModel = createMemo(() => models().find(model => model.id === draft().model));
  return <main class="global-configuration">
    <Show when={configurationError()}>{value => <div class="user-management-error" role="alert">{value()}<Button size="small" onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div>}</Show>
    <Show when={configurationLoaded()} fallback={<Show when={!configurationError()}><section class="user-management-loading"><Skeleton active paragraph={{ rows: 10 }} /></section></Show>}>
      <section class="global-model-card" aria-label="全局 Agent 基座">
        <div class="global-model-body">
          <div class="global-model-form">
            <label><span>模型服务商</span><Select aria-label="全局模型 provider" value={draft().provider} options={providers().map(provider => ({ value: provider, label: provider }))} onChange={value => { const provider = selectedChoice(value, providers()); if (!provider) return; const model = configuration().agentModels.find(candidate => candidate.provider === provider); if (model) updateDraft({ ...draft(), provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]! }); }} /></label>
            <label><span>模型</span><Select aria-label="全局模型 model" value={draft().model} options={models().map(model => ({ value: model.id, label: model.id }))} onChange={value => { const model = models().find(candidate => candidate.id === value); if (!model) return; const current = draft(); updateDraft({ ...current, model: model.id, thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0]! }); }} /></label>
            <label><span>思考级别</span><Select aria-label="全局模型 thinking level" value={draft().thinkingLevel} options={(selectedModel()?.thinkingLevels ?? []).map(level => ({ value: level, label: level }))} onChange={value => { const thinkingLevel = selectedChoice(value, selectedModel()?.thinkingLevels ?? []); if (thinkingLevel) updateDraft({ ...draft(), thinkingLevel }); }} /></label>
            <label><span>Codemode</span><Select aria-label="全局 Agent Codemode" value={draft().codemode} options={AGENT_CODEMODE_MODES.map(value => ({ value, label: ({ off: "关闭", on: "开启", only: "仅 Codemode" })[value] }))} onChange={value => { const codemode = selectedChoice(value, AGENT_CODEMODE_MODES); if (codemode) updateDraft({ ...draft(), codemode }); }} /></label>
            <label><span>自动压缩上下文</span><Toggle aria-label="自动压缩上下文" checked={settings().compaction?.enabled ?? true} onChange={enabled => updateSettings(value => ({ ...value, compaction: { ...value.compaction, enabled } }))} /></label>
            <label><span>失败自动重试</span><Toggle aria-label="失败自动重试" checked={settings().retry?.enabled ?? true} onChange={enabled => updateSettings(value => ({ ...value, retry: { ...value.retry, enabled } }))} /></label>
            <label><span>最大重试次数</span><Input type="number" min="0" step="1" aria-label="最大重试次数" value={String(settings().retry?.maxRetries ?? 3)} onInput={event => { const number = Number(event.currentTarget.value); if (event.currentTarget.value && Number.isSafeInteger(number) && number >= 0) updateSettings(value => ({ ...value, retry: { ...value.retry, maxRetries: number } })); }} /></label>
            <label><span>缓存预热</span><Select aria-label="缓存预热" value={settings().cacheWarming ?? "streaming"} options={[{ value: "off", label: "关闭" }, { value: "streaming", label: "运行期间" }, { value: "idle", label: "运行及空闲期间" }]} onChange={value => { const cacheWarming = selectedChoice(value, ["off", "streaming", "idle"] as const); if (cacheWarming) updateSettings(settings => ({ ...settings, cacheWarming })); }} /></label>
            <div class="global-model-status" role="status">{saving() ? "保存中…" : saveError() ? "尚未保存" : "修改后自动保存"}</div>
          </div>
          <Show when={saveError()}>{value => <div class="form-error" role="alert">{value()}<Button size="small" onClick={retry}>重试</Button></div>}</Show>
        </div>
      </section>
    </Show>
  </main>;
}

type SettingsPanel = "users" | "base" | "services" | "repositories" | "capabilities" | "endpoints";
const settingsPanels: Array<{ key: SettingsPanel; label: string }> = [
  { key: "base", label: "基座" },
  { key: "users", label: "用户" },
  { key: "capabilities", label: "能力" },
  { key: "repositories", label: "仓库" },
  { key: "services", label: "服务" },
  { key: "endpoints", label: "端点" },
];
export function SettingsView() {
  const { configurationLoaded, refreshConfiguration } = useApplicationResources();
  let configurationRequested = false;
  createEffect(() => configurationLoaded(), loaded => {
    if (loaded || configurationRequested) return;
    configurationRequested = true;
    void refreshConfiguration().catch(() => undefined);
  });
  const [selectedPanel, setSelectedPanel] = createSignal<SettingsPanel>("base", { ownedWrite: true });
  return <main class="settings-view">
    <nav class="settings-tabs" role="tablist" aria-label="配置分类"><For each={settingsPanels}>{panel => <button type="button" role="tab" aria-selected={selectedPanel() === panel.key ? "true" : "false"} class={selectedPanel() === panel.key ? "selected" : ""} onClick={() => setSelectedPanel(panel.key)}>{panel.label}</button>}</For></nav>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "users"}><UserManagement /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "base"}><GlobalAgentConfiguration /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "capabilities"}><CapabilityManagement /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "endpoints"}><EndpointConfiguration /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "repositories"}><RepositoryManagement /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "services"}><ConfigurationView /></div>
  </main>;
}
