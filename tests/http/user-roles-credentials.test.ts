import type { InjectOptions } from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createService, issuePayload } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { userCredentials, subjects } from "../../src/db/schema.ts";
import { ApiError } from "../../src/http/input.ts";
import { registerUserRoutes } from "../../src/http/user-routes.ts";
import { requireCurrentUser, requireDeveloper } from "../../src/http/route-context.ts";

const owner = issuePilotConfig.bootstrapUser.subject;

test("only developers can create development Issues and plan development conversions", async () => {
  const f = await createApiFixture();
  const inject = (input: InjectOptions) => f.app.inject({ ...input, headers: { "x-issue-pilot-subject": owner, ...input.headers } });
  try {
    await createService(f.app, "Roles", ["prod", "test", "dev"]);
    for (const role of ["product", "test", "developer"]) {
      const subject = `${role}@example.test`;
      assert.equal((await inject({ method: "POST", url: "/api/users", payload: { subject, name: role, email: subject, role } })).statusCode, 201);
      const headers = { "x-issue-pilot-subject": subject };
      for (const workMode of ["development_fix", "development_feature", "production_analysis", "test_analysis"]) {
        const response = await inject({ method: "POST", url: "/api/issues", headers, payload: { ...issuePayload("roles"), workMode } });
        assert.equal(response.statusCode, role !== "developer" && workMode.startsWith("development") ? 403 : 201, response.body);
      }
      const created = await inject({ method: "POST", url: "/api/issues", headers, payload: { ...issuePayload("roles"), workMode: "production_analysis" } });
      const key = JSON.parse(created.body).id;
      const plan = await inject({ method: "POST", url: `/api/issues/${key}/scope-transition/plan`, headers, payload: { serviceKey: "roles", workMode: "development_fix" } });
      if (role !== "developer") assert.equal(plan.statusCode, 403, plan.body);
      const dataPlan = await inject({ method: "POST", url: `/api/issues/${key}/scope-transition/plan`, headers, payload: { serviceKey: "roles", workMode: "production_data" } });
      assert.equal(dataPlan.statusCode, 400, dataPlan.body);
      f.engine.running.clear();
      const promoteSelf = await inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(subject)}`, headers, payload: { name: role, email: subject, active: true, role: "developer" } });
      assert.equal(promoteSelf.statusCode, role === "developer" ? 200 : 403, promoteSelf.body);
    }
  } finally { await f.cleanup(); }
});

test("personal credentials are private, independently updated and never returned", async () => {
  const f = await createApiFixture();
  const inject = (input: InjectOptions) => f.app.inject({ ...input, headers: { "x-issue-pilot-subject": owner, ...input.headers } });
  try {
    const second = "second@example.test";
    await inject({ method: "POST", url: "/api/users", payload: { subject: second, name: "Second", email: second, role: "developer", isAdmin: true } });
    const https = await inject({ method: "PUT", url: "/api/me/credentials", payload: { git: { mode: "replace", type: "https", username: "no", token: "no" } } });
    assert.equal(https.statusCode, 400);
    const first = await inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { provider: "fixture", mode: "replace", apiKey: "first-secret" }, git: { mode: "replace", type: "ssh", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-key\n-----END OPENSSH PRIVATE KEY-----" } } });
    assert.equal(first.statusCode, 200, first.body);
    const saveSecond = await inject({ method: "PUT", url: "/api/me/credentials", headers: { "x-issue-pilot-subject": second }, payload: { model: { provider: "fixture", mode: "replace", apiKey: "second-secret" } } });
    assert.equal(saveSecond.statusCode, 200, saveSecond.body);
    for (const url of ["/api/me/credentials", "/api/users", "/api/users/manage", "/api/me", "/api/catalog", "/api/config"]) {
      const response = await inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body.includes("first-secret") || response.body.includes("second-secret") || response.body.includes("fixture-private-key"), false);
    }
    const automatic = await inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { mode: "replace", apiKey: "global-provider-secret" } } });
    assert.equal(automatic.statusCode, 200, automatic.body);
    assert.equal(JSON.parse(automatic.body).provider, "enterprise-ai");
    assert.ok(JSON.parse(automatic.body).modelProviders.includes("enterprise-ai"));
    const cleared = await inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { provider: "fixture", mode: "clear" } } });
    assert.deepEqual(JSON.parse(cleared.body).modelProviders, ["enterprise-ai"]);
    const unchanged = await inject({ method: "GET", url: "/api/me/credentials", headers: { "x-issue-pilot-subject": second } });
    assert.deepEqual(JSON.parse(unchanged.body).modelProviders, ["fixture"]);
    const noElevate = await inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(owner)}`, payload: { name: "Owner", email: owner, active: true, role: "product" } });
    // Another administrator remains, so explicitly changing the owner's role is allowed.
    assert.equal(noElevate.statusCode, 200, noElevate.body);
    const productionOnly = await inject({ method: "GET", url: "/api/me/credentials" });
    assert.equal(productionOnly.statusCode, 200);
    assert.deepEqual(JSON.parse(productionOnly.body).modelProviders, []);
    assert.equal(JSON.parse(productionOnly.body).gitSshConfigured, false);
    assert.equal((await inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { mode: "replace", apiKey: "forbidden" } } })).statusCode, 403);
  } finally { await f.cleanup(); }
});

