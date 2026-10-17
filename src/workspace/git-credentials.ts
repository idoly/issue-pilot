import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { userCredentials } from "../db/schema.ts";

export interface PersonalGitEnvironment { env: Record<string, string>; close(): Promise<void> }

export async function createPersonalGitEnvironment(credentials: Pick<typeof userCredentials.$inferSelect, "gitPrivateKey"> | undefined, urls: string[]): Promise<PersonalGitEnvironment> {
  const remoteUrls = urls.filter((url) => !url.startsWith("file:") && !path.isAbsolute(url));
  if (remoteUrls.some((url) => !url.startsWith("ssh://") && !/^[^/]+@[^:]+:/.test(url))) throw new Error("personal_git_ssh_url_required");
  if (remoteUrls.length && !credentials?.gitPrivateKey) throw new Error("user_git_ssh_credentials_required");
  const directory = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-"));
  try {
    await chmod(directory, 0o700);
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "http.extraHeader", GIT_CONFIG_VALUE_1: "",
    };
    if (remoteUrls.length) {
      const key = path.join(directory, "identity");
      await writeFile(key, credentials!.gitPrivateKey, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -F /dev/null -i '${key.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes`;
    }
    return { env, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
