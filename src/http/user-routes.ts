import { parseDmsConnectionConfiguration, parseSlsConnectionConfiguration, CapabilityConfigurationError } from "../capabilities/registry.ts";
import { and, asc, desc, eq, or } from "drizzle-orm";

import { subjects, issues, userCredentials, applicationSettings } from "../db/schema.ts";
import { loadGlobalAgentConfiguration } from "../configuration/agent.ts";
import { CAPABILITY_CREDENTIAL_FIELDS } from "../configuration/contracts.ts";
import { credentialStatus } from "../configuration/user-credentials.ts";
import { CAPABILITY_KEYS, USER_ROLES } from "../domain/contracts.ts";
import { ApiError, checkRevision, choice, record, text } from "./input.ts";
import { ensureCurrentSubject, requireCurrentUser, requireAdmin, requireDeveloper, runIssueExclusive, serializePerson, type ApiRouteContext } from "./route-context.ts";

function userSubject(value: unknown): string {
  const subject = text(value, "user_subject", 255).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]*$/.test(subject)) throw new ApiError(400, "invalid_user_subject");
  return subject;
}

function userName(value: unknown): string {
  return text(value, "user_name", 100);
}

function userEmail(value: unknown): string {
  const email = text(value, "user_email", 254).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, "invalid_user_email");
  return email;
}

function userActive(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, "invalid_user_active");
  return value;
}

function userAdmin(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ApiError(400, "invalid_user_admin");
  return value;
}

