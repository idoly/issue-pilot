import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return {
    ...actual,
    loadCatalog: vi.fn(async () => ({ environments: [], services: [] })),
    loadConfig: vi.fn(),
    loadUsers: vi.fn(async () => [{ subject: "user", name: "User", email: "user@example.test" }]),
    loadCurrentUser: vi.fn(async () => ({ subject: "user", name: "User", email: "user@example.test" })),
  };
});

import { currentUserSubject, setCurrentUserSubject, type Config, type Person } from "../data/client";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const configuration = (name: string): Config => ({
  agent: { provider: "provider", model: "model", thinkingLevel: "medium", codemode: "on", runtime: {}, apiKeyConfigured: false },
  agentModels: [],
  environments: [],
  services: [{ revision: 0, key: "orders", name, description: "", repositories: [], deployments: [] }],
});

describe("application configuration resources", () => {
  afterEach(() => {
    cleanup();
    setCurrentUserSubject(null);
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("clears unsent Agent drafts when the selected identity changes", async () => {
    const client = await import("../data/client");
    const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };
    const bob: Person = { subject: "bob", name: "Bob", email: "bob@example.test", role: "product" };
    vi.mocked(client.loadUsers).mockResolvedValueOnce([alice, bob]);
    vi.mocked(client.loadCurrentUser).mockResolvedValueOnce(alice);
    let resources!: ReturnType<typeof useApplicationResources>;
    function Probe() {
      resources = useApplicationResources();
      return null;
    }
    render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("alice"));
    resources.agentDrafts.get("issue").text = "unsent";
    resources.selectCurrentUser("bob");
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("bob"));
    expect(resources.agentDrafts.get("issue").text).toBe("");
  });

  it("warns before leaving the page while an Agent draft is unsent", async () => {
    let resources!: ReturnType<typeof useApplicationResources>;
    function Probe() {
      resources = useApplicationResources();
      return null;
    }
    render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("user"));
    const idle = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    resources.agentDrafts.get("issue").text = "unsent draft";
    const pending = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    resources.agentDrafts.clear("issue");
    const cleared = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleared);
    expect(cleared.defaultPrevented).toBe(false);
  });

  it("pins the resolved default user to this page's requests", async () => {
    let resources!: ReturnType<typeof useApplicationResources>;
    function Probe() {
      resources = useApplicationResources();
      return null;
    }
    render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("user"));
    expect(currentUserSubject()).toBe("user");
  });

  it("releases draft image URLs when application resources are disposed", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    let resources!: ReturnType<typeof useApplicationResources>;
    function Probe() {
      resources = useApplicationResources();
      return null;
    }
    const view = render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    try {
      await waitFor(() => expect(resources.currentUser()?.subject).toBe("user"));
      resources.agentDrafts.get("issue").images.push({ file: new File(["image"], "fixture.png"), url: "blob:disposed-draft" });
      view.unmount();
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:disposed-draft");
      expect(resources.agentDrafts.hasPending()).toBe(false);
    } finally {
      view.unmount();
      revoke.mockRestore();
    }
  });

  it("clears the previous user while resolving an inactive selection's replacement", async () => {
    const client = await import("../data/client");
    const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };
    const bob: Person = { subject: "bob", name: "Bob", email: "bob@example.test", role: "developer" };
    const replacement = deferred<Person>();
    setCurrentUserSubject("alice");
    vi.mocked(client.loadUsers).mockResolvedValueOnce([alice]).mockResolvedValueOnce([bob]);
    vi.mocked(client.loadCurrentUser)
      .mockResolvedValueOnce(alice)
      .mockImplementationOnce(() => replacement.promise);
    let resources!: ReturnType<typeof useApplicationResources>;
    function Probe() {
      resources = useApplicationResources();
      return null;
    }
    render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    try {
      await waitFor(() => expect(resources.currentUser()?.subject).toBe("alice"));
      localStorage.setItem("issue-pilot.current-user", "bob");
      const refresh = resources.refreshPeople();
      await waitFor(() => expect(client.loadCurrentUser).toHaveBeenCalledTimes(2));
      expect(resources.currentUser()).toBeNull();
      expect(currentUserSubject()).toBeNull();
      expect(localStorage.getItem("issue-pilot.current-user")).toBe("bob");
      replacement.resolve(bob);
      await refresh;
      expect(resources.currentUser()?.subject).toBe("bob");
      expect(currentUserSubject()).toBe("bob");
    } finally {
      replacement.resolve(bob);
    }
  });

  it("does not let an unmounted identity load replace another page's selection", async () => {
    const client = await import("../data/client"),
      current = deferred<Person>();
    vi.mocked(client.loadCurrentUser).mockImplementationOnce(() => current.promise);
    const view = render(() => (
      <ApplicationResourcesProvider>
        <span>Loading</span>
      </ApplicationResourcesProvider>
    ));
    await waitFor(() => expect(client.loadCurrentUser).toHaveBeenCalledOnce());
    view.unmount();
    setCurrentUserSubject("bob");
    current.resolve({ subject: "user", name: "User", email: "user@example.test", role: "developer" });
    await current.promise;
    expect(currentUserSubject()).toBe("bob");
  });

  it("allows only the latest configuration request to commit state or errors", async () => {
    let resources!: ReturnType<typeof useApplicationResources>;
    const Probe = () => {
      resources = useApplicationResources();
      return <span data-testid="service-name">{resources.configuration().services[0]?.name ?? "empty"}</span>;
    };
    const view = render(() => (
      <ApplicationResourcesProvider>
        <Probe />
      </ApplicationResourcesProvider>
    ));
    const client = await import("../data/client");
    const first = deferred<Config>();
    const second = deferred<Config>();
    vi.mocked(client.loadConfig)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const staleRequest = resources.refreshConfiguration();
    const latestRequest = resources.refreshConfiguration();
    second.resolve(configuration("latest"));
    await latestRequest;
    await waitFor(() => expect(view.getByTestId("service-name").textContent).toBe("latest"));
    first.resolve(configuration("stale"));
    await staleRequest;
    expect(view.getByTestId("service-name").textContent).toBe("latest");

    const staleFailure = deferred<Config>();
    const finalRequest = deferred<Config>();
    vi.mocked(client.loadConfig)
      .mockImplementationOnce(() => staleFailure.promise)
      .mockImplementationOnce(() => finalRequest.promise);
    const ignoredFailure = resources.refreshConfiguration().catch(() => undefined);
    const finalSuccess = resources.refreshConfiguration();
    finalRequest.resolve(configuration("final"));
    await finalSuccess;
    staleFailure.reject(new Error("stale_failure"));
    await ignoredFailure;
    expect(resources.configuration().services[0]?.name).toBe("final");
    expect(resources.configurationError()).toBe("");
  });
});
