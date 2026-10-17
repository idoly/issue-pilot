import { parseDmsConnectionConfiguration, parseSlsConnectionConfiguration, CapabilityConfigurationError } from "../capabilities/registry.ts";
import { asc, desc, eq, or } from "drizzle-orm";

import { subjects, issues, userCredentials } from "../db/schema.ts";
import { loadGlobalAgentConfiguration } from "../configuration/agent.ts";
import { credentialStatus } from "../configuration/user-credentials.ts";
import { USER_ROLES } from "../domain/contracts.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { ensureCurrentSubject, runIssueExclusive, serializePerson, type ApiRouteContext } from "./route-context.ts";

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

function serializeManagedUser(user: typeof subjects.$inferSelect) {
  return {
    ...serializePerson(user),
    active: user.active,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function registerUserRoutes(context: ApiRouteContext): void {
  const { app, database, engine, runScopeExclusive } = context;
  const requireDeveloper = async (request: Parameters<typeof ensureCurrentSubject>[1]) => {
    const subject = await ensureCurrentSubject(database, request);
    const [user] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (user?.role !== "developer") throw new ApiError(403, "developer_role_required");
    return subject;
  };
  const changeUser = async <T>(subject: string, change: () => Promise<T>) => runScopeExclusive(async () => {
    const affected = await database.db.select({ id: issues.id }).from(issues).where(or(eq(issues.reporterSubject, subject), eq(issues.assigneeSubject, subject)));
    return runIssueExclusive(engine, affected.map(({ id }) => id), async (reservation) => {
      for (const { id } of affected) await reservation.closeSession(id);
      return change();
    });
  });

  app.get("/api/me/credentials", async (request, reply) => {
    const subject = await ensureCurrentSubject(database, request);
    reply.header("Cache-Control", "private, no-store");
    const [credentials] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, subject)).limit(1);
    const [user] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    const status = credentialStatus(credentials);
    return user?.role === "developer" ? { ...status, provider: (await loadGlobalAgentConfiguration(database.db)).provider } : { ...status, modelProviders: [], gitSshConfigured: false };
  });

  app.put("/api/me/credentials", { logLevel: "silent" }, async (request, reply) => {
    const subject = await ensureCurrentSubject(database, request);
    const input = record(request.body);
    if (input.model || input.git) await requireDeveloper(request);
    if (Object.keys(input).some((key) => !["model", "git", "production"].includes(key)) || (!input.model && !input.git && !input.production)) throw new ApiError(400, "invalid_user_credentials");
    const result = await changeUser(subject, async () => {
      await ensureCurrentSubject(database, request);
      if (input.model || input.git) await requireDeveloper(request);
      const [existing] = await database.db.select().from(userCredentials).where(eq(userCredentials.subject, subject)).limit(1);
      const values = { modelApiKeys: { ...existing?.modelApiKeys }, gitPrivateKey: existing?.gitPrivateKey ?? "", productionDmsUrl: existing?.productionDmsUrl ?? "", productionDmsAuthorization: existing?.productionDmsAuthorization ?? "", productionSlsAccessKeyId: existing?.productionSlsAccessKeyId ?? "", productionSlsAccessKeySecret: existing?.productionSlsAccessKeySecret ?? "" };
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
      const [saved] = await database.db.insert(userCredentials).values({ subject, ...values }).onConflictDoUpdate({ target: userCredentials.subject, set: { ...values, updatedAt: new Date() } }).returning();
      const [user] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
      const status = credentialStatus(saved);
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
    const subject = await ensureCurrentSubject(database, request);
    const [person] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new Error("current_subject_not_found");
    return serializePerson(person);
  });

  app.get("/api/users/manage", async (request, reply) => {
    await ensureCurrentSubject(database, request);
    reply.header("Cache-Control", "private, no-store");
    const users = await database.db.select().from(subjects).orderBy(desc(subjects.active), asc(subjects.displayName), asc(subjects.subject));
    return users.map(serializeManagedUser);
  });

  app.post("/api/users", async (request, reply) => {
    await requireDeveloper(request);
    const input = record(request.body);
    const [created] = await database.db.insert(subjects).values({
      subject: userSubject(input.subject),
      displayName: userName(input.name),
      email: userEmail(input.email),
      role: choice(input.role ?? "product", "user_role", USER_ROLES),
      active: true,
    }).returning();
    return reply.code(201).send(serializeManagedUser(created!));
  });

  app.patch<{ Params: { subject: string } }>("/api/users/:subject", async (request) => {
    await requireDeveloper(request);
    const subject = userSubject(request.params.subject);
    const input = record(request.body);
    const update = { displayName: userName(input.name), email: userEmail(input.email), active: userActive(input.active), updatedAt: new Date() };
    return changeUser(subject, () => database.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
      if (!existing) throw new ApiError(404, "user_not_found");
      if (existing.active && !update.active) {
        const activeUsers = await transaction.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.active, true)).limit(2);
        if (activeUsers.length < 2) throw new ApiError(409, "last_active_user");
      }
      const nextRole = input.role === undefined ? existing.role : choice(input.role, "user_role", USER_ROLES);
      if (existing.active && existing.role === "developer" && (!update.active || nextRole !== "developer")) {
        const developers = await transaction.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.role, "developer"));
        const otherActive = await transaction.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.active, true));
        if (!developers.some(({ subject: id }) => id !== subject && otherActive.some(({ subject: activeId }) => activeId === id))) throw new ApiError(409, "last_active_developer");
      }
      const [updated] = await transaction.update(subjects).set({ ...update, role: nextRole }).where(eq(subjects.subject, subject)).returning();
      return serializeManagedUser(updated!);
    }));
  });
}
