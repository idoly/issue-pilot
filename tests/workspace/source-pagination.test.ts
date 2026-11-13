import assert from "node:assert/strict";
import { OperationError } from "../../src/operation-error.ts";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { executeLocalCommand, type CommandExecutor } from "../../src/process.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { registerSourceBrowserRoutes } from "../../src/http/source-browser-routes.ts";
import { TestAgentController } from "../http/fixture.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-source-pages-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
  await database.db.insert(subjects).values({ subject: "browser-test" });
  const [service] = await database.db.insert(services).values({ key: "source-pages", name: "Source pages" }).returning();
  await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
  const [issue] = await database.db
    .insert(issues)
    .values({ key: "ISSUE-20261017-991", title: "Synthetic source", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "browser-test" })
    .returning();
  const runGit = async (args: string[]) => {
    const result = await executeLocalCommand("git", args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const seed = path.join(root, "seed");
  await runGit(["init", "-b", "main", seed]);
  await runGit(["-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture baseline"]);
  await claimIssueRoot(root, issue!.key);
  const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "application", url: seed, baseBranch: "main", mode: "hotfix" });
  const repository = prepared.workspacePath;
  await database.db.insert(issueRepositories).values({
    issueId: issue!.id,
    url: seed,
    baseBranch: "main",
    workingBranch: prepared.workingBranch,
    localPath: repository,
    workspaceName: "application",
    commitBefore: prepared.baseCommit,
  });
  await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
  await prepareIssueRuntime(root, issue!.key, [{ name: "application", repositoryPath: repository }], "write");
  return {
    root,
    database,
    issue: issue!,
    repository,
    store: prepared.cachePath,
    git: (args: string[]) => runGit(["-C", repository, ...args]),
    browser: new SourceBrowser(database.db, root),
    close: async () => {
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const operation of ["create-file", "create-directory", "save", "delete", "rename-source", "rename-destination"] as const) {
  for (const phase of ["before-parent-open", "after-parent-validation"] as const)
    test(`${operation} cannot escape through a parent replaced ${phase}`, async (context) => {
      const f = await fixture();
      const openFile = fs.open,
        resolve = fs.realpath;
      const folder = path.join(f.repository, "nested"),
        outside = path.join(f.root, "outside");
      let replaced = false;
      try {
        await mkdir(folder);
        await mkdir(outside);
        await writeFile(path.join(folder, "existing.txt"), "inside");
        await writeFile(path.join(outside, "existing.txt"), "outside-private");
        await writeFile(path.join(f.repository, "source.txt"), "source-evidence");
        const original = await f.browser.file(f.issue, "application", "nested/existing.txt");
        const replaceParent = async () => {
          replaced = true;
          await rename(folder, path.join(f.repository, "previous"));
          await symlink(outside, folder);
        };
        if (phase === "before-parent-open")
          context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
            if (!replaced && args[0] === folder) await replaceParent();
            return openFile(...args);
          });
        else
          context.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
            const value = await resolve(...args);
            if (!replaced && String(args[0]).startsWith("/proc/self/fd/") && value === folder) await replaceParent();
            return value;
          });
        syncBuiltinESMExports();
        let error: unknown;
        try {
          if (operation === "create-file") await f.browser.createFile(f.issue, "application", "nested/new.txt", "new evidence");
          if (operation === "create-directory") await f.browser.createDirectory(f.issue, "application", "nested/new-directory");
          if (operation === "save") await f.browser.writeFile(f.issue, "application", "nested/existing.txt", "replacement", original.sha256);
          if (operation === "delete") await f.browser.deletePath(f.issue, "application", "nested/existing.txt", false);
          if (operation === "rename-source") await f.browser.renamePath(f.issue, "application", "nested/existing.txt", "renamed.txt", false);
          if (operation === "rename-destination") await f.browser.renamePath(f.issue, "application", "source.txt", "nested/existing.txt", true);
        } catch (failure) {
          error = failure;
        }
        assert.equal(replaced, true, "race must occur on the validated parent");
        if (phase === "before-parent-open") assert.ok(error, "a substituted directory must be rejected before mutation");
        assert.equal(await readFile(path.join(outside, "existing.txt"), "utf8"), "outside-private");
        assert.deepEqual(await readdir(outside), ["existing.txt"], "no creation, rename backup or partial output may escape");
      } finally {
        context.mock.restoreAll();
        syncBuiltinESMExports();
        await f.close();
      }
    });
}

