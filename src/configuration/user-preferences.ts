import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { applicationSettings, userPreferences } from "../db/schema.ts";
import type { DingtalkUserSettings } from "./contracts.ts";

export async function loadDingtalkUserSettings(database: Pick<Database, "select">, subject: string): Promise<DingtalkUserSettings> {
  const [[shared], [personal]] = await Promise.all([
    database.select().from(applicationSettings).limit(1),
    database.select().from(userPreferences).where(eq(userPreferences.subject, subject)).limit(1),
  ]);
  return { ...personal?.dingtalk, fields: { ...shared?.dingtalkFields, ...personal?.dingtalk.fields } };
}
