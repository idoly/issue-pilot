import { type Accessor, type ParentProps, createContext, createSignal, useContext } from "solid-js";

import { loadConfig, loadPeople, type Config, type Person } from "../data/client";

const emptyConfiguration = (): Config => ({ agentModels: [], environments: [], capabilityCatalog: [], services: [] });

interface ApplicationResources {
  configuration: Accessor<Config>;
  people: Accessor<Person[]>;
  configurationError: Accessor<string>;
  peopleError: Accessor<string>;
  refreshConfiguration: () => Promise<Config>;
  refreshPeople: () => Promise<Person[]>;
}

const ResourcesContext = createContext<ApplicationResources>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ApplicationResourcesProvider(props: ParentProps) {
  const [configuration, setConfiguration] = createSignal<Config>(emptyConfiguration(), { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const [peopleError, setPeopleError] = createSignal("", { ownedWrite: true });

  const refreshConfiguration = async () => {
    try {
      const value = await loadConfig();
      setConfiguration(value);
      setConfigurationError("");
      return value;
    } catch (error) {
      setConfigurationError(message(error));
      throw error;
    }
  };
  const refreshPeople = async () => {
    try {
      const value = await loadPeople();
      setPeople(value);
      setPeopleError("");
      return value;
    } catch (error) {
      setPeopleError(message(error));
      throw error;
    }
  };

  void refreshConfiguration().catch(() => undefined);
  void refreshPeople().catch(() => undefined);

  return (
    <ResourcesContext value={{ configuration, people, configurationError, peopleError, refreshConfiguration, refreshPeople }}>
      {props.children}
    </ResourcesContext>
  );
}

export function useApplicationResources(): ApplicationResources {
  return useContext(ResourcesContext);
}
