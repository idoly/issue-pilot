import { DomainError } from "../domain/errors.ts";
import { eq } from "drizzle-orm";
import { loadCapabilitySwitches } from "../configuration/capability-switches.ts";
import { issuesAffectedByCapabilityChange } from "../configuration/impact.ts";
import { capabilitySwitches } from "../db/schema.ts";
import { CAPABILITY_KEYS } from "../domain/contracts.ts";
import { choice, closedRecord } from "./input.ts";
import { requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

export function registerCapabilityRoutes(context: ApiRouteContext) {
  const { app, database, engine, runScopeExclusive } = context;

  app.get("/api/capabilities", async (_request, _reply) => {
    return runScopeExclusive(async () => (await loadCapabilitySwitches(database.db)).map((row) => ({ key: row.key, enabled: row.enabled })));
  });
  app.patch<{ Params: { key: string } }>("/api/capabilities/:key", async (request) => {
    await requireDeveloper(database, request);
    const key = choice(request.params.key, "capability", CAPABILITY_KEYS);
    const input = closedRecord(request.body, ["enabled"], "invalid_capability_switch");
    if (typeof input.enabled !== "boolean") throw new DomainError("invalid_capability_switch", "bad_request");
    const enabled = input.enabled;
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const current = (await loadCapabilitySwitches(database.db)).find((row) => row.key === key)!;
      if (current.enabled === enabled) return { key, enabled };
      const affected = await issuesAffectedByCapabilityChange(database.db, key);
      return runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          await database.db.update(capabilitySwitches).set({ enabled, updatedAt: new Date() }).where(eq(capabilitySwitches.key, key));
          return { key, enabled };
        },
        "capability_has_running_issues",
      );
    });
  });
}
