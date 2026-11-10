import type { IssueStatus } from "../domain/contracts.ts";

export interface IssueSearchSettings {
  revision: number;
  enabled: boolean;
  accountId: string;
  apiToken: string;
}

export type IssueSearchConfiguration = Omit<IssueSearchSettings, "apiToken"> & { tokenConfigured: boolean };
export type IssueSearchConfigurationUpdate = Pick<IssueSearchSettings, "enabled" | "accountId"> & { expectedRevision: number; apiToken?: string | null };
export interface IssueSearchHit {
  key: string;
  title: string;
  status: IssueStatus;
}
