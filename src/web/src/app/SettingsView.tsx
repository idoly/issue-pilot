import { createEffect, createSignal, For, Show } from "solid-js";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/solid/tabs";
import { ApplicationParametersView } from "./ApplicationParameters";
import { ConfigurationView } from "./ConfigurationView";
import { useApplicationResources } from "./ApplicationResources";
import { EndpointConfiguration } from "./EndpointConfiguration";
import { RepositoryManagement } from "./RepositoryManagement";
import { PersonalCredentials } from "./PersonalCredentials";
import { UserManagement } from "./UserManagement";

type SettingsPanel = "users" | "services" | "repositories" | "endpoints" | "parameters";
const settingsPanels: Array<{ key: SettingsPanel; label: string }> = [
  { key: "users", label: "用户" },
  { key: "repositories", label: "仓库" },
  { key: "services", label: "服务" },
  { key: "endpoints", label: "端点" },
  { key: "parameters", label: "参数" },
];
export function SettingsView() {
  const { configurationLoaded, refreshConfiguration } = useApplicationResources();
  const [serviceKey, setServiceKey] = createSignal("", { ownedWrite: true });
  const [selectedPanel, setSelectedPanel] = createSignal<SettingsPanel>("users", { ownedWrite: true });
  const [visitedPanels, setVisitedPanels] = createSignal<SettingsPanel[]>(["users"], { ownedWrite: true });
  const selectPanel = (panel: SettingsPanel) => {
    setVisitedPanels((current) => (current.includes(panel) ? current : [...current, panel]));
    setSelectedPanel(panel);
  };
  createEffect(
    () => selectedPanel() === "services" && !configurationLoaded(),
    (needed) => {
      if (needed) void refreshConfiguration().catch(() => undefined);
    },
  );
  return (
    <Tabs<SettingsPanel>
      render={(attrs) => <main {...attrs} />}
      class="settings-view"
      value={selectedPanel()}
      onValueChange={(value) => {
        if (value) selectPanel(value);
      }}
    >
      <TabsList class="settings-tabs" aria-label="配置分类">
        <For each={settingsPanels}>
          {(panel) => (
            <TabsTab value={panel.key} class={selectedPanel() === panel.key ? "selected" : ""}>
              {panel.label}
            </TabsTab>
          )}
        </For>
      </TabsList>
      <Show when={visitedPanels().includes("users")}>
        <TabsPanel class="settings-panel users-settings-panel ip-scrollbar" value="users" keepMounted tabindex={0}>
          <PersonalCredentials />
          <UserManagement />
        </TabsPanel>
      </Show>
      <Show when={visitedPanels().includes("endpoints")}>
        <TabsPanel class="settings-panel settings-panel-fixed" value="endpoints" keepMounted>
          <EndpointConfiguration />
        </TabsPanel>
      </Show>
      <Show when={visitedPanels().includes("repositories")}>
        <TabsPanel class="settings-panel repository-settings-panel" value="repositories" keepMounted>
          <RepositoryManagement
            onSelectService={(key) => {
              setServiceKey(key);
              selectPanel("services");
            }}
          />
        </TabsPanel>
      </Show>
      <Show when={visitedPanels().includes("parameters")}>
        <TabsPanel class="settings-panel settings-panel-quiet" value="parameters" keepMounted tabindex={0}>
          <ApplicationParametersView />
        </TabsPanel>
      </Show>
      <Show when={visitedPanels().includes("services")}>
        <TabsPanel class="settings-panel settings-panel-fixed" value="services" keepMounted>
          <ConfigurationView selectedServiceKey={serviceKey()} onSelectService={(key) => setServiceKey(key)} />
        </TabsPanel>
      </Show>
    </Tabs>
  );
}
