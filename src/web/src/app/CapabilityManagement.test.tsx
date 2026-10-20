import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { Person, McpServersInput } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, load: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, configuration: () => ({ services: [] }), refreshConfiguration: async () => {} }) }));
vi.mock("../data/client", async original => ({
  ...await original<typeof import("../data/client")>(),
  loadCapabilitySwitches: async () => ["nacos", "db", "redis", "mq", "es", "dms", "sls"].map(key => ({ key, enabled: true })),
  loadMcpServices: async () => [{ id: "external", name: "External", transport: "streamable_http", url: "https://example.test/mcp", enabled: true, credentialConfigured: true }],
  loadMcpServiceConfiguration: state.load,
}));
import { CapabilityManagement } from "./CapabilityManagement";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("keeps an MCP draft when user details refresh without an identity or permission change", async () => {
  const original: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer", isAdmin: true };
  const [user, setUser] = createSignal(original, { ownedWrite: true }); state.user = user;
  state.load.mockResolvedValue({ mcpServers: { External: { url: "https://example.test/mcp" } } });
  render(() => <CapabilityManagement />);
  fireEvent.click(await within(screen.getByRole("region", { name: "外部能力管理" })).findByRole("button", { name: "配置" }));
  const input = await screen.findByLabelText("mcpServers JSON");
  await waitFor(() => expect(input).toHaveProperty("value", JSON.stringify({ mcpServers: { External: { url: "https://example.test/mcp" } } }, null, 2)));
  fireEvent.input(input, { target: { value: '{"mcpServers":{"draft":{"command":"unsaved-command"}}}' } });
  setUser({ ...original, name: "Updated Alice" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole("dialog", { name: "编辑 MCP" })).toBeTruthy();
  expect(input).toHaveProperty("value", '{"mcpServers":{"draft":{"command":"unsaved-command"}}}');
});

for (const loaded of [false, true]) it(`clears ${loaded ? "loaded" : "pending"} private MCP configuration when the same user's role changes`, async () => {
  const original: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer", isAdmin: true };
  const [user, setUser] = createSignal(original, { ownedWrite: true }); state.user = user;
  const configuration: McpServersInput = { mcpServers: { External: { url: "https://example.test/mcp", headers: { Authorization: "Bearer old-private-token" } } } };
  let finish!: (value: McpServersInput) => void;
  state.load.mockImplementationOnce(() => new Promise<McpServersInput>(resolve => { finish = resolve; }));
  render(() => <CapabilityManagement />);
  try {
    const external = screen.getByRole("region", { name: "外部能力管理" });
    fireEvent.click(await within(external).findByRole("button", { name: "配置" }));
    await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
    if (loaded) {
      finish(configuration);
      await waitFor(() => expect(screen.getByLabelText("mcpServers JSON")).toHaveProperty("value", JSON.stringify(configuration, null, 2)));
    }
    setUser({ ...original, role: "product", isAdmin: false });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑 MCP" })).toBeNull());
    finish(configuration); await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByLabelText("mcpServers JSON")).toBeNull();
    expect(document.body.textContent).not.toContain("old-private-token");
  } finally { finish?.(configuration); }
});
