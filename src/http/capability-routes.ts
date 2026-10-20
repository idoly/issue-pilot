import { eq, inArray } from "drizzle-orm";
import { loadCapabilitySwitches } from "../configuration/capability-switches.ts";
import { capabilitySwitches, environments, issues, serviceDeployments } from "../db/schema.ts";
import { CAPABILITY_KEYS } from "../domain/contracts.ts";
import { ApiError, choice, record } from "./input.ts";
import { requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

export function registerCapabilityRoutes(context: ApiRouteContext) {
  const { app, database, engine, runScopeExclusive } = context;

  app.get("/api/capabilities", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(async () => (await loadCapabilitySwitches(database.db)).map((row) => ({ key: row.key, enabled: row.enabled })));
  });
  app.patch<{ Params: { key: string } }>("/api/capabilities/:key", async (request) => {
    await requireDeveloper(database, request);
    const key = choice(request.params.key, "capability", CAPABILITY_KEYS);
    const input = record(request.body);
    if (typeof input.enabled !== "boolean" || Object.keys(input).some((field) => field !== "enabled")) throw new ApiError(400, "invalid_capability_switch");
    const enabled = input.enabled;
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const current = (await loadCapabilitySwitches(database.db)).find((row) => row.key === key)!;
      if (current.enabled === enabled) return { key, enabled };
      const deployments = (await database.db.select().from(serviceDeployments)).filter((row) => Boolean(row.config[key]));
      const environmentIds = [...new Set([...deployments.map(row => row.environmentId), ...(deployments.length ? (await database.db.select({ id: environments.id }).from(environments).where(eq(environments.kind, "dev"))).map(row => row.id) : [])])];
      const affected = environmentIds.length ? await database.db.select({ id: issues.id }).from(issues).where(inArray(issues.environmentId, environmentIds)) : [];
      try {
        return await runIssueExclusive(engine, affected.map((row) => row.id), async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          await database.db.transaction(async (transaction) => {
            await transaction.update(capabilitySwitches).set({ enabled, updatedAt: new Date() }).where(eq(capabilitySwitches.key, key));
          });
          return { key, enabled };
        });
      } catch (error) {
        if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "capability_has_running_issues");
        throw error;
      }
    });
  });
}