function serializeManagedUser(user: typeof subjects.$inferSelect) {
  return {
    ...serializePerson(user),
    revision: user.revision,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function registerUserRoutes(context: Pick<ApiRouteContext, "app" | "database" | "engine" | "runScopeExclusive">): void {
  const { app, database, engine, runScopeExclusive } = context;

  const changeUser = async <T>(subject: string, authorize: () => Promise<string>, change: (closeSessions: () => Promise<void>) => Promise<T>) => runScopeExclusive(async () => {
    await authorize();
    const affected = await database.db.select({ id: issues.id }).from(issues).where(or(eq(issues.reporterSubject, subject), eq(issues.assigneeSubject, subject)));
    return runIssueExclusive(engine, affected.map(({ id }) => id), (reservation) => change(async () => {
      for (const { id } of affected) await reservation.closeSession(id);
    }));
  });

  for (const kind of CAPABILITY_KEYS) {
    const url = `/api/config/shared-${kind}-credentials`;
    const fields = CAPABILITY_CREDENTIAL_FIELDS[kind] as readonly string[];
    const revisionColumn = kind === "dms" ? applicationSettings.sharedDmsRevision : applicationSettings.sharedSlsRevision;
    app.get(url, { logLevel: "silent" }, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      return runScopeExclusive(async () => {
        await requireDeveloper(database, request);
        const [row] = await database.db.select({ dms: applicationSettings.sharedDmsCredentials, sls: applicationSettings.sharedSlsCredentials, revision: revisionColumn }).from(applicationSettings).where(eq(applicationSettings.id, 1)).limit(1);
        const revision = row?.revision ?? 0;
        return kind === "dms"
          ? { configured: Boolean(row?.dms?.url && row.dms.authorization), url: row?.dms?.url ?? "", revision }
          : { configured: Boolean(row?.sls?.accessKeyId && row.sls.accessKeySecret), revision };
      });
    });
    app.put(url, { logLevel: "silent" }, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      await requireDeveloper(database, request);
      const input = record(request.body);
      if (Object.keys(input).some(key => !["mode", "expectedRevision", ...fields].includes(key)) || input.mode === "clear" && fields.some(field => input[field] !== undefined)) throw new ApiError(400, `invalid_shared_${kind}_credentials`);
      if (input.mode !== "clear" && input.mode !== "replace") throw new ApiError(400, "invalid_credential_update");
      let update: Pick<typeof applicationSettings.$inferInsert, "sharedDmsCredentials" | "sharedSlsCredentials">;
      try {
        update = kind === "dms"
          ? { sharedDmsCredentials: input.mode === "clear" ? null : parseDmsConnectionConfiguration(input) }
          : { sharedSlsCredentials: input.mode === "clear" ? null : parseSlsConnectionConfiguration(input) };
      } catch (error) { if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message); throw error; }
      return runScopeExclusive(async () => {
        await requireDeveloper(database, request);
        const affected = await database.db.select({ id: issues.id }).from(issues);
        return runIssueExclusive(engine, affected.map(row => row.id), async reservation => {
          await requireDeveloper(database, request);
          const [existing] = await database.db.select({ revision: revisionColumn }).from(applicationSettings).where(eq(applicationSettings.id, 1)).limit(1);
          checkRevision(input.expectedRevision, existing?.revision ?? 0);
          for (const row of affected) await reservation.closeSession(row.id);
          const revision = (existing?.revision ?? 0) + 1;
          const values = { ...update, ...(kind === "dms" ? { sharedDmsRevision: revision } : { sharedSlsRevision: revision }) };
          await database.db.transaction(transaction => transaction.insert(applicationSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: applicationSettings.id, set: values }));
          return kind === "dms"
            ? { configured: Boolean(update.sharedDmsCredentials), url: update.sharedDmsCredentials?.url ?? "", revision }
            : { configured: Boolean(update.sharedSlsCredentials), revision };
        });
      });
    });
  }

  app.get("/api/me/credentials", async (request, reply) => {
    const user = await requireCurrentUser(database, request);
    reply.header("Cache-Control", "private, no-store");
    const [credentials] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, user.subject)).limit(1);
    const status = { ...credentialStatus(credentials), revision: credentials?.revision ?? 0 };
    return user.role === "developer" ? { ...status, provider: (await loadGlobalAgentConfiguration(database.db)).provider } : { ...status, modelProviders: [], gitSshConfigured: false };
  });

  app.put("/api/me/credentials", { logLevel: "silent" }, async (request, reply) => {
    const subject = await ensureCurrentSubject(database, request);
    const input = record(request.body);
    if (input.model || input.git) await requireDeveloper(database, request);
    if (Object.keys(input).some((key) => !["model", "git", "production", "expectedRevision"].includes(key)) || (!input.model && !input.git && !input.production)) throw new ApiError(400, "invalid_user_credentials");
    const result = await changeUser(subject, () => input.model || input.git ? requireDeveloper(database, request) : ensureCurrentSubject(database, request), async (closeSessions) => {
      const [existing] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, subject)).limit(1);
      checkRevision(input.expectedRevision, existing?.revision ?? 0);
      const values = { revision: (existing?.revision ?? 0) + 1, modelApiKeys: { ...existing?.modelApiKeys }, gitPrivateKey: existing?.gitPrivateKey ?? "", productionDmsUrl: existing?.productionDmsUrl ?? "", productionDmsAuthorization: existing?.productionDmsAuthorization ?? "", productionSlsAccessKeyId: existing?.productionSlsAccessKeyId ?? "", productionSlsAccessKeySecret: existing?.productionSlsAccessKeySecret ?? "" };
      if (input.model) {
        const model = record(input.model);
        const provider = model.provider === undefined ? (await loadGlobalAgentConfiguration(database.db)).provider : text(model.provider, "model_provider", 200);
        if (!/^[a-zA-Z0-9._-]+$/.test(provider)) throw new ApiError(400, "invalid_model_provider");
        if (model.mode === "replace") values.modelApiKeys[provider] = text(model.apiKey, "model_api_key", 10_000);
        else if (model.mode === "clear") delete values.modelApiKeys[provider];
        else throw new ApiError(400, "invalid_credential_update");
      }
      if (input.git) {
        const git = record(input.git);
        if (git.mode === "clear") values.gitPrivateKey = "";
        else if (git.mode === "replace" && git.type === "ssh") {
          values.gitPrivateKey = text(git.privateKey, "git_private_key", 50_000) + "\n";
          if (!/^(?:-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----|-----BEGIN PRIVATE KEY-----)/.test(values.gitPrivateKey)) throw new ApiError(400, "invalid_git_private_key");
        } else throw new ApiError(400, "invalid_credential_update");
      }
      if (input.production) {
        const production = record(input.production);
        if (Object.keys(production).some(key => !["dms", "sls"].includes(key)) || (!production.dms && !production.sls)) throw new ApiError(400, "invalid_production_credentials");
        try {
          if (production.dms) {
            const dms = record(production.dms);
            if (dms.mode === "clear") { values.productionDmsUrl = ""; values.productionDmsAuthorization = ""; }
            else if (dms.mode === "replace") { const value = parseDmsConnectionConfiguration(dms); values.productionDmsUrl = value.url; values.productionDmsAuthorization = value.authorization; }
            else throw new ApiError(400, "invalid_credential_update");
          }
          if (production.sls) {
            const sls = record(production.sls);
            if (sls.mode === "clear") { values.productionSlsAccessKeyId = ""; values.productionSlsAccessKeySecret = ""; }
            else if (sls.mode === "replace") { const value = parseSlsConnectionConfiguration(sls); values.productionSlsAccessKeyId = value.accessKeyId; values.productionSlsAccessKeySecret = value.accessKeySecret; }
            else throw new ApiError(400, "invalid_credential_update");
          }
        } catch (error) { if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message); throw error; }
      }
      await closeSessions();
      const [saved] = await database.db.insert(userCredentials).values({ subject, ...values }).onConflictDoUpdate({ target: userCredentials.subject, set: { ...values, updatedAt: new Date() } }).returning();
      const [user] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
      const status = { ...credentialStatus(saved), revision: saved?.revision ?? 0 };
      return user?.role === "developer" ? { ...status, provider: (await loadGlobalAgentConfiguration(database.db)).provider } : { ...status, modelProviders: [], gitSshConfigured: false };
    }).catch((error) => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "user_credentials_save_failed");
    });
    reply.header("Cache-Control", "private, no-store");
    return result;
  });

  app.get("/api/users", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const users = await database.db.select().from(subjects).where(eq(subjects.active, true)).orderBy(asc(subjects.displayName), asc(subjects.subject));
    return users.map(serializePerson);
  });

  app.get("/api/me", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const person = await requireCurrentUser(database, request);
    return serializePerson(person);
  });

  app.get("/api/users/manage", async (request, reply) => {
    await ensureCurrentSubject(database, request);
    reply.header("Cache-Control", "private, no-store");
    const users = await database.db.select().from(subjects).orderBy(desc(subjects.active), asc(subjects.displayName), asc(subjects.subject));
    return users.map(serializeManagedUser);
  });

  app.post("/api/users", async (request, reply) => {
    await requireDeveloper(database, request);
    const input = record(request.body);
    const created = await runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const role = choice(input.role ?? "product", "user_role", USER_ROLES);
      const isAdmin = input.isAdmin === undefined ? false : userAdmin(input.isAdmin);
      if (isAdmin) await requireAdmin(database, request);
      const [saved] = await database.db.insert(subjects).values({ subject: userSubject(input.subject), displayName: userName(input.name), email: userEmail(input.email), role, isAdmin, active: true }).returning();
      return saved!;
    });
    return reply.code(201).send(serializeManagedUser(created));
  });

  app.patch<{ Params: { subject: string } }>("/api/users/:subject", async (request) => {
    await requireDeveloper(database, request);
    const subject = userSubject(request.params.subject);
    const input = record(request.body);
    const update = {
      ...(input.name === undefined ? {} : { displayName: userName(input.name) }),
      ...(input.email === undefined ? {} : { email: userEmail(input.email) }),
      ...(input.active === undefined ? {} : { active: userActive(input.active) }),
      ...(input.role === undefined ? {} : { role: choice(input.role, "user_role", USER_ROLES) }),
      ...(input.isAdmin === undefined ? {} : { isAdmin: userAdmin(input.isAdmin) }),
    };
    if (!Object.keys(update).length) throw new ApiError(400, "invalid_user_update");
    return changeUser(subject, async () => {
      const actor = await requireDeveloper(database, request);
      const [existing] = await database.db.select({ isAdmin: subjects.isAdmin }).from(subjects).where(eq(subjects.subject, subject)).limit(1);
      if (existing?.isAdmin || update.isAdmin === true) await requireAdmin(database, request);
      return actor;
    }, async (closeSessions) => {
      await closeSessions();
      return database.db.transaction(async (transaction) => {
        const [existing] = await transaction.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
        if (!existing) throw new ApiError(404, "user_not_found");
        checkRevision(input.expectedRevision, existing.revision);
        const active = update.active ?? existing.active;
        const nextRole = update.role ?? existing.role;
        const isAdmin = update.isAdmin ?? existing.isAdmin;
        if (existing.active && !active) {
          const activeUsers = await transaction.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.active, true)).limit(2);
          if (activeUsers.length < 2) throw new ApiError(409, "last_active_user");
        }
        if (existing.active && existing.isAdmin && (!active || !isAdmin)) {
          const administrators = await transaction.select({ subject: subjects.subject }).from(subjects).where(and(eq(subjects.isAdmin, true), eq(subjects.active, true))).limit(2);
          if (!administrators.some(({ subject: id }) => id !== subject)) throw new ApiError(409, "last_active_admin");
        }
        if (existing.active && existing.role === "developer" && (!active || nextRole !== "developer")) {
          const developers = await transaction.select({ subject: subjects.subject }).from(subjects).where(and(eq(subjects.role, "developer"), eq(subjects.active, true))).limit(2);
          if (!developers.some(({ subject: id }) => id !== subject)) throw new ApiError(409, "last_active_developer");
        }
        // Changing management access requires both developer and isAdmin.
        if (existing.active && existing.isAdmin && existing.role === "developer" && (!active || !isAdmin || nextRole !== "developer")) {
          const managers = await transaction.select({ subject: subjects.subject }).from(subjects).where(and(eq(subjects.isAdmin, true), eq(subjects.role, "developer"), eq(subjects.active, true))).limit(2);
          if (!managers.some(({ subject: id }) => id !== subject)) throw new ApiError(409, "last_active_admin");
        }
        const [updated] = await transaction.update(subjects).set({ ...update, revision: existing.revision + 1, updatedAt: new Date() }).where(eq(subjects.subject, subject)).returning();
        return serializeManagedUser(updated!);
      });
    });
  });
}
