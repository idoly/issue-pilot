import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";

const [capability, configFile, requestFile] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, "utf8"));
const request = JSON.parse(await readFile(requestFile, "utf8"));

function authHeaders() {
  return config.username ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}

async function httpJson(requestPath, init = {}) {
  const baseUrl = capability === "es" ? config.url : `http://${config.host}:${config.managementPort}`;
  const path = capability === "es" ? requestPath.replace(/^\//, "") : requestPath;
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url, { ...init, redirect: "error", headers: { accept: "application/json", ...authHeaders(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`external_http_${response.status}`);
  return text ? JSON.parse(text) : null;
}

function redisCommand(parts) {
  return Buffer.concat([Buffer.from(`*${parts.length}\r\n`), ...parts.flatMap((part) => { const value = Buffer.from(String(part)); return [Buffer.from(`$${value.length}\r\n`), value, Buffer.from("\r\n")]; })]);
}

function parseResp(buffer, offset = 0) {
  const marker = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const line = buffer.subarray(offset + 1, lineEnd).toString();
  if (marker === "+") return { value: line, offset: lineEnd + 2 };
  if (marker === "-") throw new Error(`redis_error:${line.slice(0, 200)}`);
  if (marker === ":") return { value: Number(line), offset: lineEnd + 2 };
  if (marker === "$") {
    const length = Number(line);
    if (length === -1) return { value: null, offset: lineEnd + 2 };
    const end = lineEnd + 2 + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(lineEnd + 2, end).toString(), offset: end + 2 };
  }
  if (marker === "*") {
    const length = Number(line); const values = []; let current = lineEnd + 2;
    for (let index = 0; index < length; index += 1) { const parsed = parseResp(buffer, current); if (!parsed) return null; values.push(parsed.value); current = parsed.offset; }
    return { value: values, offset: current };
  }
  throw new Error("invalid_redis_response");
}

async function redisRead() {
  const socket = config.tls ? tls.connect({ host: config.host, port: config.port, servername: config.host }) : net.connect({ host: config.host, port: config.port });
  const commands = [];
  if (config.password) commands.push(config.username ? ["AUTH", config.username, config.password] : ["AUTH", config.password]);
  if (config.database) commands.push(["SELECT", String(config.database)]);
  commands.push(request.command);
  const expected = commands.length;
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0); const values = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("redis_timeout")); }, 15_000);
    socket.on("connect", () => socket.write(Buffer.concat(commands.map(redisCommand))));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (values.length < expected) { const parsed = parseResp(buffer); if (!parsed) break; values.push(parsed.value); buffer = buffer.subarray(parsed.offset); }
        if (values.length === expected) { clearTimeout(timer); socket.end(); resolve(values.at(-1)); }
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
    socket.on("error", reject);
  });
}

let output;
if (capability === "redis") {
  output = await redisRead();
} else if (capability === "es") {
  if (request.action === "mapping") output = await httpJson("/_mapping");
  else output = await httpJson(`/_${request.action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body) });
} else if (capability === "mq") {
  const vhost = encodeURIComponent(config.virtualHost);
  if (request.action === "overview") output = await httpJson("/api/overview");
  else if (request.action === "queues") output = await httpJson(`/api/queues/${vhost}`);
  else if (request.action === "queue") output = await httpJson(`/api/queues/${vhost}/${encodeURIComponent(request.queue)}`);
  else output = await httpJson(`/api/queues/${vhost}/${encodeURIComponent(request.queue)}/bindings`);
} else throw new Error("unsupported_external_capability");

process.stdout.write(JSON.stringify(output));