test("retired production-data work mode cannot create Issues for any role", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Retired mode", ["prod"]);
    const response = await f.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("retired-mode"), workMode: "production_data" } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "invalid_work_mode");
  } finally { await f.cleanup(); }
});

test("rejects invalid credential groups before closing sessions or changing stored credentials", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  const headers = { "x-issue-pilot-subject": owner };
  const update = (payload: unknown) => f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: payload as Record<string, unknown> });
  try {
    assert.equal((await update({ model: { provider: "fixture", mode: "replace", apiKey: "original-key" } })).statusCode, 200);
    await createService(f.app, "Credential validation", ["test"]);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/issues", headers, payload: issuePayload("credential-validation") })).statusCode, 201);
    f.engine.running.clear();
    const before = await database.db.select().from(userCredentials);
    const model = { provider: "fixture", mode: "replace", apiKey: "must-not-be-saved" };
    for (const payload of [
      { model: { ...model, provider: "bad provider" } },
      { model: { ...model, mode: "unsupported" } },
      { model: { ...model, apiKey: "" } },
      { model, git: { mode: "replace", type: "ssh", privateKey: "invalid-private-key" } },
      { model, production: { dms: { mode: "replace", url: "http://unsafe.example.test", authorization: "Bearer fixture" } } },
      { model, production: { sls: { mode: "replace", accessKeyId: "id", accessKeySecret: "" } } },
      { production: { unknown: {} } },
    ]) {
      const response = await update(payload);
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(f.engine.closedSessions, [], "invalid input must preserve idle sessions");
      assert.deepEqual(await database.db.select().from(userCredentials), before);
    }
    const saved = await update({ model });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(f.engine.closedSessions, f.engine.enqueued);
    assert.equal((await database.db.select().from(userCredentials))[0]!.modelApiKeys.fixture, "must-not-be-saved");
    f.engine.closeSessionHook = async () => { throw new Error("fixture_close_failed"); };
    const failed = await update({ model: { ...model, apiKey: "must-not-survive-close-failure" } });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(JSON.parse(failed.body), { error: "user_credentials_save_failed" });
    assert.equal((await database.db.select().from(userCredentials))[0]!.modelApiKeys.fixture, "must-not-be-saved");
    assert.equal(f.engine.reservations.size, 0);
    f.engine.closeSessionHook = undefined;
    assert.equal((await update({ model: { ...model, apiKey: "retry-key" } })).statusCode, 200);
    assert.equal((await database.db.select().from(userCredentials))[0]!.modelApiKeys.fixture, "retry-key");
  } finally { await database.close(); await f.cleanup(); }
});

