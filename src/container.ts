export interface ContainerMount {
  source: string;
  target: string;
  access: "ro" | "rw";
  relabel?: "shared" | "private";
}

export interface EphemeralContainerOptions {
  image: string;
  command: readonly string[];
  label: string;
  pids: number;
  memory: string;
  uid: number;
  gid: number;
  networkHost?: boolean;
  environment?: Readonly<Record<string, string>>;
  mounts?: readonly ContainerMount[];
  tmpfs?: readonly string[];
  workdir?: string;
}

function invalid(value: string): boolean {
  return !value || value.includes("\0") || value.includes("\n");
}

function containerPath(value: string): boolean {
  return value.startsWith("/") && !invalid(value) && !value.includes(":");
}

export function ephemeralContainerArgs(options: EphemeralContainerOptions): string[] {
  if (invalid(options.image) || invalid(options.label) || !Number.isSafeInteger(options.pids) || options.pids <= 0 || !/^\d+[kmgt]?$/i.test(options.memory) || !Number.isSafeInteger(options.uid) || options.uid < 0 || !Number.isSafeInteger(options.gid) || options.gid < 0) throw new Error("invalid_container_configuration");
  if (options.workdir && !containerPath(options.workdir)) throw new Error("invalid_container_configuration");
  const args = [
    "run", "--rm", "--pull", "never",
    "--label", options.label,
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--pids-limit", String(options.pids), "--memory", options.memory,
    "--read-only", "--userns", "keep-id", "--user", `${options.uid}:${options.gid}`,
  ];
  if (options.networkHost) args.push("--network", "host");
  for (const [name, value] of Object.entries(options.environment ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || value.includes("\0")) throw new Error("invalid_container_configuration");
    args.push("--env", `${name}=${value}`);
  }
  for (const mount of options.mounts ?? []) {
    if (!containerPath(mount.source) || !containerPath(mount.target)) throw new Error("invalid_container_configuration");
    const relabel = mount.relabel === "shared" ? ",z" : mount.relabel === "private" ? ",Z" : "";
    args.push("--volume", `${mount.source}:${mount.target}:${mount.access}${relabel}`);
  }
  for (const tmpfs of options.tmpfs ?? []) {
    if (invalid(tmpfs) || !tmpfs.startsWith("/")) throw new Error("invalid_container_configuration");
    args.push("--tmpfs", tmpfs);
  }
  if (options.workdir) args.push("--workdir", options.workdir);
  if (options.command.some((argument) => argument.includes("\0"))) throw new Error("invalid_container_configuration");
  args.push(options.image, ...options.command);
  return args;
}
