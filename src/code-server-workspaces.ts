import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

import { prepareCodeTerminalFiles } from "./code-terminal-files.ts";
import { isIssueKey } from "./issue-keys.ts";

const execFileAsync = promisify(execFile);

export class CodeServerWorkspaceManager {
  private readonly stateRoot: string;
  private readonly workspaceRoot: string;
  private readonly passwordFile: string;
  private readonly scriptPath: string;
  private readonly portBase: number;
  private readonly publicHost: string;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.workspaceRoot = resolve(this.stateRoot, "workspaces");
    this.passwordFile = resolve(process.env.CODE_SERVER_PASSWORD_FILE ?? resolve(this.stateRoot, "secrets", "code-server-password"));
    this.scriptPath = resolve(process.env.CODE_SERVER_WORKSPACE_SCRIPT ?? resolve(process.cwd(), "infra", "workspace-podman.sh"));
    this.portBase = Number(process.env.CODE_SERVER_PORT_BASE ?? 18_000);
    this.publicHost = process.env.CODE_SERVER_PUBLIC_HOST ?? "127.0.0.1";
    if (!Number.isInteger(this.portBase) || this.portBase < 1024 || this.portBase > 45_000) throw new Error("invalid CODE_SERVER_PORT_BASE");
  }

  async ensure(issueKey: string, workspacePath: string): Promise<string> {
    if (!isIssueKey(issueKey)) throw new Error("invalid issue ID for code-server");
    const legacyNumber = /^ISSUE-([0-9]{4,})$/i.exec(issueKey)?.[1];
    const issueNumber = legacyNumber ? Number(legacyNumber) : Number.parseInt(createHash("sha256").update(issueKey.toUpperCase()).digest("hex").slice(0, 8), 16);
    if (!Number.isSafeInteger(issueNumber)) throw new Error("invalid issue ID for code-server");
    const resolvedWorkspace = resolve(workspacePath);
    const relativeWorkspace = relative(this.workspaceRoot, resolvedWorkspace);
    if (!relativeWorkspace || relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace)) throw new Error("invalid code-server workspace path");
    await Promise.all([access(resolvedWorkspace), access(this.passwordFile), access(this.scriptPath)]);
    await Promise.all([prepareCodeTerminalFiles(issueKey, resolvedWorkspace), this.writeUserConfiguration(resolvedWorkspace)]);

    const port = this.portBase + (issueNumber % 20_000);
    if (port > 65_535) throw new Error("code-server port is out of range");
    const containerName = `issue-agent-workspace-${issueKey.toLowerCase()}`;
    const ready = await execFileAsync("podman", ["inspect", containerName], { timeout: 15_000 }).then(
      ({ stdout }) => {
        const inspected = JSON.parse(stdout) as Array<{ State?: { Running?: boolean }; Mounts?: Array<{ Destination?: string }> }>;
        const destinations = new Set(inspected[0]?.Mounts?.map((mount) => mount.Destination));
        return inspected[0]?.State?.Running === true
          && destinations.has("/run/issue-pilot")
          && destinations.has("/usr/local/bin/pi")
          && destinations.has("/home/coder/.local/share/code-server/User");
      },
      () => false,
    );
    if (!ready) {
      await execFileAsync(this.scriptPath, ["create", issueKey, resolvedWorkspace, String(port), this.passwordFile], {
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
    }
    return `http://${this.publicHost}:${port}/`;
  }

  private async writeUserConfiguration(workspacePath: string): Promise<void> {
    const userDirectory = resolve(workspacePath, ".issue-pilot", "code-server-user");
    await mkdir(userDirectory, { recursive: true, mode: 0o700 });
    const settings = {
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
      "git.autofetch": true,
      "git.confirmSync": true,
      "git.openRepositoryInParentFolders": "never",
      "terminal.integrated.defaultProfile.linux": "Issue Pilot Bash",
      "terminal.integrated.profiles.linux": {
        "Issue Pilot Bash": { path: "/bin/bash", args: ["-l"] },
      },
      "terminal.integrated.cwd": "${workspaceFolder}",
      "terminal.integrated.scrollback": 20_000,
      "terminal.integrated.shellIntegration.enabled": true,
      "terminal.integrated.sendKeybindingsToShell": true,
      "terminal.integrated.allowChords": false,
      "terminal.integrated.copyOnSelection": true,
      "terminal.integrated.env.linux": {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PI_HARDWARE_CURSOR: "1",
      },
    };
    const keybindings = [
      { key: "shift+enter", command: "workbench.action.terminal.sendSequence", args: { text: "\u001b[13;2u" }, when: "terminalFocus" },
      { key: "alt+enter", command: "workbench.action.terminal.sendSequence", args: { text: "\u001b[13;3u" }, when: "terminalFocus" },
      { key: "ctrl+p", command: "workbench.action.terminal.sendSequence", args: { text: "\u0010" }, when: "terminalFocus" },
      { key: "ctrl+shift+p", command: "workbench.action.terminal.sendSequence", args: { text: "\u001b[112;6u" }, when: "terminalFocus" },
      { key: "shift+tab", command: "workbench.action.terminal.sendSequence", args: { text: "\u001b[Z" }, when: "terminalFocus" },
      { key: "ctrl+l", command: "workbench.action.terminal.sendSequence", args: { text: "\u000c" }, when: "terminalFocus" },
      { key: "ctrl+o", command: "workbench.action.terminal.sendSequence", args: { text: "\u000f" }, when: "terminalFocus" },
      { key: "ctrl+t", command: "workbench.action.terminal.sendSequence", args: { text: "\u0014" }, when: "terminalFocus" },
      { key: "ctrl+x", command: "workbench.action.terminal.sendSequence", args: { text: "\u0018" }, when: "terminalFocus" },
    ];
    const files = [
      [resolve(userDirectory, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`],
      [resolve(userDirectory, "keybindings.json"), `${JSON.stringify(keybindings, null, 2)}\n`],
    ] as const;
    await Promise.all(files.map(async ([file, content]) => {
      await writeFile(file, content, { mode: 0o600 });
      await chmod(file, 0o600);
    }));
    await chmod(userDirectory, 0o700);
  }
}
