import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2/promise";

const execFileAsync = promisify(execFile);
const SAFE_SEARCH_VALUE = /^[\p{L}\p{N} ._:@/+=-]{1,200}$/u;
const SENSITIVE_KEY = /(access.?key|secret|password|token|authorization|cookie)/i;

interface QueryTemplate {
  statement: string;
  parameters?: Record<string, "string" | "number">;
}

interface SlsSource {
  environment: "production" | "test";
  profile: string;
  region: string;
  endpoint?: string;
  project: string;
  logstore: string;
  maxWindowSeconds?: number;
  queries: Record<string, string>;
}

interface DmsSource {
  profile: string;
  region: string;
  dbId: number;
  logic: boolean;
  tenantId?: number;
  queries: Record<string, QueryTemplate>;
}

interface MysqlSource {
  connectionEnv: string;
  queries: Record<string, QueryTemplate>;
}

export interface AliyunConnectorConfig {
  aliyunCli?: string;
  sls?: Record<string, SlsSource>;
  dms?: Record<string, DmsSource>;
  mysql?: Record<string, MysqlSource>;
}

export interface CloudEvidenceResult {
  source: "sls" | "dms" | "mysql";
  environment: "production" | "test";
  sourceKey: string;
  queryName: string;
  summary: string;
  data: unknown;
  truncated: boolean;
}

function renderSearchTemplate(template: string, parameters: Record<string, string | number>): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw new Error(`missing query parameter: ${name}`);
    const text = String(value);
    if (!SAFE_SEARCH_VALUE.test(text)) throw new Error(`unsafe search parameter: ${name}`);
    return text;
  });
}

function renderSqlTemplate(template: QueryTemplate, parameters: Record<string, string | number>): string {
  const expected = template.parameters ?? {};
  const unknown = Object.keys(parameters).filter((name) => !(name in expected));
  if (unknown.length) throw new Error(`unknown SQL template parameters: ${unknown.join(", ")}`);
  const statement = template.statement.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name: string) => {
    const type = expected[name];
    const value = parameters[name];
    if (!type || value === undefined) throw new Error(`missing SQL template parameter: ${name}`);
    if (type === "number") {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(number)) throw new Error(`invalid numeric SQL template parameter: ${name}`);
      return String(number);
    }
    return `'${String(value).replaceAll("'", "''")}'`;
  }).trim();

  const withoutTrailingSemicolon = statement.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) throw new Error("DMS query templates must contain one statement");
  if (!/^(select|show|describe|desc|explain)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("DMS query template must be read-only");
  }
  return withoutTrailingSemicolon;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry),
    ]));
  }
  return value;
}

function truncate(value: unknown): { data: unknown; truncated: boolean } {
  const sanitized = sanitize(value);
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= 50 * 1024) return { data: sanitized, truncated: false };
  return { data: `${json.slice(0, 48 * 1024)}\n[TRUNCATED]`, truncated: true };
}

export class AliyunEvidenceConnector {
  private readonly config: AliyunConnectorConfig;

  constructor(config: AliyunConnectorConfig) {
    this.config = config;
  }

  static async fromFile(filePath: string): Promise<AliyunEvidenceConnector> {
    const raw = await readFile(resolve(filePath), "utf8");
    return new AliyunEvidenceConnector(JSON.parse(raw) as AliyunConnectorConfig);
  }

  async querySls(input: {
    sourceKey: string;
    queryName: string;
    parameters?: Record<string, string | number>;
    from: number;
    to: number;
  }): Promise<CloudEvidenceResult> {
    const source = this.config.sls?.[input.sourceKey];
    if (!source) throw new Error(`unknown SLS source: ${input.sourceKey}`);
    const template = source.queries[input.queryName];
    if (!template) throw new Error(`unknown SLS query template: ${input.queryName}`);
    const maxWindow = source.maxWindowSeconds ?? 3600;
    if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.to <= input.from) {
      throw new Error("invalid SLS time range");
    }
    if (input.to - input.from > maxWindow) throw new Error(`SLS time range exceeds ${maxWindow} seconds`);
    const query = renderSearchTemplate(template, input.parameters ?? {});
    const args = [
      "--profile", source.profile,
      "sls", "get-logs",
      "--region", source.region,
      "--project", source.project,
      "--logstore", source.logstore,
      "--from", String(input.from),
      "--to", String(input.to),
      "--query", query,
      "--line", "100",
      "--reverse", "true",
    ];
    if (source.endpoint) args.push("--endpoint", source.endpoint);
    const output = await this.run(args);
    const { data, truncated } = truncate(output);
    return {
      source: "sls",
      environment: source.environment,
      sourceKey: input.sourceKey,
      queryName: input.queryName,
      summary: `SLS ${input.sourceKey}/${input.queryName}, ${input.from}-${input.to}`,
      data,
      truncated,
    };
  }

  async queryDms(input: {
    sourceKey: string;
    queryName: string;
    parameters?: Record<string, string | number>;
  }): Promise<CloudEvidenceResult> {
    const source = this.config.dms?.[input.sourceKey];
    if (!source) throw new Error(`unknown DMS source: ${input.sourceKey}`);
    const template = source.queries[input.queryName];
    if (!template) throw new Error(`unknown DMS query template: ${input.queryName}`);
    const statement = renderSqlTemplate(template, input.parameters ?? {});
    const args = [
      "--profile", source.profile,
      "dms-enterprise", "ExecuteScript",
      "--region", source.region,
      "--DbId", String(source.dbId),
      "--Logic", String(source.logic),
      "--Script", statement,
    ];
    if (source.tenantId !== undefined) args.push("--Tid", String(source.tenantId));
    const output = await this.run(args);
    const { data, truncated } = truncate(output);
    return {
      source: "dms",
      environment: "production",
      sourceKey: input.sourceKey,
      queryName: input.queryName,
      summary: `DMS ${input.sourceKey}/${input.queryName}`,
      data,
      truncated,
    };
  }

  async queryMysql(input: {
    sourceKey: string;
    queryName: string;
    parameters?: Record<string, string | number>;
  }): Promise<CloudEvidenceResult> {
    const source = this.config.mysql?.[input.sourceKey];
    if (!source) throw new Error(`unknown MySQL source: ${input.sourceKey}`);
    const template = source.queries[input.queryName];
    if (!template) throw new Error(`unknown MySQL query template: ${input.queryName}`);
    const connectionUrl = process.env[source.connectionEnv];
    if (!connectionUrl) throw new Error(`MySQL connection environment variable is not set: ${source.connectionEnv}`);
    const statement = renderSqlTemplate(template, input.parameters ?? {});
    const bounded = /^select\b/i.test(statement) ? `SELECT * FROM (${statement}) AS issue_agent_query LIMIT 100` : statement;
    const pool = createPool({ uri: connectionUrl, connectionLimit: 2, enableKeepAlive: false });
    try {
      const database = drizzle(pool);
      const output = await database.execute(sql.raw(bounded));
      const { data, truncated } = truncate(output);
      return {
        source: "mysql",
        environment: "test",
        sourceKey: input.sourceKey,
        queryName: input.queryName,
        summary: `MySQL test ${input.sourceKey}/${input.queryName}`,
        data,
        truncated,
      };
    } finally {
      await pool.end();
    }
  }

  private async run(args: string[]): Promise<unknown> {
    const { stdout } = await execFileAsync(this.config.aliyunCli ?? ".tools/bin/aliyun", args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout) as unknown;
  }
}
