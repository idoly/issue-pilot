import assert from "node:assert/strict";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createService, issuePayload, json } from "./fixture.ts";

const bootstrapHeaders = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("manages active users in SQLite without rewriting historical identities", async () => {
  const fixture = await createApiFixture();
  try {
    const created = await fixture.app.inject({ method: "POST", url: "/api/users", headers: bootstrapHeaders, payload: {
      subject: "operator@example.test",
      name: "Operator",
      email: "operator@example.test",
    } });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(await json(created), {
      subject: "operator@example.test",
      name: "Operator",
      email: "operator@example.test",
      active: true,
      createdAt: (await json(created)).createdAt,
      updatedAt: (await json(created)).updatedAt,
    });

    const activeResponse = await fixture.app.inject({ method: "GET", url: "/api/users" });
    const active = JSON.parse(activeResponse.body) as Array<{ subject: string }>;
    assert.equal(activeResponse.headers["cache-control"], "private, no-store");
    assert.deepEqual(active.map((user) => user.subject), ["operator@example.test", issuePilotConfig.bootstrapUser.subject]);
    const selected = await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "operator@example.test" } });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.headers["cache-control"], "private, no-store");
    await createService(fixture.app, "Alpha");
    const issue = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: bootstrapHeaders, payload: { ...issuePayload("alpha"), assigneeSubject: "operator@example.test" } });
    assert.equal(issue.statusCode, 201, issue.body);
    const issueKey = String((await json(issue)).id);

    const disabled = await fixture.app.inject({ method: "PATCH", url: "/api/users/operator%40example.test", headers: bootstrapHeaders, payload: {
      name: "Operations",
      email: "operations@example.test",
      active: false,
    } });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.deepEqual(await json(disabled), {
      subject: "operator@example.test",
      name: "Operations",
      email: "operations@example.test",
      active: false,
      createdAt: (await json(disabled)).createdAt,
      updatedAt: (await json(disabled)).updatedAt,
    });
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "operator@example.test" } })).statusCode, 400);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/users" })).body.includes("operator@example.test"), false);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issueKey}`, headers: bootstrapHeaders });
    assert.equal(detail.statusCode, 200);
    assert.equal((await json(detail)).assignee, "Operations");
    const inactiveAssignment = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: bootstrapHeaders, payload: { ...issuePayload("alpha"), assigneeSubject: "operator@example.test" } });
    assert.equal(inactiveAssignment.statusCode, 400);
    assert.equal((await json(inactiveAssignment)).error, "invalid_subject");

    const managed = await fixture.app.inject({ method: "GET", url: "/api/users/manage", headers: bootstrapHeaders });
    assert.equal(managed.statusCode, 200);
    assert.equal(managed.headers["cache-control"], "private, no-store");
    const managedUsers = JSON.parse(managed.body) as Array<{ subject: string; active: boolean }>;
    assert.deepEqual(managedUsers.map(({ subject, active }) => ({ subject, active })), [
      { subject: issuePilotConfig.bootstrapUser.subject, active: true },
      { subject: "operator@example.test", active: false },
    ]);

    const lastActive = await fixture.app.inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(issuePilotConfig.bootstrapUser.subject)}`, headers: bootstrapHeaders, payload: {
      name: issuePilotConfig.bootstrapUser.name,
      email: issuePilotConfig.bootstrapUser.email,
      active: false,
    } });
    assert.equal(lastActive.statusCode, 409);
    assert.equal((await json(lastActive)).error, "last_active_user");
  } finally {
    await fixture.cleanup();
  }
});

test("validates managed user input and preserves immutable subjects", async () => {
  const fixture = await createApiFixture();
  try {
    for (const [payload, error] of [
      [{ subject: "bad subject", name: "Bad", email: "bad@example.test" }, "invalid_user_subject"],
      [{ subject: "valid-user", name: "", email: "valid@example.test" }, "invalid_user_name"],
      [{ subject: "valid-user", name: "Valid", email: "not-an-email" }, "invalid_user_email"],
    ] as const) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/users", headers: bootstrapHeaders, payload });
      assert.equal(response.statusCode, 400);
      assert.equal((await json(response)).error, error);
    }
    const missing = await fixture.app.inject({ method: "PATCH", url: "/api/users/missing-user", headers: bootstrapHeaders, payload: { name: "Missing", email: "missing@example.test", active: true } });
    assert.equal(missing.statusCode, 404);
    const duplicate = await fixture.app.inject({ method: "POST", url: "/api/users", headers: bootstrapHeaders, payload: { ...issuePilotConfig.bootstrapUser } });
    assert.equal(duplicate.statusCode, 409);
  } finally {
    await fixture.cleanup();
  }
});
