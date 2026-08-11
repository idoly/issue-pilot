import { type Accessor, type ParentProps, createContext, createSignal, useContext } from "solid-js";

import { currentUserSubject, errorMessage, loadConfig, loadCurrentUser, loadPeople, loadUsers, setCurrentUserSubject, type Config, type Person } from "../data/client";

const emptyConfiguration = (): Config => ({ agentModels: [], environments: [], capabilityCatalog: [], services: [] });

interface ApplicationResources {
  configuration: Accessor<Config>;
  people: Accessor<Person[]>;
  users: Accessor<Person[]>;
  currentUser: Accessor<Person | null>;
  configurationError: Accessor<string>;
  peopleError: Accessor<string>;
  refreshConfiguration: () => Promise<Config>;
  refreshPeople: () => Promise<Person[]>;
  selectCurrentUser: (subject: string) => void;
}

const ResourcesContext = createContext<ApplicationResources>();

export function ApplicationResourcesProvider(props: ParentProps) {
  const [configuration, setConfiguration] = createSignal<Config>(emptyConfiguration(), { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [users, setUsers] = createSignal<Person[]>([], { ownedWrite: true });
  const [currentUser, setCurrentUser] = createSignal<Person | null>(null, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const [peopleError, setPeopleError] = createSignal("", { ownedWrite: true });

  const refreshConfiguration = async () => {
    try {
      const configuration = await loadConfig();
      setConfiguration(configuration);
      setConfigurationError("");
      return configuration;
    } catch (error) {
      setConfigurationError(errorMessage(error));
      throw error;
    }
  };
  const refreshPeople = async () => {
    try {
      const users = await loadUsers();
      if (currentUserSubject() && !users.some((user) => user.subject === currentUserSubject())) setCurrentUserSubject(null);
      const [people, currentUser] = await Promise.all([loadPeople(), loadCurrentUser()]);
      setUsers(users);
      setPeople(people);
      setCurrentUser(currentUser);
      setPeopleError("");
      return people;
    } catch (error) {
      setPeopleError(errorMessage(error));
      throw error;
    }
  };
  const selectCurrentUser = (subject: string) => {
    const user = users().find((candidate) => candidate.subject === subject);
    if (!user) return;
    setCurrentUserSubject(subject);
    setCurrentUser(user);
  };

  void refreshConfiguration().catch(() => undefined);
  void refreshPeople().catch(() => undefined);

  return (
    <ResourcesContext value={{ configuration, people, users, currentUser, configurationError, peopleError, refreshConfiguration, refreshPeople, selectCurrentUser }}>
      {props.children}
    </ResourcesContext>
  );
}

export function useApplicationResources(): ApplicationResources {
  return useContext(ResourcesContext);
}
