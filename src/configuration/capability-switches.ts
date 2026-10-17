import type { Database } from "../db/client.ts";
import { capabilitySwitches } from "../db/schema.ts";
import { CAPABILITY_KEYS } from "../domain/contracts.ts";

export async function loadCapabilitySwitches(database: Pick<Database, "select">) {
  const rows = await database.select().from(capabilitySwitches);
  if (rows.length !== CAPABILITY_KEYS.length || CAPABILITY_KEYS.some((key) => !rows.some((row) => row.key === key))) throw new Error("capability_switches_invalid");
  return CAPABILITY_KEYS.map((key) => rows.find((row) => row.key === key)!);
}

export async function loadEnabledCapabilities(database: Pick<Database, "select">) {
  return (await loadCapabilitySwitches(database)).filter((row) => row.enabled).map((row) => row.key);
}
