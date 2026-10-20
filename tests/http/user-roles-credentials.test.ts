import type { InjectOptions } from "fastify";
import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createService, issuePayload } from "./fixture.ts";

const owner = issuePilotConfig.bootstrapUser.subject;

test("only developers can create development or production-data Issues and plan conversions", async () => {
  const f = await createApiFixture();
  const inject = (input: InjectOptions) => f.app.inject({ ...input, headers: { "x-issue-pilot-subject": owner, ...input.headers } });
  try {
    await createService(f.app, "Roles", ["prod", "test", "dev"]);
    for (const role of ["product", "test", "developer"]) {
      const subject = `${role}@example.test`;
      assert.equal((await inject({ method: "POST", url: "/api/users", payload: { subject, name: role, email: subject, role } })).statusCode, 201);
      const headers = { "x-issue-pilot-subject": subject };
      for (const workMode of ["development_fix", "development_feature", "production_data", "test_analysis"]) {
        const response = await inject({ method: "POST", url: "/api/issues", headers, payload: { ...issuePayload("roles"), workMode } });
        assert.equal(response.statusCode, role !== "developer" && (workMode.startsWith("development") || workMode === "production_data") ? 403 : 201, response.body);
      }
      const created = await inject({ method: "POST", url: "/api/issues", headers, payload: { ...issuePayload("roles"), workMode: "production_analysis" } });
      const key = JSON.parse(created.body).id;
      const plan = await inject({ method: "POST", url: `/api/issues/${key}/scope-transition/plan`, headers, payload: { serviceKey: "roles", workMode: "development_fix" } });
      if (role !== "developer") assert.equal(plan.statusCode, 403, plan.body);
      const dataPlan = await inject({ method: "POST", url: `/api/issues/${key}/scope-transition/plan`, headers, payload: { serviceKey: "roles", workMode: "production_data" } });
      if (role !== "developer") assert.equal(dataPlan.statusCode, 403, dataPlan.body);
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

test("product and test users cannot execute production-data Issues or become their credential owner", async () => {
  const f = await createApiFixture();
  const inject = (input: InjectOptions) => f.app.inject({ ...input, headers: { "x-issue-pilot-subject": owner, ...input.headers } });
  try {
    await createService(f.app, "Data permissions", ["prod"]);
    const created = await inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("data-permissions"), workMode: "production_data" } });
    assert.equal(created.statusCode, 201, created.body);
    const key = JSON.parse(created.body).id;
    f.engine.running.clear();
    for (const role of ["product", "test"]) {
      const subject = `${role}-data@example.test`;
      await inject({ method: "POST", url: "/api/users", payload: { subject, name: role, email: subject, role } });
      const headers = { "x-issue-pilot-subject": subject };
      for (const suffix of ["retry", "agent-messages"]) {
        const response = await inject({ method: "POST", url: `/api/issues/${key}/${suffix}`, headers, payload: { message: "run" } });
        assert.equal(response.statusCode, 403, response.body);
      }
      const assignment = await inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("data-permissions"), workMode: "production_data", assigneeSubject: subject } });
      assert.equal(assignment.statusCode, 400, assignment.body);
      assert.equal(JSON.parse(assignment.body).error, "issue_developer_owner_required");
    }
  } finally { await f.cleanup(); }
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
