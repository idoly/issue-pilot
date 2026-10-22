import { type Accessor, type ParentProps, createContext, createSignal, onCleanup, useContext } from "solid-js";

import { currentUserSubject, errorMessage, loadCatalog, loadConfig, loadCurrentUser, loadUsers, setCurrentUserSubject, type Config, type ConfigCatalog, type Person } from "../data/client";

const emptyCatalog = (): ConfigCatalog => ({ environments: [], services: [] });
const emptyConfiguration = (): Config => ({ agent: { provider: "", model: "", thinkingLevel: "off", codemode: "on", runtime: {} }, environments: [], services: [], agentModels: [] });

interface ApplicationResources {
  catalog: Accessor<ConfigCatalog>;
  configuration: Accessor<Config>;
  configurationLoaded: Accessor<boolean>;
  people: Accessor<Person[]>;
  currentUser: Accessor<Person | null>;
  catalogError: Accessor<string>;
  configurationError: Accessor<string>;
  peopleError: Accessor<string>;
  refreshCatalog: () => Promise<ConfigCatalog>;
  refreshConfiguration: () => Promise<Config>;
  refreshPeople: () => Promise<Person[]>;
  selectCurrentUser: (subject: string) => void;
}

const ResourcesContext = createContext<ApplicationResources>();

function latestLoader<Value>(load: () => Promise<Value>, apply: (value: Value) => void, reportError: (message: string) => void): () => Promise<Value> {
  let generation = 0;
  return async () => {
    const current = ++generation;
    try {
      const value = await load();
      if (current === generation) {
        apply(value);
        reportError("");
      }
      return value;
    } catch (error) {
      if (current === generation) reportError(errorMessage(error));
      throw error;
    }
  };
}

export function ApplicationResourcesProvider(props: ParentProps) {
  const [catalog, setCatalog] = createSignal<ConfigCatalog>(emptyCatalog(), { ownedWrite: true });
  const [configuration, setConfiguration] = createSignal<Config>(emptyConfiguration(), { ownedWrite: true });
  const [configurationLoaded, setConfigurationLoaded] = createSignal(false, { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [currentUser, setCurrentUser] = createSignal<Person | null>(null, { ownedWrite: true });
  const [catalogError, setCatalogError] = createSignal("", { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const [peopleError, setPeopleError] = createSignal("", { ownedWrite: true });

  const refreshCatalog = latestLoader(loadCatalog, setCatalog, setCatalogError);
  const refreshConfiguration = latestLoader(loadConfig, (value) => { setConfiguration(value); setConfigurationLoaded(true); }, setConfigurationError);
  let peopleGeneration = 0, disposed = false;
  onCleanup(() => { disposed = true; peopleGeneration++; });
  const refreshPeople = async () => {
    if (disposed) throw new DOMException("Application resources were disposed", "AbortError");
    const owner = ++peopleGeneration;
    try {
      const users = await loadUsers();
      if (owner !== peopleGeneration) return users;
      if (currentUserSubject() && !users.some((user) => user.subject === currentUserSubject())) {
        setCurrentUser(null);
        setCurrentUserSubject(null, false);
      }
      const currentUser = await loadCurrentUser();
      if (owner !== peopleGeneration) return users;
      // Pin the resolved identity without replacing another tab's remembered choice.
      setCurrentUserSubject(currentUser.subject, false);
      setPeople(users);
      setCurrentUser(currentUser);
      setPeopleError("");
      return users;
    } catch (error) {
      if (owner === peopleGeneration) setPeopleError(errorMessage(error));
      throw error;
    }
  };
  const selectCurrentUser = (subject: string) => {
    const user = people().find((candidate) => candidate.subject === subject);
    if (!user) return;
    peopleGeneration++;
    setCurrentUserSubject(subject);
    setCurrentUser(user);
  };

  void refreshCatalog().catch(() => undefined);
  void refreshPeople().catch(() => undefined);

  return (
    <ResourcesContext value={{ catalog, configuration, configurationLoaded, people, currentUser, catalogError, configurationError, peopleError, refreshCatalog, refreshConfiguration, refreshPeople, selectCurrentUser }}>
      {props.children}
    </ResourcesContext>
  );
}

export function useApplicationResources(): ApplicationResources {
  return useContext(ResourcesContext);
}
