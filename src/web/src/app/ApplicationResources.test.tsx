import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  return {
    ...actual,
    loadCatalog: vi.fn(async () => ({ environments: [], services: [] })),
    loadConfig: vi.fn(),
    loadUsers: vi.fn(async () => []),
    loadPeople: vi.fn(async () => []),
    loadCurrentUser: vi.fn(async () => ({ subject: "user", name: "User", email: "user@example.test" })),
  };
});

import type { Config } from "../data/client";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const configuration = (name: string): Config => ({
  agentModels: [],
  environments: [],
  services: [{ key: "orders", revision: name.padEnd(64, "0").slice(0, 64), name, description: "", repositories: [], deployments: [] }],
});

describe("application configuration resources", () => {
  afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

  it("allows only the latest configuration request to commit state or errors", async () => {
    let resources!: ReturnType<typeof useApplicationResources>;
    const Probe = () => { resources = useApplicationResources(); return <span data-testid="service-name">{resources.configuration().services[0]?.name ?? "empty"}</span>; };
    const view = render(() => <ApplicationResourcesProvider><Probe /></ApplicationResourcesProvider>);
    const client = await import("../data/client");
    const first = deferred<Config>();
    const second = deferred<Config>();
    vi.mocked(client.loadConfig).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

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
    vi.mocked(client.loadConfig).mockImplementationOnce(() => staleFailure.promise).mockImplementationOnce(() => finalRequest.promise);
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