test("parent descriptor cleanup preserves a mutation failure and releases the directory", async (context) => {
  const f = await fixture(),
    openFile = fs.open;
  const primary = new Error("fixture_create_failed"),
    cleanup = new Error("fixture_parent_close_failed");
  let descriptor: number | undefined;
  try {
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args);
      if (args[0] === f.repository) {
        descriptor = handle.fd;
        const close = handle.close.bind(handle);
        context.mock.method(handle, "close", async () => {
          await close();
          throw cleanup;
        });
      }
      return handle;
    });
    context.mock.method(fs, "writeFile", async () => {
      throw primary;
    });
    syncBuiltinESMExports();
    await assert.rejects(
      f.browser.createFile(f.issue, "application", "new.txt", "content"),
      (error) =>
        error instanceof OperationError &&
        error.outcome === "unknown" &&
        error.message === "source_path_cleanup_failed" &&
        error.cause instanceof AggregateError &&
        error.cause.errors[0] === primary &&
        error.cause.errors[1] === cleanup,
    );
    assert.ok(descriptor !== undefined);
    await assert.rejects(fs.stat(`/proc/self/fd/${descriptor}`), { code: "ENOENT" });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

for (const phase of ["before-open", "after-validation"] as const)
  test(`source tree stays inside the pinned directory when replaced ${phase}`, async (context) => {
    const f = await fixture(),
      openDirectory = fs.open,
      resolve = fs.realpath;
    try {
      const folder = path.join(f.repository, "nested"),
        outside = path.join(f.root, "outside");
      await mkdir(folder);
      await mkdir(outside);
      await writeFile(path.join(folder, "inside.txt"), "inside");
      await writeFile(path.join(outside, "private-file-name.txt"), "private");
      let replaced = false;
      const replace = async () => {
        replaced = true;
        await rename(folder, path.join(f.repository, "previous"));
        await symlink(outside, folder);
      };
      if (phase === "before-open")
        context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          if (!replaced && args[0] === folder) await replace();
          return openDirectory(...args);
        });
      else
        context.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
          const value = await resolve(...args);
          if (!replaced && String(args[0]).startsWith("/proc/self/fd/") && value === folder) await replace();
          return value;
        });
      syncBuiltinESMExports();
      let tree: Awaited<ReturnType<SourceBrowser["tree"]>> | undefined, error: unknown;
      try {
        tree = await f.browser.tree(f.issue, "application", "nested");
      } catch (failure) {
        error = failure;
      }
      assert.equal(replaced, true);
      if (phase === "before-open") assert.ok(error);
      else
        assert.deepEqual(
          tree?.entries.map((entry) => entry.name),
          ["inside.txt"],
        );
      assert.ok(!JSON.stringify(tree ?? {}).includes("private-file-name"));
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await f.close();
    }
  });

test("source tree waits for pending metadata before closing a failed listing", async (context) => {
  const f = await fixture(),
    openDirectory = fs.open,
    metadata = fs.lstat;
  let release!: () => void,
    entered!: () => void,
    closed = false;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const failure = new Error("fixture_metadata_failed");
  let observed: Promise<unknown> | undefined;
  try {
    await writeFile(path.join(f.repository, "failed.txt"), "failed");
    await writeFile(path.join(f.repository, "waiting.txt"), "waiting");
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openDirectory(...args);
      if (args[0] === f.repository) {
        const close = handle.close.bind(handle);
        context.mock.method(handle, "close", async () => {
          closed = true;
          await close();
        });
      }
      return handle;
    });
    context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).startsWith("/proc/self/fd/")) {
        if (path.basename(String(args[0])) === "failed.txt") throw failure;
        if (path.basename(String(args[0])) === "waiting.txt") {
          entered();
          await gate;
        }
      }
      return metadata(...args);
    });
    syncBuiltinESMExports();
    observed = f.browser.tree(f.issue, "application").then(
      () => assert.fail("listing should fail"),
      (error) => assert.equal(error, failure),
    );
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await observed;
    assert.equal(closed, true);
  } finally {
    release();
    try {
      await observed;
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await f.close();
    }
  }
});

