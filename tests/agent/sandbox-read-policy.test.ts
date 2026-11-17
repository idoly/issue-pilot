import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { issueReadPolicy, prepareIssueCommand } from "../../src/agent/issue-sandbox.ts";
import { executeLocalCommand } from "../../src/process.ts";

const atOrUnder = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

test("the read policy denies the home directory and re-allows only tool and resource paths", () => {
  const home = "/home/operator",
    agent = path.join(home, ".pi/agent"),
    application = path.join(home, "issue-pilot"),
    state = path.join(application, "data"),
    root = path.join(state, "workspaces/ISSUE-20261117-001");
  const { denyRead, allowRead } = issueReadPolicy({
    root,
    application,
    agent,
    operatorAgent: agent,
    homes: [home, home, "/"],
    temporary: "/tmp",
    state,
    bridges: ["/tmp/srt-http.sock"],
    readRoots: [path.join(state, "workspaces/ISSUE-20261117-002")],
  });
  for (const denied of [
    "/tmp",
    home,
    path.join(home, ".ssh"),
    agent,
    path.join(agent, "auth.json"),
    path.join(agent, "mcp-auth.json"),
    path.join(agent, "models.json"),
    path.join(agent, "sessions"),
    state,
  ])
    assert.ok(denyRead.includes(denied), denied);
  assert.ok(!denyRead.includes("/"), "a root home is never denied wholesale");
  assert.deepEqual(
    new Set(allowRead),
    new Set([
      root,
      application,
      path.join(agent, "bin"),
      path.join(agent, "skills"),
      path.join(agent, "npm"),
      path.join(agent, "git"),
      path.join(home, ".local/bin"),
      path.join(home, ".local/lib"),
      path.join(home, ".agents/skills"),
      "/tmp/srt-http.sock",
      path.join(state, "workspaces/ISSUE-20261117-002"),
    ]),
  );
  const secrets = [
    ".local/state/issue-pilot-host/checkpoints/20261117T000000Z/database.sqlite",
    ".local/state/issue-pilot-host/application.log",
    ".local/share/issue-pilot-runtime/cutover.json",
    ".git-credentials",
    ".gitconfig",
    ".codex/auth.json",
    ".claude.json",
    ".claude/settings.json",
    ".npmrc",
    ".aliyun/config.json",
    ".config/git/github-credentials",
    ".cache/issue-pilot/x",
    ".bash_history",
    ".pi/agent/.models.json.swp",
    ".pi/agent/settings.json",
    ".pi/agent/trust.json",
    ".pi/agent/models-store.json",
    ".pi/agent/missions/x",
    "issue-pilot/data/issue-pilot.sqlite",
  ].map((name) => path.join(home, name));
  for (const secret of secrets) {
    assert.ok(
      denyRead.some((denied) => atOrUnder(denied, secret)),
      `${secret} is denied`,
    );
    // A secret stays hidden when the deepest covering deny is deeper than every covering allow.
    const deny = Math.max(...denyRead.filter((denied) => atOrUnder(denied, secret)).map((denied) => denied.length));
    const allow = Math.max(-1, ...allowRead.filter((allowed) => atOrUnder(allowed, secret)).map((allowed) => allowed.length));
    assert.ok(deny > allow, `${secret} is not re-allowed`);
  }
});

test("a test-selected agent directory never hides the Issue root and keeps the Operator secrets denied", () => {
  const root = "/srv/state/workspaces/ISSUE-20261117-001";
  const { denyRead } = issueReadPolicy({
    root,
    application: "/srv/app",
    agent: root,
    operatorAgent: "/home/operator/.pi/agent",
    homes: ["/home/operator"],
    temporary: "/tmp",
    bridges: [],
    readRoots: [],
  });
  assert.ok(!denyRead.includes(root));
  assert.ok(denyRead.includes(path.join(root, "auth.json")));
  assert.ok(denyRead.includes("/home/operator/.pi/agent/models.json"));
  assert.ok(denyRead.includes("/home/operator/.pi/agent"));
});

