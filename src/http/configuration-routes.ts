import { DomainError } from "../domain/errors.ts";
import { resolveDmsScope } from "../capabilities/dms.ts";
import { OperationError } from "../operation-error.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { loadGlobalAgentConfiguration, loadGlobalAgentRevision, loadSharedAgentApiKey, parseAgentModelSelection, saveGlobalAgentConfiguration } from "../configuration/agent.ts";
import {
  installApplicationParameters,
  loadApplicationParameterState,
  parseApplicationParameterOverrides,
  resolveApplicationParameters,
  saveApplicationParameters,
} from "../configuration/parameters.ts";
import { inspectAgentResources, parseAgentRuntime } from "../configuration/pi-runtime.ts";
import { applyIssueSandboxNetwork } from "../agent/issue-sandbox.ts";
import { workspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
import { loadConfiguration, loadConfigurationCatalog, loadServiceConfigurationDescription } from "../configuration/read.ts";
import { issuesAffectedByGlobalChange, issuesAffectedByServiceDeletion, issuesObservingDeployments } from "../configuration/impact.ts";
import { loadSharedCapabilityCredentials, selectDmsCredentials } from "../configuration/user-credentials.ts";
import { userCredentials, environments, issues, issueServiceScopes, serviceDeployments, services } from "../db/schema.ts";
import { errorDiagnostic, isClassifiedOwnerFailure } from "../diagnostics.ts";
import { checkRevision, closedRecord, optionalText, record, text } from "../domain/input.ts";
import { loadIssueSearchSettings, projectIssueSearchSettings, updateIssueSearchSettings } from "../search/settings.ts";
import { requireAdmin, requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
import { applyServiceConfiguration, prepareServiceConfiguration } from "../configuration/service-deployments.ts";

function uniqueServiceKey(name: string, existingKeys: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");
  const base = slug || `service-${randomUUID().slice(0, 8)}`;
  if (!existingKeys.has(base)) return base;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function registerConfigurationRoutes(context: ApiRouteContext, cancelActiveSearches: () => void, applySandboxNetwork = applyIssueSandboxNetwork): void {
  const { app, database, engine, modelCatalog, runScopeExclusive, workspaces } = context;
  const findServiceByKey = async (key: string) => (await database.db.select().from(services).where(eq(services.key, key)).limit(1))[0];

  app.get<{ Params: { key: string } }>("/api/services/:key/dbhub-targets", { logLevel: "silent" }, async (request, _reply) => {
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new DomainError("service_not_found", "not_found");
      const deployments = await database.db
        .select({ environmentKey: environments.key, config: serviceDeployments.config })
        .from(serviceDeployments)
        .innerJoin(environments, eq(environments.id, serviceDeployments.environmentId))
        .where(eq(serviceDeployments.serviceId, service.id));
      return { revision: service.revision, deployments: deployments.map((row) => ({ environmentKey: row.environmentKey, dbhub: row.config.dbhub ?? [] })) };
    });
  });
  app.get<{ Params: { key: string } }>("/api/services/:key/configuration-description", { logLevel: "silent" }, async (request, _reply) => {
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      try {
        const value = await loadServiceConfigurationDescription(database.db, request.params.key);
        if (!value) throw new DomainError("service_not_found", "not_found");
        return value;
      } catch (error) {
        if (isClassifiedOwnerFailure(error)) throw error;
        app.log.error(errorDiagnostic(error));
        throw new DomainError("service_configuration_description_failed", "internal");
      }
    });
  });
  app.post("/api/dms/scope/resolve", { logLevel: "silent" }, async (request, _reply) => {
    await requireDeveloper(database, request);
    const input = record(request.body);
    try {
      const connection = await runScopeExclusive(async () => {
        const actor = await requireDeveloper(database, request);
        if (Object.keys(input).some((key) => !["instanceAlias", "schemaName"].includes(key))) throw new DomainError("invalid_dms_scope_request", "bad_request");
        const [personal] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, actor)).limit(1);
        const shared = await loadSharedCapabilityCredentials(database.db);
        return selectDmsCredentials(personal, shared.dms);
      });
      return await resolveDmsScope(connection, text(input.instanceAlias, "dms_instance_alias", 255), text(input.schemaName, "dms_schema_name", 255));
    } catch (error) {
      // Classified failures (including upstream dms_* codes) are logged once by the global handler; the route is
      // silent, so record only the unclassified TLS/DNS/SDK failure it replaces with an opaque code.
      if (isClassifiedOwnerFailure(error)) throw error;
      app.log.error({ code: "dms_scope_resolve_failed" }, "dms_scope_resolve_failed");
      throw new DomainError("dms_scope_resolve_failed", "upstream");
    }
  });
  app.get("/api/catalog", async (_request, _reply) => {
    return runScopeExclusive(() => loadConfigurationCatalog(database.db));
  });
  app.get("/api/config", async (_request, _reply) => {
    const models = await modelCatalog.list();
    return runScopeExclusive(() => loadConfiguration(database.db, models));
  });
  app.put("/api/config/agent", { logLevel: "silent" }, async (request) => {
    await requireAdmin(database, request);
    const input = record(request.body);
    let apiKey: string | undefined;
    if (input.apiKey !== undefined) {
      const update = record(input.apiKey);
      if (update.mode === "replace" && Object.keys(update).length === 2) apiKey = text(update.value, "agent_api_key", 10_000);
      else if (update.mode === "clear" && Object.keys(update).length === 1) apiKey = "";
      else throw new DomainError("invalid_credential_update", "bad_request");
    }
    const configuration = { ...parseAgentModelSelection(input, await modelCatalog.list()), runtime: parseAgentRuntime(input.runtime) };
    return runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const affected = await issuesAffectedByGlobalChange(database.db);
      return runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          // Concurrent admins edit one singleton; a stale draft is refused before any session is disposed.
          const expectedRevision = await loadGlobalAgentRevision(database.db);
          checkRevision(input.expectedRevision, expectedRevision);
          // A preserved key stays bound to its provider; switching providers requires a new key or an explicit clear.
          if (apiKey === undefined && (await loadGlobalAgentConfiguration(database.db)).provider !== configuration.provider && (await loadSharedAgentApiKey(database.db)))
            throw new DomainError("agent_api_key_required", "bad_request");
          for (const row of affected) await reservation.closeSession(row.id);
          const revision = await database.db.transaction((transaction) => saveGlobalAgentConfiguration(transaction, configuration, expectedRevision, apiKey));
          return { ok: true, revision };
        },
        "global_configuration_has_running_issues",
      );
    });
  });
  app.get<{ Querystring: { include?: string } }>("/api/config/parameters", (request) =>
    runScopeExclusive(async () => {
      if (request.query.include !== "issueSearch") return loadApplicationParameterState(database.db);
      await requireAdmin(database, request);
      const parameters = await loadApplicationParameterState(database.db);
      return { ...parameters, issueSearch: projectIssueSearchSettings(await loadIssueSearchSettings(database.db)) };
    }),
  );
  // Parameters are budgets read when an operation starts, so saving neither reserves Issues nor closes sessions.
  app.put("/api/config/parameters", { logLevel: "silent" }, (request) =>
    runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const input = closedRecord(request.body, ["expectedRevision", "overrides", "issueSearch"], "invalid_application_parameters");
      if (input.expectedRevision === undefined) throw new DomainError("invalid_application_parameters", "bad_request");
      const overrides = parseApplicationParameterOverrides(input.overrides);
      const { parameters, previousValues, search } = await database.db.transaction(async (transaction) => {
        const current = await loadApplicationParameterState(transaction);
        checkRevision(input.expectedRevision, current.revision);
        const search = input.issueSearch === undefined ? { settings: await loadIssueSearchSettings(transaction), changed: false } : await updateIssueSearchSettings(transaction, input.issueSearch);
        if (isDeepStrictEqual(overrides, current.overrides)) return { parameters: current, previousValues: undefined, search };
        const revision = current.revision + 1;
        await saveApplicationParameters(transaction, overrides, revision);
        return { parameters: { ...current, revision, overrides, values: resolveApplicationParameters(overrides) }, previousValues: current.values, search };
      });
      if (search.changed) cancelActiveSearches();
      if (previousValues) {
        const { values } = parameters;
        installApplicationParameters(values);
        if (values.maxConcurrentIssues !== previousValues.maxConcurrentIssues) engine.setMaxConcurrentIssues(values.maxConcurrentIssues);
        const policy = workspaceLifecyclePolicy(values);
        if (!isDeepStrictEqual(policy, workspaceLifecyclePolicy(previousValues))) workspaces.updatePolicy({ ...policy, taskConcurrency: workspaces.policy.taskConcurrency });
        // A failed sync is retried when the sandbox is next acquired; the saved values stay authoritative,
        // so the client must learn the save committed instead of seeing an ordinary failure to repeat.
        if (!isDeepStrictEqual(values.networkAllowedDomains, previousValues.networkAllowedDomains))
          await applySandboxNetwork().catch((error: unknown) => {
            throw new OperationError("issue_sandbox_network_sync_failed", "committed", { cause: error });
          });
      }
      return { ...parameters, issueSearch: projectIssueSearchSettings(search.settings) };
    }),
  );
  app.get("/api/config/agent/resources", { logLevel: "silent" }, async (request, _reply) => {
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      try {
        return await inspectAgentResources();
      } catch (error) {
        if (isClassifiedOwnerFailure(error)) throw error;
        app.log.error(errorDiagnostic(error));
        throw new DomainError("agent_resources_inspection_failed", "internal");
      }
    });
  });
  app.post("/api/services", async (request, reply) => {
    await requireDeveloper(database, request);
    const input = record(request.body);
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description) ?? "";
    const created = await runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const serviceId = randomUUID();
      const [existing, prepared] = await Promise.all([database.db.select({ key: services.key }).from(services), prepareServiceConfiguration({ executor: database.db, serviceId, input })]);
      const key = uniqueServiceKey(name, new Set(existing.map((row) => row.key)));
      const affected = await issuesObservingDeployments(database.db, prepared.affectedEnvironmentIds);
      return runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          return database.db.transaction(async (transaction) => {
            const [row] = await transaction.insert(services).values({ id: serviceId, key, name, description }).returning();
            await applyServiceConfiguration({ executor: transaction, serviceId, prepared });
            return row!;
          });
        },
        "service_has_running_issues",
      );
    });
    return reply.code(201).send({ key: created.key, name: created.name });
  });
  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) =>
    runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new DomainError("service_not_found", "not_found");
      const input = record(request.body);
      checkRevision(input.expectedRevision, service.revision);
      const prepared = await prepareServiceConfiguration({ executor: database.db, serviceId: service.id, input, currentService: service });
      const affected = await issuesObservingDeployments(database.db, prepared.affectedEnvironmentIds);
      return runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          await database.db.transaction((transaction) => applyServiceConfiguration({ executor: transaction, serviceId: service.id, prepared }));
          return { ok: true };
        },
        "service_has_running_issues",
      );
    }),
  );
  app.delete<{ Params: { key: string } }>("/api/services/:key", async (request, reply) => {
    await runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new DomainError("service_not_found", "not_found");
      const primary = await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1);
      const extra = await database.db.select().from(issueServiceScopes).where(eq(issueServiceScopes.serviceId, service.id)).limit(1);
      if (primary.length || extra.length) throw new DomainError("service_is_used_by_issues", "conflict");
      const affected = await issuesAffectedByServiceDeletion(database.db, service.id);
      await runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          await database.db.delete(services).where(eq(services.id, service.id));
        },
        "service_has_running_issues",
      );
    });
    return reply.code(204).send();
  });
}
