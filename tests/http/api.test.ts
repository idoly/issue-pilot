import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildApi } from "../../src/http/api.ts";

const runner = {
  enqueued: [] as string[],
  running: new Set<string>(),
  enqueue(issueId: string) { this.enqueued.push(issueId); },
  isRunning(issueId: string) { return this.running.has(issueId); },
  enqueueDirect() {},
  async steerDirect() { return false; },
  async abortDirect() { return false; },
  async getScopeCandidates() { return []; },
  async getConversation() { return []; },
};

async function json(response: { body: string }): Promise<Record<string, unknown>> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("configuration and issue API preserves relational integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-api-"));
  runner.enqueued = [];
  runner.running.clear();
  const app = await buildApi({ databaseFile: join(root, "issues.db"), stateRoot: root, runner: runner as never, logger: false });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);

    const configurationResponse = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(configurationResponse.statusCode, 200);
    const configuredEnvironments = (await json(configurationResponse)).environments as Array<{ key: string; name: string }>;
    assert.deepEqual(configuredEnvironments.map((environment) => environment.key).sort(), ["production", "test"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/environments", payload: { key: "staging", name: "Staging" } })).statusCode, 405);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/environments/test", payload: { name: "Changed" } })).statusCode, 405);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/environments/test" })).statusCode, 405);

    for (const service of [
      { key: "alpha", name: "Alpha", moduleId: "alpha-core" },
      { key: "beta", name: "Beta", moduleId: "beta-core" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/services",
        payload: {
          key: service.key,
          name: service.name,
          description: `${service.name} service`,
          repositories: [{ url: `https://example.test/${service.key}.git` }],
          modules: [{ id: service.moduleId, name: "Core", path: "core" }],
          relatedServiceKeys: [],
          relatedModuleIds: [],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      const deployment = await app.inject({
        method: "POST",
        url: `/api/services/${service.key}/deployments`,
        payload: { environmentKey: "test", baseBranch: "main", capabilities: [] },
      });
      assert.equal(deployment.statusCode, 201, deployment.body);
    }

    const invalidOrder = await app.inject({ method: "PUT", url: "/api/services/order", payload: { serviceKeys: ["alpha"] } });
    assert.equal(invalidOrder.statusCode, 400);
    assert.equal((await json(invalidOrder)).error, "invalid_service_order");
    const reordered = await app.inject({ method: "PUT", url: "/api/services/order", payload: { serviceKeys: ["beta", "alpha"] } });
    assert.equal(reordered.statusCode, 200, reordered.body);
    const reorderedConfiguration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string }> };
    assert.deepEqual(reorderedConfiguration.services.map((service) => service.key), ["beta", "alpha"]);

    const invalidSubject = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Unknown assignee",
        description: "",
        priority: "p2",
        type: "task",
        environmentKey: "test",
        serviceKeys: ["alpha"],
        moduleIds: [],
        assigneeSubject: "missing-user",
        ccSubjects: [],
      },
    });
    assert.equal(invalidSubject.statusCode, 400);
    assert.equal((await json(invalidSubject)).error, "invalid_subject");

    const invalidPriority = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Invalid priority",
        description: "",
        priority: "urgent",
        type: "task",
        environmentKey: "test",
        serviceKeys: ["alpha"],
        moduleIds: [],
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(invalidPriority.statusCode, 400);
    assert.equal((await json(invalidPriority)).error, "invalid_priority");
    assert.deepEqual(await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)), []);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        title: "Valid issue",
        description: "Investigate alpha",
        priority: "p1",
        type: "problem",
        environmentKey: "test",
        serviceKeys: ["alpha"],
        moduleIds: ["alpha-core"],
        assigneeSubject: "demo-owner",
        ccSubjects: [],
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = await json(createdResponse);
    assert.match(String(created.id), /^ISSUE-[0-9]{8}-001$/);
    assert.equal(runner.enqueued.length, 1);
    const createdInternalId = runner.enqueued[0]!;
    runner.running.add(createdInternalId);
    const runningRetry = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(runningRetry.statusCode, 409);
    assert.equal((await json(runningRetry)).error, "issue_already_running");
    runner.running.delete(createdInternalId);
    const retryResponse = await app.inject({ method: "POST", url: `/api/issues/${created.id}/retry` });
    assert.equal(retryResponse.statusCode, 202, retryResponse.body);
    assert.equal(runner.enqueued.filter((id) => id === createdInternalId).length, 2);

    const concurrentPayload = (title: string) => ({
      title,
      description: "",
      priority: "p2",
      type: "task",
      environmentKey: "test",
      serviceKeys: ["alpha"],
      moduleIds: [],
      assigneeSubject: null,
      ccSubjects: [],
    });
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: "/api/issues", payload: concurrentPayload("Concurrent A") }),
      app.inject({ method: "POST", url: "/api/issues", payload: concurrentPayload("Concurrent B") }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.statusCode), [201, 201]);
    const concurrentKeys = await Promise.all(concurrent.map(async (response) => String((await json(response)).id)));
    assert.equal(new Set(concurrentKeys).size, 2);
    assert.deepEqual(concurrentKeys.sort(), [String(created.id).replace(/001$/, "002"), String(created.id).replace(/001$/, "003")]);

    const invalidIssuePath = await app.inject({ method: "GET", url: "/api/issues/not-an-issue" });
    assert.equal(invalidIssuePath.statusCode, 404);

    const crossServiceModule = await app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: {
        title: "Should not change",
        description: "",
        priority: "p3",
        type: "request",
        serviceKeys: ["alpha"],
        moduleIds: ["beta-core"],
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(crossServiceModule.statusCode, 400);
    assert.equal((await json(crossServiceModule)).error, "invalid_module");

    const detailResponse = await app.inject({ method: "GET", url: `/api/issues/${created.id}` });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail = await json(detailResponse);
    assert.equal(detail.title, "Valid issue");
    assert.deepEqual((detail.affectedModules as Array<{ id: string }>).map((module) => module.id), ["alpha-core"]);

    const emptyServices = await app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { title: "No services", description: "", priority: "p2", type: "task", serviceKeys: [], moduleIds: [], assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(emptyServices.statusCode, 400);
    assert.equal((await json(emptyServices)).error, "service_required");

    const validUpdate = await app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { title: "Moved to beta", description: "", priority: "p2", type: "task", serviceKeys: ["beta"], moduleIds: ["beta-core"], assigneeSubject: null, ccSubjects: [] },
    });
    assert.equal(validUpdate.statusCode, 200, validUpdate.body);
    const updatedList = await app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)) as Array<{ id: string; labels: string[] }>;
    assert.deepEqual(updatedList.find((item) => item.id === created.id)?.labels, ["beta", "test"]);
    const updatedDetail = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { affectedServices: Array<{ key: string }>; affectedModules: Array<{ id: string }> };
    assert.deepEqual(updatedDetail.affectedServices.map((service) => service.key), ["beta"]);
    assert.deepEqual(updatedDetail.affectedModules.map((module) => module.id), ["beta-core"]);

    const boundary = "issue-pilot-test-boundary";
    const attachmentContent = "diagnostic output\n";
    const multipartBody = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="diagnostic.txt"',
      "Content-Type: text/plain",
      "",
      attachmentContent,
      `--${boundary}--`,
      "",
    ].join("\r\n"));
    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/issues/${created.id}/attachments`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
    const uploaded = JSON.parse(uploadResponse.body) as Array<Record<string, unknown>>;
    assert.equal(uploaded[0]?.fileName, "diagnostic.txt");
    assert.equal(uploaded[0]?.sha256, createHash("sha256").update(attachmentContent).digest("hex"));
    assert.equal("objectKey" in uploaded[0]!, false);
    assert.equal("issueId" in uploaded[0]!, false);
    const attachmentDirectory = join(root, "attachments", String(created.id).toLowerCase());
    const attachmentFiles = await readdir(attachmentDirectory);
    assert.equal(attachmentFiles.length, 1);
    assert.equal((await stat(join(attachmentDirectory, attachmentFiles[0]!))).mode & 0o777, 0o600);
    const detailWithAttachment = await app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<Record<string, unknown>> };
    assert.equal(detailWithAttachment.attachments.length, 1);
    assert.equal("objectKey" in detailWithAttachment.attachments[0]!, false);

    const invalidServiceUpdate = await app.inject({
      method: "PATCH",
      url: "/api/services/alpha",
      payload: {
        name: "Partially changed",
        description: "changed",
        repositories: [{ url: "https://example.test/alpha.git" }],
        modules: [{ id: "alpha-core", name: "Core", path: "core" }],
        relatedServiceKeys: ["missing"],
        relatedModuleIds: [],
      },
    });
    assert.equal(invalidServiceUpdate.statusCode, 400);
    const configuration = await app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(configuration.services.find((service) => service.key === "alpha")?.name, "Alpha");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