test("blame rejects a parent directory swap before reading working content", async (context) => {
  const f = await fixture(),
    openFile = fs.open;
  try {
    const folder = path.join(f.repository, "nested"),
      outside = path.join(f.root, "outside");
    await mkdir(folder);
    await mkdir(outside);
    await writeFile(path.join(folder, "evidence.txt"), "inside");
    await writeFile(path.join(outside, "evidence.txt"), "outside-private");
    let replaced = false;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && args[0] === path.join(folder, "evidence.txt")) {
        replaced = true;
        await rename(folder, path.join(f.repository, "previous"));
        await symlink(outside, folder);
      }
      return openFile(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.browser.blame(f.issue, "application", "nested/evidence.txt", 1), /source_path_outside_repository/);
    assert.equal(replaced, true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("source reads validate the opened descriptor when a parent is replaced", async (context) => {
  const f = await fixture(),
    openFile = fs.open;
  try {
    const folder = path.join(f.repository, "nested"),
      outside = path.join(f.root, "outside");
    await mkdir(folder);
    await mkdir(outside);
    await writeFile(path.join(folder, "evidence.txt"), "inside");
    await writeFile(path.join(outside, "evidence.txt"), "outside-private");
    let replaced = false;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && args[0] === path.join(folder, "evidence.txt")) {
        replaced = true;
        await rename(folder, path.join(f.repository, "previous"));
        await symlink(outside, folder);
      }
      return openFile(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.browser.file(f.issue, "application", "nested/evidence.txt"), /source_path_outside_repository/);
    assert.equal(replaced, true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("same-path renames retain existence and repository boundary checks without creating backup files", async () => {
  const f = await fixture();
  try {
    await f.browser.createFile(f.issue, "application", "same.txt", "unchanged");
    const before = await readdir(f.repository);
    await f.browser.renamePath(f.issue, "application", "same.txt", "same.txt", true);
    assert.equal(await readFile(path.join(f.repository, "same.txt"), "utf8"), "unchanged");
    assert.deepEqual(await readdir(f.repository), before);
    await assert.rejects(f.browser.renamePath(f.issue, "application", "missing.txt", "missing.txt", false), /source_path_not_found/);
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "outside-private");
    await symlink(outside, path.join(f.repository, "escape"));
    await assert.rejects(f.browser.renamePath(f.issue, "application", "escape/private.txt", "escape/private.txt", true), /source_path_outside_repository/);
    assert.equal(await readFile(path.join(outside, "private.txt"), "utf8"), "outside-private");
  } finally {
    await f.close();
  }
});

test("source save collisions preserve another operation's temporary file and the current source", async (context) => {
  const f = await fixture();
  const id = "11111111-1111-4111-8111-111111111111";
  try {
    const original = await f.browser.createFile(f.issue, "application", "report.txt", "original source");
    const temporary = path.join(f.repository, `.issue-pilot-${id}.tmp`);
    await writeFile(temporary, "other operation evidence");
    context.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();
    await assert.rejects(f.browser.writeFile(f.issue, "application", "report.txt", "replacement", original.sha256), { code: "EEXIST" });
    assert.equal(await readFile(temporary, "utf8"), "other operation evidence");
    assert.equal(await readFile(path.join(f.repository, "report.txt"), "utf8"), "original source");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

for (const cleanupFails of [false, true])
  test(`failed source creation does not publish a partial file and permits retry (cleanup fails: ${cleanupFails})`, async (context) => {
    const f = await fixture(),
      write = fs.writeFile,
      remove = fs.rm,
      open = fs.open;
    const primary = Object.assign(new Error("fixture_source_create_failed"), { code: "ENOSPC" }),
      cleanup = new Error("fixture_source_cleanup_failed");
    let temporary = "",
      descriptor: number | undefined;
    try {
      const before = await readdir(f.repository);
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (path.basename(String(args[0])).startsWith(".issue-pilot-")) {
          temporary = String(args[0]);
          descriptor = handle.fd;
        }
        return handle;
      });
      context.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
        await write(args[0], "partial", args[2]);
        throw primary;
      });
      context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (cleanupFails && String(args[0]) === temporary) throw cleanup;
        return remove(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(f.browser.createFile(f.issue, "application", "new.txt", "complete content"), (error) =>
        cleanupFails
          ? error instanceof OperationError &&
            error.outcome === "unknown" &&
            error.message === "source_create_cleanup_failed" &&
            error.cause instanceof AggregateError &&
            error.cause.errors.includes(primary) &&
            error.cause.errors.includes(cleanup)
          : error === primary,
      );
      await assert.rejects(lstat(path.join(f.repository, "new.txt")), { code: "ENOENT" });
      assert.ok(descriptor !== undefined);
      await assert.rejects(fs.stat(`/proc/self/fd/${descriptor}`), { code: "ENOENT" });
      if (cleanupFails) assert.equal(await readFile(path.join(f.repository, path.basename(temporary)), "utf8"), "partial");
      else assert.deepEqual(await readdir(f.repository), before, "a failed create must not leave a partial source or temporary file");
      context.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal((await f.browser.createFile(f.issue, "application", "new.txt", "complete content")).content, "complete content");
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await f.close();
    }
  });

test("source creation keeps a colliding temporary file and never overwrites a new destination", async (context) => {
  const f = await fixture(),
    publish = fs.link;
  const id = "22222222-2222-4222-8222-222222222222",
    temporary = path.join(f.repository, `.issue-pilot-${id}.tmp`),
    target = path.join(f.repository, "new.txt");
  try {
    await writeFile(temporary, "other operation evidence");
    context.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();
    await assert.rejects(f.browser.createFile(f.issue, "application", "new.txt", "new content"), { code: "EEXIST" });
    assert.equal(await readFile(temporary, "utf8"), "other operation evidence");
    await assert.rejects(lstat(target), { code: "ENOENT" });
    context.mock.restoreAll();
    context.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      await assert.rejects(lstat(target), { code: "ENOENT" });
      await writeFile(target, "concurrent source", { flag: "wx" });
      return publish(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.browser.createFile(f.issue, "application", "new.txt", "new content"), /source_path_exists/);
    assert.equal(await readFile(target, "utf8"), "concurrent source");
    assert.deepEqual(await readdir(f.repository), [".git", path.basename(temporary), "new.txt"]);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

for (const cleanupFails of [false, true])
  test(`failed source saves retain the primary error and release their descriptor (cleanup fails: ${cleanupFails})`, async (context) => {
    const f = await fixture();
    const openFile = fs.open,
      remove = fs.rm;
    const primary = new Error("fixture_source_write_failed"),
      cleanup = new Error("fixture_source_cleanup_failed");
    let closed = false,
      temporary = "";
    try {
      const original = await f.browser.createFile(f.issue, "application", "report.txt", "original source");
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await openFile(...args);
        if (path.basename(String(args[0])).startsWith(".issue-pilot-")) {
          temporary = String(args[0]);
          const close = handle.close.bind(handle),
            write = handle.writeFile.bind(handle);
          context.mock.method(handle, "writeFile", async () => {
            await write("partial");
            throw primary;
          });
          context.mock.method(handle, "close", async () => {
            await close();
            closed = true;
          });
        }
        return handle;
      });
      context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (cleanupFails && String(args[0]) === temporary) throw cleanup;
        return remove(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(f.browser.writeFile(f.issue, "application", "report.txt", "replacement", original.sha256), (error) =>
        cleanupFails
          ? error instanceof OperationError &&
            error.outcome === "not_committed" &&
            error.message === "source_save_cleanup_failed" &&
            error.cause instanceof AggregateError &&
            error.cause.errors.includes(primary) &&
            error.cause.errors.includes(cleanup)
          : error === primary,
      );
      assert.equal(closed, true);
      assert.equal(await readFile(path.join(f.repository, "report.txt"), "utf8"), "original source");
      const temporaryFile = path.join(f.repository, path.basename(temporary));
      if (cleanupFails) assert.equal(await readFile(temporaryFile, "utf8"), "partial");
      else await assert.rejects(lstat(temporaryFile), { code: "ENOENT" });
      context.mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal((await f.browser.writeFile(f.issue, "application", "report.txt", "retried", original.sha256)).content, "retried");
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await f.close();
    }
  });

test("a completed save does not delete a newly reused temporary pathname", async (context) => {
  const f = await fixture();
  const move = fs.rename;
  let reused = "";
  try {
    const original = await f.browser.createFile(f.issue, "application", "report.txt", "original source");
    context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await move(...args);
      reused = String(args[0]);
      await writeFile(reused, "new owner's evidence");
    });
    syncBuiltinESMExports();
    assert.equal((await f.browser.writeFile(f.issue, "application", "report.txt", "saved source", original.sha256)).content, "saved source");
    assert.equal(await readFile(path.join(f.repository, path.basename(reused)), "utf8"), "new owner's evidence");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("source mutations reject a Git pointer redirected to another Issue's worktree", async () => {
  const f = await fixture();
  try {
    const foreign = path.join(f.root, "other-issue");
    const added = await executeLocalCommand("git", ["--git-dir", f.store, "worktree", "add", "--force", foreign, "hotfix-issue-20261017-991"]);
    assert.equal(added.code, 0, added.stderr);
    const pointer = await readFile(path.join(foreign, ".git"), "utf8"),
      directory = path.resolve(foreign, pointer.trim().slice("gitdir: ".length)),
      index = path.join(directory, "index");
    const before = await readFile(index);
    await writeFile(path.join(f.repository, "evidence.txt"), "own change");
    await writeFile(path.join(f.repository, ".git"), pointer);
    await assert.rejects(f.browser.stage(f.issue, "application", ["evidence.txt"]), /source_git_binding_invalid/);
    assert.deepEqual(await readFile(index), before);
  } finally {
    await f.close();
  }
});

test("saves long ASCII and Unicode file names using bounded temporary names", async () => {
  const f = await fixture();
  try {
    for (const name of [`${"a".repeat(240)}.txt`, `${"文".repeat(80)}.txt`]) {
      const created = await f.browser.createFile(f.issue, "application", name, "old contents");
      const saved = await f.browser.writeFile(f.issue, "application", name, "new contents", created.sha256);
      assert.equal(saved.content, "new contents");
      assert.equal((await f.browser.file(f.issue, "application", name)).content, "new contents");
      await assert.rejects(f.browser.writeFile(f.issue, "application", name, "stale contents", created.sha256), /source_file_changed/);
    }
    assert.equal(
      (await readdir(f.repository)).some((name) => name.startsWith(".issue-pilot-")),
      false,
    );
  } finally {
    await f.close();
  }
});

for (const directory of [false, true])
  test(`preserves an overwritten ${directory ? "directory" : "file"} when the source cannot be renamed`, { skip: process.getuid?.() === 0 }, async () => {
    const f = await fixture();
    const protectedDirectory = path.join(f.repository, "protected");
    try {
      await mkdir(protectedDirectory);
      await writeFile(path.join(protectedDirectory, "source.txt"), "source data\n");
      const destination = path.join(f.repository, "destination");
      if (directory) await mkdir(destination);
      const evidence = directory ? path.join(destination, "evidence.txt") : destination;
      await writeFile(evidence, "preserve old destination\n");
      await chmod(protectedDirectory, 0o500);
      await assert.rejects(f.browser.renamePath(f.issue, "application", "protected/source.txt", "destination", true), { code: "EACCES" });
      assert.equal(await readFile(evidence, "utf8"), "preserve old destination\n");
      assert.equal(await readFile(path.join(protectedDirectory, "source.txt"), "utf8"), "source data\n");
      assert.equal(
        (await readdir(f.repository)).some((name) => name.includes(".issue-pilot-")),
        false,
      );
    } finally {
      await chmod(protectedDirectory, 0o700).catch(() => {});
      await f.close();
    }
  });

test("reports rename finalization failures and preserves the previous destination as recovery evidence", { skip: process.getuid?.() === 0 }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "source"), "new contents\n");
    await mkdir(path.join(f.repository, "destination"));
    await writeFile(path.join(f.repository, "destination", "evidence.txt"), "old contents\n");
    await chmod(path.join(f.repository, "destination"), 0o500);
    await assert.rejects(f.browser.renamePath(f.issue, "application", "source", "destination", true), /source_rename_finalize_failed/);
    assert.equal(await readFile(path.join(f.repository, "destination"), "utf8"), "new contents\n");
    const [backup] = (await readdir(f.repository)).filter((name) => name.startsWith(".issue-pilot-rename-"));
    assert.ok(backup);
    assert.equal(await readFile(path.join(f.repository, backup, "evidence.txt"), "utf8"), "old contents\n");
  } finally {
    for (const name of await readdir(f.repository)) if (name.startsWith(".issue-pilot-rename-") || name === "destination") await chmod(path.join(f.repository, name), 0o700).catch(() => {});
    await f.close();
  }
});

test("replaces a nonempty source directory only after installing its replacement", async () => {
  const f = await fixture();
  try {
    for (const name of ["source", "destination"]) {
      await mkdir(path.join(f.repository, name));
      await writeFile(path.join(f.repository, name, "value.txt"), name);
    }
    await f.browser.renamePath(f.issue, "application", "source", "destination", true);
    assert.equal(await readFile(path.join(f.repository, "destination", "value.txt"), "utf8"), "source");
    await assert.rejects(lstat(path.join(f.repository, "source")), { code: "ENOENT" });
    assert.equal(
      (await readdir(f.repository)).some((name) => name.includes(".issue-pilot-")),
      false,
    );
  } finally {
    await f.close();
  }
});

for (const operation of ["delete", "rename"] as const)
  test(`${operation}s source symlinks without changing their targets`, async () => {
    const f = await fixture();
    try {
      const target = path.join(f.repository, "target.txt");
      const link = path.join(f.repository, "link.txt");
      await writeFile(target, "preserve target\n");
      await symlink("target.txt", link);
      if (operation === "delete") {
        await f.browser.deletePath(f.issue, "application", "link.txt", false);
        await assert.rejects(lstat(link), { code: "ENOENT" });
      } else {
        await f.browser.renamePath(f.issue, "application", "link.txt", "renamed-link.txt", false);
        assert.equal(await readlink(path.join(f.repository, "renamed-link.txt")), "target.txt");
        await assert.rejects(lstat(link), { code: "ENOENT" });
      }
      assert.equal(await readFile(target, "utf8"), "preserve target\n");
      await symlink("missing.txt", path.join(f.repository, "dangling-link"));
      await f.browser.deletePath(f.issue, "application", "dangling-link", false);
      await assert.rejects(lstat(path.join(f.repository, "dangling-link")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

test("rejects source reads through aliases to Git control paths", async () => {
  const f = await fixture();
  try {
    await symlink(".git", path.join(f.repository, "control-alias"));
    await symlink(path.join(f.store, "config"), path.join(f.repository, "config-alias"));
    await assert.rejects(f.browser.tree(f.issue, "application", "control-alias"), /invalid_source_path/);
    await assert.rejects(f.browser.file(f.issue, "application", "config-alias"), /source_path_outside_repository/);
    await assert.rejects(f.browser.createFile(f.issue, "application", "control-alias/new.txt", "forbidden"), /invalid_source_path|source_path_outside_repository/);
    await f.browser.deletePath(f.issue, "application", "control-alias", false);
    assert.ok((await lstat(path.join(f.repository, ".git"))).isFile());
  } finally {
    await f.close();
  }
});

test("treats bracket characters in source paths literally when staging and discarding", async () => {
  const f = await fixture();
  try {
    for (const name of ["value[1].txt", "value1.txt"]) await writeFile(path.join(f.repository, name), "original\n");
    await f.git(["add", "."]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
    for (const name of ["value[1].txt", "value1.txt"]) await writeFile(path.join(f.repository, name), "changed\n");
    await f.browser.stage(f.issue, "application", ["value[1].txt"]);
    assert.equal(await f.git(["diff", "--cached", "--name-only"]), "value[1].txt");
    await f.browser.unstage(f.issue, "application", ["value[1].txt"]);
    await f.browser.discard(f.issue, "application", ["value[1].txt"]);
    assert.equal(await readFile(path.join(f.repository, "value[1].txt"), "utf8"), "original\n");
    assert.equal(await readFile(path.join(f.repository, "value1.txt"), "utf8"), "changed\n");
  } finally {
    await f.close();
  }
});

test("rejects a directory as a source blame file", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.repository, "folder"));
    await assert.rejects(f.browser.blame(f.issue, "application", "folder", 1), /source_path_not_file/);
  } finally {
    await f.close();
  }
});

test("rejects a FIFO blame target without opening or waiting for it", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const fifo = path.join(f.repository, "pipe.txt");
    const created = await executeLocalCommand("mkfifo", [fifo]);
    assert.equal(created.code, 0, created.stderr);
    const script = `
      import { SourceBrowser } from ${JSON.stringify(new URL("../../src/workspace/source-browser.ts", import.meta.url).href)};
      import { openDatabase } from ${JSON.stringify(new URL("../../src/db/client.ts", import.meta.url).href)};
      const database = openDatabase(process.argv[1]);
      try {
        await new SourceBrowser(database.db, process.argv[2]).blame({ id: process.argv[3], key: process.argv[4] }, "application", "pipe.txt", 1);
        console.log("unexpected_success");
      } catch (error) { console.log(error.message); }
      finally { await database.close(); }
    `;
    // A separate process makes a regression's blocking FIFO read safe to terminate.
    const result = await executeLocalCommand(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, path.join(f.root, "issues.db"), f.root, f.issue.id, f.issue.key], {
      timeout: 2_000,
    });
    assert.equal(result.killed, false, "blame must reject nonregular files without blocking");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "source_path_not_file");
  } finally {
    await f.close();
  }
});

test("reads history and commit changes for files deleted from the working tree", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "deleted.txt"), "historical contents\n");
    await f.git(["add", "deleted.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Add historical file"]);
    await rm(path.join(f.repository, "deleted.txt"));
    await f.git(["add", "-A"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Delete historical file"]);
    const head = await f.git(["rev-parse", "HEAD"]);
    const history = await f.browser.history(f.issue, "application", "deleted.txt");
    assert.deepEqual(
      history.commits.map((commit) => commit.subject),
      ["Delete historical file", "Add historical file"],
    );
    assert.deepEqual(await f.browser.commit(f.issue, "application", head, "deleted.txt"), { files: [{ path: "deleted.txt", status: "deleted", previousPath: null }], truncated: false });
    const compared = await f.browser.commitFile(f.issue, "application", head, "deleted.txt");
    assert.equal(compared.before?.content, "historical contents\n");
    assert.equal(compared.after, null);
    await assert.rejects(f.browser.history(f.issue, "application", ".git/config"), /invalid_source_path/);
  } finally {
    await f.close();
  }
});

