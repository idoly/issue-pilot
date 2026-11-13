import { type Accessor, type ParentProps, createContext, createEffect, createSignal, onCleanup, useContext } from "solid-js";

import { currentUserSubject, errorMessage, loadCatalog, loadConfig, loadCurrentUser, loadUsers, setCurrentUserSubject, type Config, type ConfigCatalog, type Person } from "../data/client";
import { createLatestTask } from "../data/latest";
import { AgentDraftStore } from "./agent-drafts";

const emptyCatalog = (): ConfigCatalog => ({ environments: [], services: [] });
const emptyConfiguration = (): Config => ({
  agent: { provider: "", model: "", thinkingLevel: "off", codemode: "on", runtime: {}, apiKeyConfigured: false },
  environments: [],
  services: [],
  agentModels: [],
});

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
  agentDrafts: AgentDraftStore;
}

const ResourcesContext = createContext<ApplicationResources>();

function latestLoader<Value>(load: (signal: AbortSignal) => Promise<Value>, apply: (value: Value) => void, reportError: (message: string) => void): () => Promise<Value> {
  const latest = createLatestTask();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    latest.cancel();
  });
  return async () => {
    if (disposed) throw new DOMException("Application resources were disposed", "AbortError");
    const request = latest.begin();
    try {
      const value = await load(request.signal);
      if (request.isCurrent()) {
        apply(value);
        reportError("");
      }
      return value;
    } catch (error) {
      if (request.isCurrent()) reportError(errorMessage(error));
      throw error;
    } finally {
      request.finish();
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

  const agentDrafts = new AgentDraftStore();
  // Drafts live in application resources; warn before a reload or tab close discards them.
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!agentDrafts.hasPending()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    agentDrafts.clearAll();
  });
  let lastSubject: string | null | undefined;
  createEffect(
    () => currentUser()?.subject ?? null,
    (subject) => {
      if (lastSubject !== undefined && subject !== lastSubject) agentDrafts.clearAll();
      lastSubject = subject;
    },
  );

  const refreshCatalog = latestLoader(loadCatalog, setCatalog, setCatalogError);
  const refreshConfiguration = latestLoader(
    loadConfig,
    (value) => {
      setConfiguration(value);
      setConfigurationLoaded(true);
    },
    setConfigurationError,
  );
  const peopleTask = createLatestTask();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    peopleTask.cancel();
  });
  const refreshPeople = async () => {
    if (disposed) throw new DOMException("Application resources were disposed", "AbortError");
    const request = peopleTask.begin();
    try {
      const users = await loadUsers(request.signal);
      if (!request.isCurrent()) return users;
      if (currentUserSubject() && !users.some((user) => user.subject === currentUserSubject())) {
        setCurrentUser(null);
        setCurrentUserSubject(null, false);
      }
      const currentUser = await loadCurrentUser(request.signal);
      if (!request.isCurrent()) return users;
      // Pin the resolved identity without replacing another tab's remembered choice.
      setCurrentUserSubject(currentUser.subject, false);
      setPeople(users);
      setCurrentUser(currentUser);
      setPeopleError("");
      return users;
    } catch (error) {
      if (request.isCurrent()) setPeopleError(errorMessage(error));
      throw error;
    } finally {
      request.finish();
    }
  };
  const selectCurrentUser = (subject: string) => {
    const user = people().find((candidate) => candidate.subject === subject);
    if (!user) return;
    peopleTask.cancel();
    setCurrentUserSubject(subject);
    setCurrentUser(user);
  };

  void refreshCatalog().catch(() => undefined);
  void refreshPeople().catch(() => undefined);

  return (
    <ResourcesContext
      value={{
        catalog,
        configuration,
        configurationLoaded,
        people,
        currentUser,
        catalogError,
        configurationError,
        peopleError,
        refreshCatalog,
        refreshConfiguration,
        refreshPeople,
        selectCurrentUser,
        agentDrafts,
      }}
    >
      {props.children}
    </ResourcesContext>
  );
}

export function useApplicationResources(): ApplicationResources {
  return useContext(ResourcesContext);
}
