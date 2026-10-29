import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import type { DeploymentConfig, StoredDeploymentConfig, SlsCredentials } from "../domain/contracts.ts";
import { issues, subjects, userCredentials } from "../db/schema.ts";

export async function loadIssueCredentialOwner(database: Database, issueId: string) {
  const [issue] = await database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) throw new Error("issue_not_found");
  const subject = issue.assigneeSubject ?? issue.reporterSubject;
  const [user] = await database.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
  if (!user?.active) throw new Error("issue_credential_owner_inactive");
  const [credentials] = await database.select().from(userCredentials).where(eq(userCredentials.subject, subject)).limit(1);
  return { user, credentials };
}

export function applyIssueCredentials(configuration: Pick<StoredDeploymentConfig, "dms" | "sls">, environment: string, credentials?: typeof userCredentials.$inferSelect, sharedSls?: SlsCredentials | null): DeploymentConfig {
  const result: DeploymentConfig = {};
  if (configuration.dms) result.dms = environment === "prod" && credentials?.productionDmsAuthorization
    ? { ...configuration.dms, url: credentials.productionDmsUrl, authorization: credentials.productionDmsAuthorization }
    : configuration.dms;
  if (configuration.sls) {
    const personalId = credentials?.productionSlsAccessKeyId, personalSecret = credentials?.productionSlsAccessKeySecret;
    if (Boolean(personalId) !== Boolean(personalSecret)) throw new Error("personal_sls_credentials_incomplete");
    const selected = personalId && personalSecret ? { accessKeyId: personalId, accessKeySecret: personalSecret } : sharedSls;
    if (!selected?.accessKeyId || !selected.accessKeySecret) throw new Error("sls_credentials_not_configured");
    result.sls = { ...configuration.sls, ...selected };
  }
  return result;
}
export function credentialStatus(credentials?: typeof userCredentials.$inferSelect) {
  return {
    modelProviders: Object.keys(credentials?.modelApiKeys ?? {}).sort(),
    gitSshConfigured: Boolean(credentials?.gitPrivateKey),
    ...(credentials?.productionDmsAuthorization ? { productionDmsConfigured: true, productionDmsUrl: credentials.productionDmsUrl } : {}),
    ...(credentials?.productionSlsAccessKeyId && credentials.productionSlsAccessKeySecret ? { productionSlsConfigured: true } : {}),
  };
}
