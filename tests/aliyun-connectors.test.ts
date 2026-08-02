import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { AliyunEvidenceConnector } from "../src/aliyun-connectors.ts";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fakeAliyun(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fake-aliyun-"));
  directories.push(directory);
  const executable = join(directory, "aliyun");
  await writeFile(executable, "#!/bin/sh\nprintf '{\"args\":['\nfirst=1\nfor arg in \"$@\"; do [ $first -eq 1 ] || printf ','; first=0; printf '\"%s\"' \"$arg\"; done\nprintf '],\"accessToken\":\"secret\"}\\n'\n", "utf8");
  await chmod(executable, 0o755);
  return executable;
}

test("bounds SLS queries and redacts sensitive output", async () => {
  const connector = new AliyunEvidenceConnector({
    aliyunCli: await fakeAliyun(),
    sls: {
      prod: {
        environment: "production", profile: "readonly", region: "cn-test", project: "project", logstore: "app", maxWindowSeconds: 60,
        queries: { trace: "traceId: {{traceId}}" },
      },
    },
  });
  const result = await connector.querySls({ sourceKey: "prod", queryName: "trace", parameters: { traceId: "abc-123" }, from: 100, to: 150 });
  const output = result.data as { args: string[]; accessToken: string };
  assert.equal(output.accessToken, "[REDACTED]");
  assert.ok(output.args.includes("--line"));
  assert.ok(output.args.includes("100"));
  await assert.rejects(
    connector.querySls({ sourceKey: "prod", queryName: "trace", parameters: { traceId: "abc" }, from: 100, to: 200 }),
    /exceeds 60/,
  );
});

test("runs only configured read-only DMS templates", async () => {
  const executable = await fakeAliyun();
  const connector = new AliyunEvidenceConnector({
    aliyunCli: executable,
    dms: {
      prod: {
        profile: "readonly", region: "cn-test", dbId: 42, logic: false,
        queries: {
          order: { statement: "SELECT id FROM orders WHERE id = {{id}} LIMIT 1", parameters: { id: "string" } },
          unsafe: { statement: "DELETE FROM orders WHERE id = {{id}}", parameters: { id: "number" } },
        },
      },
    },
  });
  const result = await connector.queryDms({ sourceKey: "prod", queryName: "order", parameters: { id: "A'1" } });
  const args = (result.data as { args: string[] }).args;
  assert.ok(args.includes("dms-enterprise"));
  assert.ok(args.includes("SELECT id FROM orders WHERE id = 'A''1' LIMIT 1"));
  await assert.rejects(connector.queryDms({ sourceKey: "prod", queryName: "unsafe", parameters: { id: 1 } }), /read-only/);
});
