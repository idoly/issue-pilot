import { readFile } from "node:fs/promises";

const [profileFile, dataId, group] = process.argv.slice(2);
if (!profileFile || !dataId || !group) throw new Error("nacos_read_arguments_required");
const profile = JSON.parse(await readFile(profileFile, "utf8"));
if (!profile || typeof profile !== "object") throw new Error("invalid_nacos_profile");

const protocol = profile.scheme === "https" ? "https:" : "http:";
const host = String(profile.host ?? "");
const port = Number(profile.port);
const namespace = String(profile.namespace ?? "");
if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_nacos_profile");
if (!/^[a-zA-Z0-9._-]{1,255}$/.test(dataId) || !/^[a-zA-Z0-9._-]{1,255}$/.test(group)) throw new Error("invalid_nacos_target");

let accessToken = "";
if (profile.username) {
  const login = new URL("/nacos/v1/auth/login", `${protocol}//${host}:${port}`);
  const response = await fetch(login, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: String(profile.username), password: String(profile.password ?? "") }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`nacos_login_failed:${response.status}`);
  const payload = await response.json();
  accessToken = String(payload.accessToken ?? payload.data?.accessToken ?? "");
  if (!accessToken) throw new Error("nacos_login_token_missing");
}

const endpoint = new URL("/nacos/v1/cs/configs", `${protocol}//${host}:${port}`);
endpoint.searchParams.set("dataId", dataId);
endpoint.searchParams.set("group", group);
if (namespace) endpoint.searchParams.set("tenant", namespace);
if (accessToken) endpoint.searchParams.set("accessToken", accessToken);
const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`nacos_configuration_read_failed:${response.status}`);
process.stdout.write(await response.text());