test("labels staged and unstaged comparisons with their actual Git versions", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "versions.txt"), "head contents\n");
    await f.git(["add", "versions.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial version"]);
    await writeFile(path.join(f.repository, "versions.txt"), "index contents\n");
    await f.git(["add", "versions.txt"]);
    await writeFile(path.join(f.repository, "versions.txt"), "working contents\n");
    const staged = await f.browser.diffFile(f.issue, "application", "versions.txt", true);
    assert.deepEqual(staged.before, { path: "versions.txt", version: "head", content: "head contents\n" });
    assert.deepEqual(staged.after, { path: "versions.txt", version: "index", content: "index contents\n" });
    const working = await f.browser.diffFile(f.issue, "application", "versions.txt");
    assert.deepEqual(working.before, { path: "versions.txt", version: "index", content: "index contents\n" });
    assert.deepEqual(working.after, { path: "versions.txt", version: "working-tree", content: "working contents\n" });
  } finally {
    await f.close();
  }
});

test("reads literal Unicode replacement characters from Git and rejects malformed text bytes", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.repository, "unicode.txt");
    await writeFile(file, "before � text\n");
    await f.git(["add", "unicode.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Unicode text"]);
    await writeFile(file, "after � text\n");
    await f.git(["add", "unicode.txt"]);
    assert.equal((await f.browser.file(f.issue, "application", "unicode.txt")).content, "after � text\n");
    const compared = await f.browser.diffFile(f.issue, "application", "unicode.txt", true);
    assert.equal(compared.before?.content, "before � text\n");
    assert.equal(compared.after?.content, "after � text\n");
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8]), Buffer.from([0])]) {
      await writeFile(file, bytes);
      await f.git(["add", "unicode.txt"]);
      await assert.rejects(f.browser.diffFile(f.issue, "application", "unicode.txt", true), /source_file_binary/);
    }
  } finally {
    await f.close();
  }
});

