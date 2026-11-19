import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return {
    ...actual,
    loadCatalog: vi.fn<typeof import("../data/client").loadCatalog>(async () => ({ environments: [], services: [] })),
    loadConfig: vi.fn<typeof import("../data/client").loadConfig>(),
    loadUsers: vi.fn<typeof import("../data/client").loadUsers>(async () => [{ subject: "user", name: "User", email: "user@example.test", role: "developer" }]),
    loadCurrentUser: vi.fn<typeof import("../data/client").loadCurrentUser>(async () => ({ subject: "user", name: "User", email: "user@example.test", role: "developer", identityLocked: false })),
  };
});

import { currentUserSubject, setCurrentUserSubject, type Config, type CurrentUser, type Person } from "../data/client";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { settle } from "../test-settle";

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
  agent: { provider: "provider", model: "model", thinkingLevel: "medium", codemode: "on", runtime: {}, apiKeyConfigured: false, revision: 0 },
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
    vi.mocked(client.loadCurrentUser).mockResolvedValueOnce({ ...alice, identityLocked: false });
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

  it("reloads services and people when the page is shown again, at most once per interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const client = await import("../data/client");
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
      await waitFor(() => expect(resources.currentUser()?.role).toBe("developer"));
      expect(client.loadCatalog).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("focus"));
      expect(client.loadCatalog).toHaveBeenCalledTimes(1);
      // Another administrator changed this user's role and added a service meanwhile.
      vi.mocked(client.loadCatalog).mockResolvedValueOnce({ environments: [], services: [{ key: "billing", name: "Billing" }] } as unknown as Awaited<ReturnType<typeof client.loadCatalog>>);
      vi.mocked(client.loadUsers).mockResolvedValueOnce([{ subject: "user", name: "User", email: "user@example.test", role: "product" }]);
      vi.mocked(client.loadCurrentUser).mockResolvedValueOnce({ subject: "user", name: "User", email: "user@example.test", role: "product", identityLocked: false });
      vi.setSystemTime(Date.now() + 31_000);
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(resources.currentUser()?.role).toBe("product"));
      expect(resources.catalog().services.map((service) => service.key)).toEqual(["billing"]);
      expect(client.loadCatalog).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps a deactivated selection pinned until the user explicitly chooses another identity", async () => {
    const client = await import("../data/client");
    const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };
    const bob: Person = { subject: "bob", name: "Bob", email: "bob@example.test", role: "developer" };
    setCurrentUserSubject("alice");
    vi.mocked(client.loadUsers).mockResolvedValueOnce([alice]).mockResolvedValueOnce([bob]);
    vi.mocked(client.loadCurrentUser)
      .mockResolvedValueOnce({ ...alice, identityLocked: false })
      .mockImplementationOnce(async () => {
        expect(currentUserSubject()).toBe("alice");
        throw new Error("invalid_current_subject");
      });
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
    localStorage.setItem("issue-pilot.current-user", "bob");
    await expect(resources.refreshPeople()).rejects.toThrow("invalid_current_subject");
    expect(resources.currentUser()).toBeNull();
    expect(currentUserSubject()).toBe("alice");
    expect(localStorage.getItem("issue-pilot.current-user")).toBe("bob");
    expect(resources.people()).toEqual([bob]);
    expect(resources.peopleError()).not.toBe("");
    resources.selectCurrentUser("bob");
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("bob"));
    expect(currentUserSubject()).toBe("bob");
  });

  it("does not let an unmounted identity load replace another page's selection", async () => {
    const client = await import("../data/client"),
      current = deferred<CurrentUser>();
    vi.mocked(client.loadCurrentUser).mockImplementationOnce(() => current.promise);
    const view = render(() => (
      <ApplicationResourcesProvider>
        <span>Loading</span>
      </ApplicationResourcesProvider>
    ));
    await waitFor(() => expect(client.loadCurrentUser).toHaveBeenCalledOnce());
    view.unmount();
    setCurrentUserSubject("bob");
    current.resolve({ subject: "user", name: "User", email: "user@example.test", role: "developer", identityLocked: false });
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
    expect(vi.mocked(client.loadConfig).mock.calls[0]?.[0]?.aborted).toBe(true);
    expect(vi.mocked(client.loadConfig).mock.calls[1]?.[0]?.aborted).toBe(false);
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

  for (const outcome of ["success", "failure"] as const)
    it(`disposes application reads and ignores their late ${outcome}`, async () => {
      const client = await import("../data/client");
      const catalog = deferred<import("../data/client").ConfigCatalog>();
      const config = deferred<Config>();
      const identity = deferred<CurrentUser>();
      vi.mocked(client.loadCatalog).mockReturnValueOnce(catalog.promise);
      vi.mocked(client.loadConfig).mockReturnValueOnce(config.promise);
      vi.mocked(client.loadCurrentUser).mockReturnValueOnce(identity.promise);
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
      const pending = resources.refreshConfiguration().catch(() => undefined);
      await waitFor(() => expect(client.loadCurrentUser).toHaveBeenCalledOnce());
      view.unmount();
      if (outcome === "success") {
        catalog.resolve({ environments: [], services: [], issueSearchEnabled: true });
        config.resolve(configuration("disposed"));
        identity.resolve({ subject: "disposed", name: "Disposed", email: "disposed@example.test", role: "developer", identityLocked: false });
      } else {
        catalog.reject(new Error("late_catalog"));
        config.reject(new Error("late_config"));
        identity.reject(new Error("late_identity"));
      }
      await pending;
      await settle();
      expect(resources.catalog().issueSearchEnabled).toBeUndefined();
      expect(resources.configurationLoaded()).toBe(false);
      expect(resources.configurationError()).toBe("");
      expect(resources.catalogError()).toBe("");
      expect(resources.peopleError()).toBe("");
      for (const loader of [client.loadConfig, client.loadCatalog, client.loadUsers, client.loadCurrentUser]) {
        expect(vi.mocked(loader).mock.calls[0]?.[0]).toMatchObject({ aborted: true });
      }
      await expect(resources.refreshCatalog()).rejects.toMatchObject({ name: "AbortError" });
      await expect(resources.refreshConfiguration()).rejects.toMatchObject({ name: "AbortError" });
      expect(client.loadCatalog).toHaveBeenCalledOnce();
      expect(client.loadConfig).toHaveBeenCalledOnce();
    });

  it("keeps drafts made while the identity was unresolved until a different person is selected", async () => {
    const client = await import("../data/client");
    const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "product" };
    const bob: Person = { subject: "bob", name: "Bob", email: "bob@example.test", role: "product" };
    // The first load fails (for example during a restart); the page remains usable with no resolved user.
    vi.mocked(client.loadUsers).mockRejectedValueOnce(new Error("service_unavailable")).mockResolvedValue([alice, bob]);
    vi.mocked(client.loadCurrentUser).mockResolvedValue({ ...alice, identityLocked: false });
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
    await waitFor(() => expect(resources.peopleError()).not.toBe(""));
    expect(resources.currentUser()).toBeNull();
    resources.agentDrafts.get("issue").text = "typed while unresolved";
    await resources.refreshPeople();
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("alice"));
    expect(resources.agentDrafts.get("issue").text).toBe("typed while unresolved");
    // A real identity switch still cancels the old person's work.
    resources.selectCurrentUser("bob");
    await waitFor(() => expect(resources.currentUser()?.subject).toBe("bob"));
    expect(resources.agentDrafts.get("issue").text).toBe("");
  });
});
