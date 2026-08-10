import { parentPort, workerData } from "node:worker_threads";

import { createClient } from "redis";

import { errorMessage } from "../domain/contracts.ts";
import { capabilityResultText } from "./contracts.ts";

type Input = {
  action: string;
  command: string[];
  connectTimeoutMs: number;
  config: { host: string; port: number; username: string; password?: string; database: number };
};

const input = workerData as Input;
const client = createClient({
  RESP: 2,
  socket: {
    host: input.config.host,
    port: input.config.port,
    connectTimeout: input.connectTimeoutMs,
    reconnectStrategy: false,
  },
  ...(input.config.username ? { username: input.config.username } : {}),
  ...(input.config.password ? { password: input.config.password } : {}),
  database: input.config.database,
  disableClientInfo: true,
});
client.on("error", () => {});

try {
  await client.connect();
  const output = await client.sendCommand(input.command);
  parentPort?.postMessage({ ok: true, text: capabilityResultText({ action: input.action, output }) });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: errorMessage(error) });
} finally {
  if (client.isOpen) client.destroy();
}
