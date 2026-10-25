import { createEffect, createSignal, For, Show } from "solid-js";
import { ConfigurationView } from "./ConfigurationView";
import { useApplicationResources } from "./ApplicationResources";
import { EndpointConfiguration } from "./EndpointConfiguration";
import { RepositoryManagement } from "./RepositoryManagement";
import { PersonalCredentials } from "./PersonalCredentials";
import { UserManagement } from "./UserManagement";
import { Button } from "../ui";

type SettingsPanel = "users" | "services" | "repositories" | "endpoints";
const settingsPanels: Array<{ key: SettingsPanel; label: string }> = [
  { key: "users", label: "用户" },
  { key: "repositories", label: "仓库" },
  { key: "services", label: "服务" },
  { key: "endpoints", label: "端点" },
];
export function SettingsView() {
  const { configurationLoaded, configurationError, refreshConfiguration } = useApplicationResources();
  let configurationRequested = false;
  createEffect(() => configurationLoaded(), loaded => {
    if (loaded || configurationRequested) return;
    configurationRequested = true;
    void refreshConfiguration().catch(() => undefined);
  });
  const [serviceKey, setServiceKey] = createSignal("", { ownedWrite: true });
  const [selectedPanel, setSelectedPanel] = createSignal<SettingsPanel>("users", { ownedWrite: true });
  return <main class="settings-view">
    <nav class="settings-tabs" role="tablist" aria-label="配置分类"><For each={settingsPanels}>{panel => <button type="button" role="tab" aria-selected={selectedPanel() === panel.key ? "true" : "false"} class={selectedPanel() === panel.key ? "selected" : ""} onClick={() => setSelectedPanel(panel.key)}>{panel.label}</button>}</For></nav>
    <Show when={configurationError()}>{message => <div class="user-management-error" role="alert">{message()}<Button size="small" onClick={() => { void refreshConfiguration().catch(() => undefined); }}>重试</Button></div>}</Show>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "users"}><PersonalCredentials /><UserManagement /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "endpoints"}><EndpointConfiguration /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "repositories"}><RepositoryManagement onSelectService={key => { setServiceKey(key); setSelectedPanel("services"); }} /></div>
    <div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "services"}><ConfigurationView selectedServiceKey={serviceKey()} onSelectService={key => setServiceKey(key)} /></div>
  </main>;
}
