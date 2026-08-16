import { asc, desc, eq } from "drizzle-orm";

import { subjects } from "../db/schema.ts";
import { ApiError, record, text } from "./input.ts";
import { ensureCurrentSubject, serializePerson, type ApiRouteContext } from "./route-context.ts";

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
  const { app, database } = context;

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
    await ensureCurrentSubject(database, request);
    const input = record(request.body);
    const [created] = await database.db.insert(subjects).values({
      subject: userSubject(input.subject),
      displayName: userName(input.name),
      email: userEmail(input.email),
      active: true,
    }).returning();
    return reply.code(201).send(serializeManagedUser(created!));
  });

  app.patch<{ Params: { subject: string } }>("/api/users/:subject", async (request) => {
    await ensureCurrentSubject(database, request);
    const subject = userSubject(request.params.subject);
    const input = record(request.body);
    const update = { displayName: userName(input.name), email: userEmail(input.email), active: userActive(input.active), updatedAt: new Date() };
    return database.db.transaction(async (transaction) => {
      const [existing] = await transaction.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
      if (!existing) throw new ApiError(404, "user_not_found");
      if (existing.active && !update.active) {
        const activeUsers = await transaction.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.active, true)).limit(2);
        if (activeUsers.length < 2) throw new ApiError(409, "last_active_user");
      }
      const [updated] = await transaction.update(subjects).set(update).where(eq(subjects.subject, subject)).returning();
      return serializeManagedUser(updated!);
    });
  });
}