test("paginates a pinned history without losing or repeating commits when HEAD advances", async () => {
  const f = await fixture();
  try {
    const count = issuePilotConfig.limits.sourceBrowser.historyCommits + 25;
    for (let index = 1; index < count; index++) await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", `Commit ${index}`]);
    const first = await f.browser.history(f.issue, "application");
    assert.equal(first.commits.length, issuePilotConfig.limits.sourceBrowser.historyCommits);
    assert.ok(first.nextCursor);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Arrived during pagination"]);
    const second = await f.browser.history(f.issue, "application", "", first.nextCursor);
    assert.equal(second.commits.length, 25);
    assert.equal(second.nextCursor, null);
    const combined = [...first.commits, ...second.commits];
    assert.equal(new Set(combined.map((commit) => commit.hash)).size, count);
    assert.equal(
      combined.some((commit) => commit.subject === "Arrived during pagination"),
      false,
    );
    assert.equal(second.commits.at(-1)?.subject, "Fixture baseline");
    await assert.rejects(f.browser.history(f.issue, "application", "", { revision: "invalid", offset: 1 }), /invalid_source_history_cursor/);
    await assert.rejects(f.browser.history(f.issue, "application", "", { revision: first.nextCursor.revision, offset: -1 }), /invalid_source_history_cursor/);
  } finally {
    await f.close();
  }
});

