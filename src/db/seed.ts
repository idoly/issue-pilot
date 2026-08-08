import { eq } from "drizzle-orm";

import type { EnvironmentKind } from "../domain/contracts.ts";
import { openDatabase } from "./client.ts";
import { environments, serviceDeployments, services, subjects } from "./schema.ts";

const people = [
  { subject: "yx4821@xianhengguoji.com", username: "yx4821@xianhengguoji.com", displayName: "严欣", email: "yx4821@xianhengguoji.com" },
  { subject: "zjj3753@xianhengguoji.com", username: "zjj3753@xianhengguoji.com", displayName: "周俊杰", email: "zjj3753@xianhengguoji.com" },
];
const { db, close } = openDatabase();

try {
  for (const person of people) {
    await db.insert(subjects).values(person).onConflictDoUpdate({
      target: subjects.subject,
      set: { username: person.username, displayName: person.displayName, email: person.email, updatedAt: new Date() },
    });
  }

  async function ensureEnvironment(key: string, name: string, kind: EnvironmentKind) {
    const existing = await db.select().from(environments).where(eq(environments.key, key)).limit(1);
    if (existing[0]) return existing[0];
    const inserted = await db.insert(environments).values({ key, name, kind }).returning();
    return inserted[0]!;
  }

  const dev = await ensureEnvironment("dev", "开发", "dev");
  const prod = await ensureEnvironment("prod", "正式", "prod");
  const test = await ensureEnvironment("test", "测试", "test");

  let service = (await db.select().from(services).where(eq(services.key, "srm")).limit(1))[0];
  if (!service) {
    [service] = await db.insert(services).values({ key: "srm", name: "SRM", description: "供应商关系管理服务" }).returning();
  }

  await db.insert(serviceDeployments).values([
    { serviceId: service!.id, environmentId: dev.id, baseBranch: "develop", config: {} },
    { serviceId: service!.id, environmentId: prod.id, baseBranch: "main", config: {} },
    { serviceId: service!.id, environmentId: test.id, baseBranch: "develop", config: {} },
  ]).onConflictDoNothing().returning();

  console.log(JSON.stringify({
    environments: [dev.name, prod.name, test.name],
    service: service!.name,
    subjects: people.map((person) => person.subject),
  }, null, 2));
} finally {
  await close();
}
