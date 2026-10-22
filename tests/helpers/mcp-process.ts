import { readFile, readdir } from "node:fs/promises";
/** MCP servers run in their own PID namespace, so their reported PID is not the host PID. */
export async function hostMcpPid(pidFile: string): Promise<number> {
  const expected = Buffer.from(`MCP_FIXTURE_PID_FILE=${pidFile}\0`);
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0");
      if (command[0] !== process.execPath || !command.some(part => part.endsWith("mcp-stdio-server.mjs"))) continue;
      if ((await readFile(`/proc/${pid}/environ`)).includes(expected)) return Number(pid);
    } catch {}
  }
  throw new Error("mcp_fixture_host_process_not_found");
}
