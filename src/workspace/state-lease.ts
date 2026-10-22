import { createConnection, createServer, type Server } from "node:net";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

/** Exclusive application lifetime. The legacy pathname keeps old binaries and offline migrations interlocked. No RPC is served. */
export class ApplicationStateLease {
  readonly socketPath: string;
  private server: Server | undefined;
  private identity: { dev: bigint; ino: bigint } | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(stateRoot: string) { this.socketPath = path.join(path.resolve(stateRoot), "control", "project-tools.sock"); }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    const previous = this.closing; this.closing = undefined;
    const starting = this.startLocked(previous); this.starting = starting;
    const settled = () => { if (this.starting === starting) this.starting = undefined; };
    void starting.then(settled, settled); return starting;
  }
  private async startLocked(previous?: Promise<void>): Promise<void> {
    await previous; if (this.server) return;
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.socketPath), 0o700);
    const metadata = await lstat(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (metadata) {
      if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o600) throw new Error("application_control_socket_invalid");
      const active = await new Promise<boolean>((resolve, reject) => {
        const socket = createConnection(this.socketPath);
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("application_lease_probe_timeout")); }, 1000);
        socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); if (["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) resolve(false); else reject(error); });
      });
      if (active) throw new Error("application_already_running");
      const current = await lstat(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (current && current.dev === metadata.dev && current.ino === metadata.ino) await rm(this.socketPath);
      else if (current) throw new Error("application_control_socket_changed");
    }
    const server = createServer(socket => socket.destroy()); this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const error = (failure: Error) => { server.off("listening", listening); reject(failure); };
        const listening = () => { server.off("error", error); resolve(); };
        server.once("error", error); server.once("listening", listening); server.listen(this.socketPath);
      });
      const file = await lstat(this.socketPath, { bigint: true }); this.identity = { dev: file.dev, ino: file.ino };
      await chmod(this.socketPath, 0o600);
    } catch (error) { this.server = undefined; server.close(); await this.removeOwnedSocket(); throw error; }
  }
  close(): Promise<void> { return this.closing ??= this.closeLocked(this.starting); }
  private async closeLocked(starting?: Promise<void>): Promise<void> {
    await starting?.catch(() => undefined);
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await this.removeOwnedSocket();
  }
  private async removeOwnedSocket(): Promise<void> {
    const identity = this.identity; this.identity = undefined; if (!identity) return;
    const metadata = await lstat(this.socketPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (metadata?.isSocket() && metadata.dev === identity.dev && metadata.ino === identity.ino) await rm(this.socketPath);
  }
}
