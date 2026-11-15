import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Fixture commits use one fixed identity so tests never depend on the host's Git configuration. */
const fixtureIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.test"];

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs fixture Git with the fixed identity and returns trimmed stdout. */
export async function git(args: string[], options: GitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", [...fixtureIdentity, ...args], { encoding: "utf8", ...options });
  return stdout.trim();
}

export interface BareRemoteOptions {
  /** Working source directory name under root. */
  source?: string;
  /** Bare remote directory name under root. */
  remote?: string;
  branch?: string;
  /** Initial commit content keyed by relative path. */
  files?: Record<string, string>;
  /** Branches created at the initial commit before cloning. */
  extraBranches?: string[];
}

/** Creates a one-commit source repository and a bare clone of it. */
export async function createBareRemote(root: string, options: BareRemoteOptions = {}): Promise<{ source: string; remote: string }> {
  const source = path.join(root, options.source ?? "source");
  const remote = path.join(root, options.remote ?? "remote.git");
  await git(["init", "-b", options.branch ?? "main", source]);
  for (const [name, content] of Object.entries(options.files ?? { "README.md": "baseline\n" })) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), content, "utf8");
  }
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "initial"]);
  for (const branch of options.extraBranches ?? []) await git(["-C", source, "branch", branch]);
  await git(["clone", "--bare", source, remote]);
  return { source, remote };
}
