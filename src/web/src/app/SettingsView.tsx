import { createEffect, createSignal, For, Show } from "solid-js";
import { ConfigurationView } from "./ConfigurationView";
import { useApplicationResources } from "./ApplicationResources";
import { EndpointConfiguration } from "./EndpointConfiguration";
import { RepositoryManagement } from "./RepositoryManagement";
import { PersonalCredentials } from "./PersonalCredentials";
import { SharedCredentials } from "./SharedCredentials";
import { UserManagement } from "./UserManagement";

type SettingsPanel = "users" | "services" | "repositories" | "endpoints";
const settingsPanels: Array<{ key: SettingsPanel; label: string }> = [
  { key: "users", label: "用户" },
  { key: "repositories", label: "仓库" },
  { key: "services", label: "服务" },
  { key: "endpoints", label: "端点" },
];
export function SettingsView() {
  const { configurationLoaded, refreshConfiguration } = useApplicationResources();
  const [serviceKey, setServiceKey] = createSignal("", { ownedWrite: true });
  const [selectedPanel, setSelectedPanel] = createSignal<SettingsPanel>("users", { ownedWrite: true });
  const [visitedPanels, setVisitedPanels] = createSignal<SettingsPanel[]>(["users"], { ownedWrite: true });
  const selectPanel = (panel: SettingsPanel) => {
    setVisitedPanels(current => current.includes(panel) ? current : [...current, panel]);
    setSelectedPanel(panel);
  };
  createEffect(() => selectedPanel() === "services" && !configurationLoaded(), needed => {
    if (needed) void refreshConfiguration().catch(() => undefined);
  });
  return <main class="settings-view">
    <nav class="settings-tabs" role="tablist" aria-label="配置分类"><For each={settingsPanels}>{panel => <button type="button" role="tab" aria-selected={selectedPanel() === panel.key ? "true" : "false"} class={selectedPanel() === panel.key ? "selected" : ""} onClick={() => selectPanel(panel.key)}>{panel.label}</button>}</For></nav>
    <Show when={visitedPanels().includes("users")}><div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "users"}><PersonalCredentials /><SharedCredentials capability="dms" /><SharedCredentials capability="sls" /><UserManagement /></div></Show>
    <Show when={visitedPanels().includes("endpoints")}><div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "endpoints"}><EndpointConfiguration /></div></Show>
    <Show when={visitedPanels().includes("repositories")}><div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "repositories"}><RepositoryManagement onSelectService={key => { setServiceKey(key); selectPanel("services"); }} /></div></Show>
    <Show when={visitedPanels().includes("services")}><div class="settings-panel" role="tabpanel" hidden={selectedPanel() !== "services"}><ConfigurationView selectedServiceKey={serviceKey()} onSelectService={key => setServiceKey(key)} /></div></Show>
  </main>;
}
