import { constants } from "node:fs";
import { access, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Runs inside SRT. Proxychains also routes TCP clients that ignore HTTP_PROXY (for example mysql2).
const [root, config, ...command] = process.argv.slice(2);
try {
  if (!root || !config || path.dirname(config) !== root || !/^\.runtime-proxy-[0-9a-f-]+\.conf$/.test(path.basename(config)) || !command.length) throw new Error("invalid_issue_network_command");
  const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "");
  const user = decodeURIComponent(proxy.username), password = decodeURIComponent(proxy.password);
  if (!["127.0.0.1", "localhost"].includes(proxy.hostname) || !/^\d+$/.test(proxy.port) || !/^[A-Za-z0-9_.=-]+$/.test(user) || !/^[A-Za-z0-9_.=-]+$/.test(password)) throw new Error("invalid_issue_network_proxy");
  const content = `strict_chain\nproxy_dns\nlocalnet 127.0.0.1/255.255.255.255\nlocalnet ::1/128\n[ProxyList]\nhttp 127.0.0.1 ${proxy.port} ${user} ${password}\n`;
  const existing = await lstat(config).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing) { if (!existing.isFile() || (existing.mode & 0o7777) !== 0o600 || await readFile(config, "utf8") !== content) throw new Error("issue_network_config_changed"); }
  else await writeFile(config, content, { flag: "wx", mode: 0o600 });
  // SRT supplies proxy SSH/config entries after spawn. Compose personal identity instead of losing either side.
  const personalSsh = process.env.ISSUE_PILOT_PERSONAL_GIT_SSH;
  if (personalSsh !== undefined) {
    const sandboxSsh = process.env.GIT_SSH_COMMAND;
    if (!personalSsh.startsWith("ssh ") || !sandboxSsh?.startsWith("ssh ")) throw new Error("invalid_issue_git_ssh_environment");
    process.env.GIT_SSH_COMMAND = `${personalSsh} ${sandboxSsh.slice(4)}`;
    delete process.env.ISSUE_PILOT_PERSONAL_GIT_SSH;
  }
  const personalConfig = process.env.ISSUE_PILOT_GIT_CONFIG;
  if (personalConfig !== undefined) {
    const entries: unknown = JSON.parse(personalConfig);
    let count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
    if (!Array.isArray(entries) || entries.length > 128 || !Number.isInteger(count) || count < 0 || count > 1024) throw new Error("invalid_issue_git_environment");
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("invalid_issue_git_environment");
      process.env[`GIT_CONFIG_KEY_${count}`] = entry[0];
      process.env[`GIT_CONFIG_VALUE_${count++}`] = entry[1];
    }
    process.env.GIT_CONFIG_COUNT = String(count);
    delete process.env.ISSUE_PILOT_GIT_CONFIG;
  }
  process.env.TMPDIR = root;
  process.env.XDG_CACHE_HOME = path.join(root, ".cache");
  process.env.NPM_CONFIG_CACHE = path.join(root, ".npm-cache");
  const quoted = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  process.env.JAVA_TOOL_OPTIONS = `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.io.tmpdir="${quoted(root)}" -Dmaven.repo.local="${quoted(path.join(root, ".maven-cache"))}"`.trim();
  let executable: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const selected = path.join(directory, "proxychains4");
    try { await access(selected, constants.X_OK); executable = selected; break; } catch { /* Continue the normal PATH lookup. */ }
  }
  if (!executable || !process.execve) throw new Error("issue_network_runtime_unavailable");
  process.execve(executable, [executable, "-q", "-f", config, ...command], process.env);
} catch (error) {
  const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "issue_network_runtime_failed";
  process.stderr.write(code + "\n"); process.exitCode = 1;
}