test("bounds a broad AI search and reports the remaining results explicitly", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "many.txt"), "AI await detail main\n".repeat(50_000));
    const result = await f.browser.search(f.issue, "application", "AI", { caseSensitive: false });
    assert.equal(result.matches.length, issuePilotConfig.limits.sourceBrowser.searchMatches);
    assert.equal(result.truncated, true);
    assert.equal(result.matches[0]?.column, 1);
    assert.equal(result.matches.at(-1)?.line, issuePilotConfig.limits.sourceBrowser.searchMatches);
  } finally {
    await f.close();
  }
});

test("cancels the running search process when the HTTP client disconnects", { timeout: 10_000 }, async () => {
  const f = await fixture(),
    app = Fastify({ logger: false });
  let entered!: () => void, cancelled!: () => void;
  const running = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
  const executor: CommandExecutor = {
    execute: async (_command, _args, options) =>
      new Promise((resolve) => {
        const stop = () => {
          cancelled();
          resolve({ code: 1, killed: true, stdout: "", stderr: "" });
        };
        options!.signal!.addEventListener("abort", stop, { once: true });
        entered();
        if (options!.signal!.aborted) stop();
      }),
  };
  registerSourceBrowserRoutes({ app, database: f.database, engine: new TestAgentController(), sourceBrowser: new SourceBrowser(f.database.db, f.root, executor) });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 }),
      controller = new AbortController();
    const request = fetch(`${address}/api/issues/${f.issue.key}/source/search`, { headers: { "X-Issue-Pilot-Repository": "application", "X-Issue-Pilot-Query": "AI" }, signal: controller.signal });
    const rejected = assert.rejects(request, { name: "AbortError" });
    await running;
    controller.abort();
    await rejected;
    await stopped;
  } finally {
    await app.close();
    await f.close();
  }
});

