import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function prepareCodeTerminalFiles(issueKey: string, workspaceRoot: string): Promise<void> {
  if (!/^ISSUE-[0-9]{4,}$/i.test(issueKey)) throw new Error("invalid issue ID for pi terminal files");
  const bridgeDirectory = path.join(workspaceRoot, ".issue-pilot");
  const binaryDirectory = path.join(bridgeDirectory, "bin");
  const tokenFile = path.join(bridgeDirectory, "pi-terminal-token");
  await mkdir(binaryDirectory, { recursive: true, mode: 0o700 });
  if (!await exists(tokenFile)) await writeFile(tokenFile, `${randomUUID()}\n`, { mode: 0o600 });
  const launcher = `#!/usr/bin/env bash
set -euo pipefail
exec /usr/lib/code-server/lib/node /home/coder/project/.issue-pilot/bin/pi-client.mjs
`;
  const client = `import fs from "node:fs";
import net from "node:net";
const socketPath = "/run/issue-pilot/pi-pty.sock";
const token = fs.readFileSync("/home/coder/project/.issue-pilot/pi-terminal-token", "utf8").trim();
const issueKey = ${JSON.stringify(issueKey)};
const dimensions = () => ({ cols: Math.max(20, Math.min(400, process.stdout.columns ?? 100)), rows: Math.max(5, Math.min(200, process.stdout.rows ?? 30)) });
const send = (message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\\n"); };
const socket = net.createConnection(socketPath);
const wasRaw = process.stdin.isRaw;
const cleanup = () => { if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause(); };
socket.once("connect", () => { send({ type: "auth", issueKey, token, ...dimensions() }); if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.resume(); });
socket.on("data", (chunk) => process.stdout.write(chunk));
socket.once("error", (error) => { cleanup(); console.error("Issue Pilot pi PTY connection failed:", error.message); process.exitCode = 1; });
socket.once("close", cleanup);
process.stdin.on("data", (chunk) => send({ type: "input", data: chunk.toString("base64") }));
process.stdin.once("end", () => { send({ type: "detach" }); socket.end(); });
process.on("SIGWINCH", () => send({ type: "resize", ...dimensions() }));
process.on("SIGTERM", () => { send({ type: "detach" }); socket.end(); });
`;
  const launcherFile = path.join(binaryDirectory, "pi");
  const clientFile = path.join(binaryDirectory, "pi-client.mjs");
  await Promise.all([
    writeFile(launcherFile, launcher, { mode: 0o700 }),
    writeFile(clientFile, client, { mode: 0o600 }),
  ]);
  await Promise.all([chmod(tokenFile, 0o600), chmod(launcherFile, 0o700), chmod(clientFile, 0o600)]);
}
