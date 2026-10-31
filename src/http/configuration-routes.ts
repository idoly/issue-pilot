import { deploymentDbHubTargets } from "../configuration/dbhub.ts";
import { resolveDmsScope } from "../capabilities/dms.ts";
import { CapabilityConfigurationError } from "../capabilities/registry.ts";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { saveGlobalAgentConfiguration, validateGlobalAgentConfiguration } from "../configuration/agent.ts";
import { AgentRuntimeConfigurationError, inspectAgentResources, parseAgentRuntime } from "../configuration/pi-runtime.ts";
import { loadConfiguration, loadConfigurationCatalog, loadServiceConfigurationDescription } from "../configuration/read.ts";
import { selectDmsCredentials } from "../configuration/user-credentials.ts";
import { applicationSettings, userCredentials, environments, issues, issueServiceScopes, serviceDeployments, services } from "../db/schema.ts";
import { AGENT_CODEMODE_MODES, AGENT_THINKING_LEVELS } from "../domain/contracts.ts";
import { ApiError, checkRevision, choice, optionalText, record, text } from "./input.ts";
import { requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
import { applyServiceConfiguration, prepareServiceConfiguration } from "./service-configuration.ts";

function uniqueServiceKey(name: string, existingKeys: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90).replace(/-+$/g, "");
  const base = slug || `service-${randomUUID().slice(0, 8)}`;
  if (!existingKeys.has(base)) return base;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function registerConfigurationRoutes(context: ApiRouteContext): void {
  const { app, database, engine, modelCatalog, runScopeExclusive } = context;
  const findServiceByKey = async (key: string) => (await database.db.select().from(services).where(eq(services.key, key)).limit(1))[0];

  // Any Issue in these environments may query this service, even if its entry
  // service differs. Config updates therefore invalidate all such sessions.
  const affectedIssues = async (serviceId: string, environmentKeys: string[] = [], globalMcp?: boolean) => {
    const deployments = await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId));
    if (globalMcp ?? deployments.some(row => row.config.mysql?.length || row.config.dbhub?.length)) return database.db.select({ id: issues.id }).from(issues);
    const added = environmentKeys.length ? await database.db.select().from(environments).where(inArray(environments.key, environmentKeys)) : [];
    const ids = [...new Set([...deployments.map((row) => row.environmentId), ...added.map((row) => row.id), ...(await database.db.select({ id: environments.id }).from(environments).where(eq(environments.kind, "dev"))).map(row => row.id)])];
    return ids.length ? database.db.select({ id: issues.id }).from(issues).where(inArray(issues.environmentId, ids)) : [];
  };
  const mysqlChanged = (prepared: Awaited<ReturnType<typeof prepareServiceConfiguration>>) => {
    const incoming = prepared.parsed.deployments;
    const targets = (config: Parameters<typeof deploymentDbHubTargets>[0]) => JSON.stringify({ mysql: config.mysql ?? [], dbhub: config.dbhub ?? [] });
    return incoming.some(row => targets(row.config) !== targets(prepared.existingDeployments.find(old => old.environmentId === prepared.environmentsByKey.get(row.environmentKey)?.id)?.config ?? {}))
      || prepared.existingDeployments.some(old => (old.config.mysql?.length || old.config.dbhub?.length) && !incoming.some(row => prepared.environmentsByKey.get(row.environmentKey)?.id === old.environmentId));
  };
  app.get<{ Params: { key: string } }>("/api/services/:key/dbhub-targets", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new ApiError(404, "service_not_found");
      const deployments = await database.db.select({ environmentKey: environments.key, config: serviceDeployments.config }).from(serviceDeployments)
        .innerJoin(environments, eq(environments.id, serviceDeployments.environmentId)).where(eq(serviceDeployments.serviceId, service.id));
      return { revision: service.revision, deployments: deployments.map(row => ({ environmentKey: row.environmentKey, dbhub: deploymentDbHubTargets(row.config) })) };
    });
  });
  app.get<{ Params: { key: string } }>("/api/services/:key/mysql-targets", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new ApiError(404, "service_not_found");
      const deployments = await database.db.select({ environmentKey: environments.key, config: serviceDeployments.config }).from(serviceDeployments)
        .innerJoin(environments, eq(environments.id, serviceDeployments.environmentId)).where(eq(serviceDeployments.serviceId, service.id));
      return { revision: service.revision, deployments: deployments.map(row => ({ environmentKey: row.environmentKey, mysql: row.config.mysql ?? [] })) };
    });
  });
  app.get<{ Params: { key: string } }>("/api/services/:key/configuration-description", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      try {
        const value = await loadServiceConfigurationDescription(database.db, request.params.key);
        if (!value) throw new ApiError(404, "service_not_found");
        return value;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, "service_configuration_description_failed");
      }
    });
  });
  app.post("/api/dms/scope/resolve", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireDeveloper(database, request);
    const input = record(request.body);
    try {
      const connection = await runScopeExclusive(async () => {
        const actor = await requireDeveloper(database, request);
        if (Object.keys(input).some(key => !["instanceAlias", "schemaName"].includes(key))) throw new ApiError(400, "invalid_dms_scope_request");
        const [personal] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, actor)).limit(1);
        const [shared] = await database.db.select({ credentials: applicationSettings.sharedDmsCredentials }).from(applicationSettings).where(eq(applicationSettings.id, 1)).limit(1);
        try { return selectDmsCredentials(personal, shared?.credentials); }
        catch (error) { throw new ApiError(400, error instanceof Error ? error.message : "dms_credentials_not_configured"); }
      });
      return await resolveDmsScope(connection, text(input.instanceAlias, "dms_instance_alias", 255), text(input.schemaName, "dms_schema_name", 255));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message);
      throw new ApiError(502, error instanceof Error && /^(?:dms_[a-z_]+|dms_mcp_http_[45]\d{2})$/.test(error.message) ? error.message : "dms_scope_resolve_failed");
    }
  });
  app.get("/api/catalog", async (_request, reply) => { reply.header("Cache-Control", "private, no-store"); return runScopeExclusive(() => loadConfigurationCatalog(database.db)); });
  app.get("/api/config", async (_request, reply) => { reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache"); return runScopeExclusive(() => loadConfiguration(database.db, modelCatalog)); });
  app.put("/api/config/agent", async (request) => runScopeExclusive(async () => {
    await requireDeveloper(database, request);
    const input = record(request.body);
    let runtime;
    try { runtime = parseAgentRuntime(input.runtime); }
    catch (error) { if (error instanceof AgentRuntimeConfigurationError) throw new ApiError(400, error.message); throw error; }
    const configuration = { provider: text(input.provider, "agent_provider", 200), model: text(input.model, "agent_model", 500), thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS), codemode: choice(input.codemode, "agent_codemode", AGENT_CODEMODE_MODES), runtime };
    try { validateGlobalAgentConfiguration(configuration, await modelCatalog.list()); }
    catch (error) { if (error instanceof Error && ["agent_model_not_available", "agent_thinking_level_not_supported"].includes(error.message)) throw new ApiError(400, error.message); throw error; }
    const affected = await database.db.select({ id: issues.id }).from(issues);
    try {
      return await runIssueExclusive(engine, affected.map((row) => row.id), async (reservation) => {
        for (const row of affected) await reservation.closeSession(row.id);
        await database.db.transaction((transaction) => saveGlobalAgentConfiguration(transaction, configuration));
        return { ok: true };
      });
    } catch (error) { if (error instanceof Error && error.message === "issue_already_running") throw new ApiError(409, "global_configuration_has_running_issues"); throw error; }
  }));
  app.get("/api/config/agent/resources", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      try { return await inspectAgentResources(); }
      catch (error) { if (error instanceof AgentRuntimeConfigurationError) throw new ApiError(400, error.message); throw new ApiError(400, "agent_resources_inspection_failed"); }
    });
  });
  app.post("/api/services", async (request, reply) => {
    await requireDeveloper(database, request);
    const input = record(request.body); const name = text(input.name, "name", 200); const description = optionalText(input.description) ?? "";
    const created = await runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const serviceId = randomUUID();
      const [existing, prepared] = await Promise.all([database.db.select({ key: services.key }).from(services), prepareServiceConfiguration({ executor: database.db, serviceId, input })]);
      const key = uniqueServiceKey(name, new Set(existing.map((row) => row.key)));
      const affected = await affectedIssues(serviceId, prepared.parsed.deployments.map(row => row.environmentKey), mysqlChanged(prepared));
      try {
        return await runIssueExclusive(engine, affected.map(row => row.id), async reservation => {
          for (const row of affected) await reservation.closeSession(row.id);
          return database.db.transaction(async (transaction) => { const [row] = await transaction.insert(services).values({ id: serviceId, key, name, description }).returning(); await applyServiceConfiguration({ executor: transaction, serviceId, prepared }); return row!; });
        });
      } catch (error) { if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "service_has_running_issues"); throw error; }
    });
    return reply.code(201).send({ key: created.key, name: created.name });
  });
  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) => runScopeExclusive(async () => {
    await requireDeveloper(database, request);
    const service = await findServiceByKey(request.params.key); if (!service) throw new ApiError(404, "service_not_found");
    const input = record(request.body);
    checkRevision(input.expectedRevision, service.revision);
    const prepared = await prepareServiceConfiguration({ executor: database.db, serviceId: service.id, input });
    const affected = await affectedIssues(service.id, prepared.parsed.deployments.map(row => row.environmentKey), mysqlChanged(prepared));
    try {
      return await runIssueExclusive(engine, affected.map((row) => row.id), async (reservation) => {
        const serviceUpdate = { name: text(input.name, "name", 200), description: optionalText(input.description) ?? "" };
        for (const row of affected) await reservation.closeSession(row.id);
        await database.db.transaction((transaction) => applyServiceConfiguration({ executor: transaction, serviceId: service.id, prepared, serviceUpdate })); return { ok: true };
      });
    } catch (error) { if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "service_has_running_issues"); throw error; }
  }));
  app.delete<{ Params: { key: string } }>("/api/services/:key", async (request, reply) => {
    await runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key); if (!service) throw new ApiError(404, "service_not_found");
      const primary = await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1);
      const extra = await database.db.select().from(issueServiceScopes).where(eq(issueServiceScopes.serviceId, service.id)).limit(1);
      if (primary.length || extra.length) throw new ApiError(409, "service_is_used_by_issues");
      const affected = await affectedIssues(service.id);
      await runIssueExclusive(engine, affected.map((row) => row.id), async (reservation) => { for (const row of affected) await reservation.closeSession(row.id); await database.db.delete(services).where(eq(services.id, service.id)); });
    });
    return reply.code(204).send();
  });
}