test("a UTF-8 byte order mark survives reading, saving and diffing a working file", async () => {
  const f = await fixture();
  try {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(path.join(f.repository, "bom.cs"), Buffer.concat([bom, Buffer.from("class A {}\n")]));
    await f.git(["add", "bom.cs"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "bom file"]);
    const original = await f.browser.file(f.issue, "application", "bom.cs");
    assert.equal(original.content, "﻿class A {}\n");
    await f.browser.writeFile(f.issue, "application", "bom.cs", "﻿class A {}\n// edited\n", original.sha256);
    const saved = await readFile(path.join(f.repository, "bom.cs"));
    assert.deepEqual(saved.subarray(0, 3), bom);
    // Only the edited line differs; the first line keeps its BOM on both sides.
    const comparison = await f.browser.diffFile(f.issue, "application", "bom.cs");
    assert.equal(comparison.before?.content.split("\n")[0], comparison.after?.content.split("\n")[0]);
  } finally {
    await f.close();
  }
});

test("the index side of a diff reads a file whose name starts with a digit and colon", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "x.txt"), "other file\n");
    await writeFile(path.join(f.repository, "0:x.txt"), "staged content\n");
    await f.git(["add", "--", "x.txt", "0:x.txt"]);
    await writeFile(path.join(f.repository, "0:x.txt"), "working content\n");
    const comparison = await f.browser.diffFile(f.issue, "application", "0:x.txt");
    assert.equal(comparison.before?.content, "staged content\n");
    assert.equal(comparison.after?.content, "working content\n");
  } finally {
    await f.close();
  }
});
