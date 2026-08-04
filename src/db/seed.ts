import { and, eq, isNull } from "drizzle-orm";

import { openDatabase } from "./client.ts";
import { deploymentCapabilities, environments, serviceDeployments, services, subjects } from "./schema.ts";

const organizationId = "demo";

const userSubject = process.env.SEED_USER_SUBJECT;
const { db, close } = openDatabase();

try {
  if (userSubject) {
    await db.insert(subjects).values({
      subject: userSubject,
      username: "694590014@qq.com",
      displayName: "严欣",
      email: "694590014@qq.com",
    }).onConflictDoUpdate({
      target: subjects.subject,
      set: { username: "694590014@qq.com", displayName: "严欣", email: "694590014@qq.com", updatedAt: new Date() },
    });
  }

  async function ensureEnvironment(key: string, name: string, kind: "production" | "test") {
    const existing = await db.select().from(environments).where(and(
      eq(environments.organizationId, organizationId),
      eq(environments.scope, "global"),
      isNull(environments.ownerSubject),
      eq(environments.key, key),
    )).limit(1);
    if (existing[0]) return existing[0];
    const inserted = await db.insert(environments).values({
      organizationId,
      scope: "global",
      key,
      name,
      kind,
      config: {},
    }).returning();
    return inserted[0]!;
  }

  const production = await ensureEnvironment("production", "正式", "production");
  const test = await ensureEnvironment("test", "测试", "test");

  let service = (await db.select().from(services).where(and(
    eq(services.organizationId, organizationId),
    eq(services.scope, "global"),
    isNull(services.ownerSubject),
    eq(services.key, "srm"),
  )).limit(1))[0];
  if (!service) {
    [service] = await db.insert(services).values({
      organizationId,
      scope: "global",
      key: "srm",
      name: "SRM",
      description: "供应商关系管理服务",
    }).returning();
  }

  const deployments = await db.insert(serviceDeployments).values([
    { serviceId: service!.id, environmentId: production.id, baseBranch: "main", config: {} },
    { serviceId: service!.id, environmentId: test.id, baseBranch: "develop", config: {} },
  ]).onConflictDoNothing().returning();
  const testDeployment = deployments.find((deployment) => deployment.environmentId === test.id)
    ?? (await db.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, service!.id), eq(serviceDeployments.environmentId, test.id))).limit(1))[0];
  if (testDeployment) await db.insert(deploymentCapabilities).values([
    { deploymentId: testDeployment.id, capability: "configuration_read" },
    { deploymentId: testDeployment.id, capability: "database_read" },
  ]).onConflictDoNothing();

  console.log(JSON.stringify({
    organizationId,
    environments: [production.name, test.name],
    service: service!.name,
    subject: userSubject ?? null,
  }, null, 2));
} finally {
  await close();
}