test("sandboxed commands cannot read home secrets but still read Pi skills and the Python user site", async () => {
  const base = await realpath(await mkdtemp("/tmp/issue-pilot-home-policy-"));
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const home = path.join(base, "home"),
    state = path.join(home, "state"),
    root = path.join(state, "workspaces", "ISSUE-20261117-001");
  const files = {
    checkpoint: path.join(home, ".local/state/issue-pilot-host/checkpoints/20261117T000000Z/database.sqlite"),
    credentials: path.join(home, ".git-credentials"),
    codex: path.join(home, ".codex/auth.json"),
    claude: path.join(home, ".claude.json"),
    npmrc: path.join(home, ".npmrc"),
    config: path.join(home, ".config/git/github-credentials"),
    swap: path.join(home, ".pi/agent/.models.json.swp"),
    settings: path.join(home, ".pi/agent/settings.json"),
    models: path.join(home, ".pi/agent/models.json"),
    database: path.join(state, "issue-pilot.sqlite"),
    skill: path.join(home, ".pi/agent/skills/fixture/SKILL.md"),
    site: path.join(home, ".local/lib/python3.13/site-packages/fixture.py"),
    own: path.join(root, "own.txt"),
  };
  try {
    for (const file of Object.values(files)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "fixture-content");
    }
    await mkdir(path.join(base, "tmp"));
    process.env.HOME = home;
    process.env.TMPDIR = path.join(base, "tmp");
    delete process.env.PI_CODING_AGENT_DIR;
    const script = Object.entries(files)
      .map(([name, file]) => `if cat '${file}' >/dev/null 2>&1; then echo ${name}=read; else echo ${name}=denied; fi`)
      .join("; ");
    const prepared = await prepareIssueCommand({ writeRoot: root, stateRoot: state }, ["/bin/sh", "-c", script]);
    try {
      const result = await executeLocalCommand(prepared.argv[0]!, prepared.argv.slice(1), { cwd: root, timeout: 15_000 });
      assert.equal(result.code, 0, result.stderr);
      const outcome = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=") as [string, string]),
      );
      assert.deepEqual(outcome, {
        checkpoint: "denied",
        credentials: "denied",
        codex: "denied",
        claude: "denied",
        npmrc: "denied",
        config: "denied",
        swap: "denied",
        settings: "denied",
        models: "denied",
        database: "denied",
        skill: "read",
        site: "read",
        own: "read",
      });
    } finally {
      await prepared.cleanup();
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
});

test("the nested application/state layout keeps the application readable and its state root hidden", async () => {
  const base = await realpath(await mkdtemp("/tmp/issue-pilot-home-nested-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const home = path.join(base, "home");
  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi/agent");
    const sibling = path.join(home, "issue-pilot"),
      state = path.join(sibling, "data"),
      root = path.join(state, "workspaces", "ISSUE-20261117-002");
    const files = {
      sibling: path.join(sibling, "src/fixture.ts"),
      database: path.join(state, "issue-pilot.sqlite"),
      checkpoint: path.join(home, ".local/state/issue-pilot-host/checkpoints/20261117T000000Z/database.sqlite"),
      credentials: path.join(home, ".git-credentials"),
      own: path.join(root, "own.txt"),
    };
    for (const file of Object.values(files)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "fixture-content");
    }
    // The real application directory is the one the sandbox re-allows; any other home child is hidden.
    const source = path.resolve(import.meta.dirname, "../../package.json");
    const script = [
      `if cat '${source}' >/dev/null 2>&1; then echo source=read; else echo source=denied; fi`,
      ...Object.entries(files).map(([name, file]) => `if cat '${file}' >/dev/null 2>&1; then echo ${name}=read; else echo ${name}=denied; fi`),
      `if printf written > '${path.join(root, "new.txt")}' 2>/dev/null; then echo write=allowed; else echo write=denied; fi`,
    ].join("; ");
    const prepared = await prepareIssueCommand({ writeRoot: root, stateRoot: state }, ["/bin/sh", "-c", script]);
    try {
      const result = await executeLocalCommand(prepared.argv[0]!, prepared.argv.slice(1), { cwd: root, timeout: 15_000 });
      assert.equal(result.code, 0, result.stderr);
      const outcome = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => line.split("=") as [string, string]),
      );
      assert.deepEqual(outcome, { source: "read", sibling: "denied", database: "denied", checkpoint: "denied", credentials: "denied", own: "read", write: "allowed" });
    } finally {
      await prepared.cleanup();
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(base, { recursive: true, force: true });
  }
});
