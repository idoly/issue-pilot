import assert from "node:assert/strict";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEngine } from "../../src/agent/engine.ts";
import { sessionTranscript } from "../../src/agent/events.ts";
import { appendAgentMessage } from "../../src/agent/message-delivery.ts";
import { assertSessionFileComplete, createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { issueSessionHistory, resetIssueSession } from "../../src/agent/session-reset.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService } from "../http/fixture.ts";

const subject = issuePilotConfig.bootstrapUser.subject;

async function fixture() {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  await createService(f.app, "Recovery");
  const created = await createIssue(f.app, "recovery");
  f.engine.running.clear();
  const [issue] = await database.db
    .select()
    .from(issues)
    .where(eq(issues.key, String(created.id)));
  assert.ok(issue);
  const directory = issueRoot(f.root, issue.key);
  const manager = await createPrivateSessionManager(directory, directory);
  const request = { id: "before-crash", subject };
  appendAgentMessage(manager, { serviceId: issue.serviceId, environmentId: issue.environmentId }, "input accepted before the crash", [], request, "started");
  await database.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: manager.getSessionFile()!, workspacePath: directory });
  return {
    ...f,
    database,
    issue,
    directory,
    manager,
    request,
    async cleanup() {
      await database.close();
      await f.cleanup();
    },
  };
}

for (const damage of ["missing-final-newline", "partial-append"] as const)
  test(`reset recovers a transcript with ${damage}, keeps it as evidence and admits the next message`, async () => {
    const f = await fixture();
    try {
      const oldFile = f.manager.getSessionFile()!;
      if (damage === "missing-final-newline") {
        // Pi's append was cut after its bytes but before the terminating newline.
        const complete = await readFile(oldFile);
        await writeFile(oldFile, complete.subarray(0, complete.length - 1));
      } else {
        // Pi's append itself stopped mid-record.
        await appendFile(oldFile, '{"type":"message","id":"partial-tail"');
      }
      const damaged = await readFile(oldFile);
      await assert.rejects(assertSessionFileComplete(oldFile), { message: "agent_session_file_incomplete" });
      const before = await issueSessionHistory(f.database.db, f.root, f.issue);
      assert.equal(before.length, 1);
      assert.equal(before[0]!.incomplete, true, "history must state that the current file is unreadable");

      const reset = await resetIssueSession(f.database.db, f.root, f.issue, subject, f.manager.getSessionId());
      assert.notEqual(reset.sessionId, f.manager.getSessionId());
      assert.deepEqual(await readFile(oldFile), damaged, "the cut-off transcript stays byte-for-byte as evidence");
      assert.equal((await readdir(f.directory)).filter((name) => name.startsWith(".session-")).length, 2);

      const [binding] = await f.database.db.select().from(agentSessions).where(eq(agentSessions.issueId, f.issue.id));
      assert.ok(binding);
      assert.notEqual(binding.sessionFile, oldFile);
      await assertSessionFileComplete(binding.sessionFile);
      const history = await issueSessionHistory(f.database.db, f.root, f.issue);
      assert.deepEqual(
        history.map(({ current, incomplete }) => ({ current, incomplete })),
        [
          { current: true, incomplete: false },
          { current: false, incomplete: true },
        ],
      );

      const engine = new AgentEngine(f.database.db, f.root);
      let scheduled = 0;
      (engine as unknown as { run(): Promise<void> }).run = async () => {
        scheduled++;
      };
      try {
        assert.deepEqual(await engine.messageReceipt(f.issue, f.request, async () => {}), { state: "started" });
        await engine.send(f.issue.id, "input accepted before the crash", undefined, [], undefined, f.request);
        await assert.rejects(engine.send(f.issue.id, "changed input", undefined, [], undefined, f.request), { message: "agent_message_id_conflict" });
        assert.equal(engine.isRunning(f.issue.id), false, "an archived receipt must never schedule its input again");

        const next = { id: "after-crash", subject };
        // Absence in a damaged archive cannot resolve an uncertain response.
        await assert.rejects(
          engine.messageReceipt(f.issue, next, async () => {}),
          { message: "agent_session_file_incomplete" },
        );
        await engine.send(f.issue.id, "input after the reset", undefined, [], undefined, next);
        const [current] = await f.database.db.select().from(agentSessions).where(eq(agentSessions.issueId, f.issue.id));
        assert.equal(current!.sessionFile, binding.sessionFile);
        assert.deepEqual(
          sessionTranscript(SessionManager.open(binding.sessionFile), f.issue.id).map(({ event }) => event),
          [{ type: "issue_user", message: "input after the reset" }],
        );
        assert.deepEqual(await engine.messageReceipt(f.issue, next, async () => {}), { state: "queued" });
        await engine.close();
        assert.equal(scheduled, 1);
        // The unreadable predecessor is still untouched after the new admission.
        assert.deepEqual(await readFile(oldFile), damaged);
      } finally {
        await engine.close();
      }
    } finally {
      await f.cleanup();
    }
  });

test("reset still refuses a transcript whose header identity cannot be verified", async () => {
  const f = await fixture();
  try {
    const oldFile = f.manager.getSessionFile()!;
    // Damage the very first record; the expected identity cannot be established from it.
    await writeFile(oldFile, '{"type":"session","id":');
    const bytes = await readFile(oldFile);
    await assert.rejects(resetIssueSession(f.database.db, f.root, f.issue, subject, f.manager.getSessionId()), { message: "agent_session_file_incomplete" });
    assert.deepEqual(await readFile(oldFile), bytes);
    const [binding] = await f.database.db.select().from(agentSessions).where(eq(agentSessions.issueId, f.issue.id));
    assert.equal(binding!.sessionFile, oldFile);
    assert.equal((await readdir(f.directory)).filter((name) => name.startsWith(".session-")).length, 1);
  } finally {
    await f.cleanup();
  }
});
