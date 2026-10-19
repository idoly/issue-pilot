import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";

const mocks = vi.hoisted(() => ({ pin: vi.fn() }));
vi.mock("../data/client", async original => ({
  ...await original<typeof import("../data/client")>(),
  listIssues: async () => ["alice", "bob"].map(subject => ({ id: subject, title: `${subject} task`, assignee: subject, assigneeSubject: subject, service: { key: "orders", name: "Orders" }, environmentKey: "test", type: "smart_analysis", status: "open", priority: "p2", updatedAt: new Date().toISOString(), workspaceStatus: "ready", agentRunning: false, resolvedAt: null } satisfies IssueExecutionItem)),
  listIssuePins: async () => [],
  setIssuePinned: mocks.pin,
}));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({
  catalog: () => ({ services: [], environments: [] }), people: () => [], currentUser: () => undefined, catalogError: () => "", peopleError: () => "",
}) }));
import { IssueQueue } from "./IssueQueue";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

for (const outcome of ["success", "failure"] as const) it(`ignores an old identity's pin ${outcome} while the current identity has a pending pin`, async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  mocks.pin.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finishOld = outcome === "success" ? resolve : () => reject(new Error("old_identity_pin_failed")); }));
  mocks.pin.mockImplementationOnce(() => new Promise<void>(resolve => { finishCurrent = resolve; }));
  const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
  render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "固定 alice" }));
  setSubject("bob");
  const button = await screen.findByRole("button", { name: "固定 bob" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.pin).toHaveBeenCalledTimes(2));
  finishOld();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(button).toHaveProperty("disabled", true);
  expect(screen.queryByText("old_identity_pin_failed")).toBeNull();
  finishCurrent();
  await screen.findByRole("button", { name: "取消固定 bob" });
});