test("pins the default subject while rechecking its current role and active state", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/users", headers: { "x-issue-pilot-subject": owner }, payload: { subject: "zz-default-next-user", name: "Next", email: "next@example.test", role: "developer", isAdmin: true } });
    assert.equal(created.statusCode, 201, created.body);
    const request = { headers: {} };
    assert.equal((await requireCurrentUser(database, request)).subject, owner);
    await database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, owner));
    await assert.rejects(requireDeveloper(database, request), { statusCode: 403, message: "developer_role_required" });
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
    await assert.rejects(requireCurrentUser(database, request), { statusCode: 400, message: "invalid_current_subject" });
    assert.equal((await requireCurrentUser(database, { headers: {} })).subject, "zz-default-next-user");
  } finally { await database.close(); await f.cleanup(); }
});

test("parallel identity checks share the initial default selection and recheck deactivation", { timeout: 10_000 }, async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const execute = database.client.execute.bind(database.client);
  let holdFirstRead = true;
  database.client.execute = async (statement, args?: Parameters<typeof execute>[1]) => {
    const result = typeof statement === "string" ? await execute(statement, args) : await execute(statement);
    if (holdFirstRead) { holdFirstRead = false; entered(); await gate; }
    return result;
  };
  try {
    // Set up the second user before holding the first authorization query.
    holdFirstRead = false;
    await f.app.inject({ method: "POST", url: "/api/users", headers: { "x-issue-pilot-subject": owner }, payload: { subject: "zz-parallel-default", name: "Next", email: "next@example.test", role: "developer", isAdmin: true } });
    holdFirstRead = true;
    const request = { headers: {} };
    const first = requireCurrentUser(database, request);
    await waiting;
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
    const second = requireCurrentUser(database, request);
    release();
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof ApiError && result.reason.message === "invalid_current_subject"), "parallel checks must not select different users or accept a stale active state");
    assert.equal((await requireCurrentUser(database, { headers: {} })).subject, "zz-parallel-default");
  } finally { release(); await database.close(); await f.cleanup(); }
});

test("does not save another user's credentials when the default identity changes while queued", { timeout: 10_000 }, async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile), app = Fastify();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  registerUserRoutes({ app, database, engine: f.engine, runScopeExclusive: async operation => { entered(); await gate; return operation(); } });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/users", headers: { "x-issue-pilot-subject": owner }, payload: { subject: "zz-next-developer", name: "Next", email: "next@example.test", role: "developer", isAdmin: true } });
    assert.equal(created.statusCode, 201, created.body);
    const pending = app.inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { provider: "fixture", mode: "replace", apiKey: "queued-private-key" } } }).then(value => value);
    await waiting;
    // The earlier scope operation deactivates the default user before this update enters.
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
    release();
    const response = await pending;
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "invalid_current_subject" });
    assert.deepEqual(await database.db.select().from(userCredentials), []);
    assert.deepEqual(f.engine.closedSessions, []);
  } finally { release(); await app.close(); await database.close(); await f.cleanup(); }
});

test("credential changes reserve owned Issues and refuse an active Agent", async () => {
  const f = await createApiFixture();
  const inject = (input: InjectOptions) => f.app.inject({ ...input, headers: { "x-issue-pilot-subject": owner, ...input.headers } });
  try {
    await createService(f.app, "Busy", ["dev"]);
    await inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("busy"), workMode: "development_fix" } });
    const response = await inject({ method: "PUT", url: "/api/me/credentials", payload: { model: { provider: "fixture", mode: "replace", apiKey: "new-key" } } });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: "issue_already_running" });
    assert.deepEqual(JSON.parse((await inject({ method: "GET", url: "/api/me/credentials" })).body).modelProviders, []);
  } finally { await f.cleanup(); }
});
