import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPersonalGitEnvironment } from "../../src/workspace/git-credentials.ts";

function credentials(key: string) { return { subject: "developer", modelApiKeys: {}, gitPrivateKey: key, updatedAt: new Date() }; }
const identityPath = (command: string) => command.match(/-i '([^']+)'/)![1]!;

test("isolates personal SSH keys, enforces host verification and removes private files", async () => {
  const a = await createPersonalGitEnvironment(credentials("alice-fixture-key"), ["git@git.example.test:team/project.git"]);
  const b = await createPersonalGitEnvironment(credentials("bob-fixture-key"), ["ssh://git@git.example.test/team/project.git"]);
  const aKey = identityPath(a.env.GIT_SSH_COMMAND!);
  const bKey = identityPath(b.env.GIT_SSH_COMMAND!);
  try {
    assert.notEqual(aKey, bKey);
    assert.equal((await stat(aKey)).mode & 0o077, 0);
    assert.equal((await stat(path.dirname(aKey))).mode & 0o077, 0);
    assert.equal(await readFile(aKey, "utf8"), "alice-fixture-key");
    assert.equal(await readFile(bKey, "utf8"), "bob-fixture-key");
    assert.match(a.env.GIT_SSH_COMMAND!, /StrictHostKeyChecking=yes/);
    assert.match(a.env.GIT_SSH_COMMAND!, /IdentityAgent=none/);
    assert.match(a.env.GIT_SSH_COMMAND!, /-F \/dev\/null/);
    assert.equal(JSON.stringify(a.env).includes("alice-fixture-key"), false);
  } finally { await a.close(); await b.close(); }
  await assert.rejects(access(aKey));
  await a.close();
});

test("accepts only SSH remote URLs and refuses shared credentials fallback", async () => {
  await assert.rejects(createPersonalGitEnvironment(credentials("fixture-key"), ["https://git.example.test/repo.git"]), /personal_git_ssh_url_required/);
  await assert.rejects(createPersonalGitEnvironment(undefined, ["git@git.example.test:repo.git"]), /user_git_ssh_credentials_required/);
  const local = await createPersonalGitEnvironment(undefined, ["/tmp/local.git"]);
  await local.close();
});
