import { issuePilotConfig } from "../issue-pilot.config.ts";

const key = process.argv[2];
if (!key) throw new Error("configuration_key_required");

let value = issuePilotConfig;
for (const segment of key.split(".")) {
  if (!value || typeof value !== "object" || !(segment in value)) throw new Error(`configuration_key_not_found:${key}`);
  value = value[segment];
}

if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
  throw new Error(`configuration_value_not_scalar:${key}`);
}
process.stdout.write(String(value));
