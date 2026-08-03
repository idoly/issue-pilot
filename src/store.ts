import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { nextDatedIssueKey } from "./issue-keys.ts";

export const ISSUE_STATUSES = ["open", "in_progress", "pending", "resolved", "closed"] as const;
export const ISSUE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const ISSUE_TYPES = ["incident", "request", "problem", "question", "task"] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export type IssueType = (typeof ISSUE_TYPES)[number];

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueHistoryEntry {
  at: string;
  actor: string;
  action: "created" | "updated" | "commented" | "context_updated";
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export interface RepositoryBinding {
  id: string;
  url: string;
  baseBranch: string;
  workingBranch: string | null;
  localPath: string | null;
}

export interface IssueAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  size: number;
  storagePath: string;
  uploadedBy: string;
  createdAt: string;
}

export type EvidenceSource = "sls" | "dms" | "mysql" | "code" | "attachment" | "user" | "test";

export interface IssueEvidence {
  id: string;
  source: EvidenceSource;
  summary: string;
  locator: string | null;
  createdAt: string;
  createdBy: string;
}

export type DiagnosisClassification = "pending" | "bug" | "not_bug" | "change_request" | "cannot_determine";

export interface IssueDiagnosis {
  classification: DiagnosisClassification;
  rootCause: string | null;
  confidence: number | null;
  evidenceIds: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface IssueTestRun {
  id: string;
  scope: "backend" | "frontend" | "integration";
  command: string;
  status: "passed" | "failed" | "blocked";
  summary: string;
  createdAt: string;
  createdBy: string;
}

export interface AgentSessionBinding {
  sessionId: string;
  sessionFile: string;
  workspacePath: string;
  updatedAt: string;
}

export interface CodeWorkspace {
  status: "not_created" | "preparing" | "ready" | "stopped" | "failed";
  url: string | null;
  ownerSubject: string | null;
  branchCreated: boolean;
  updatedAt: string | null;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  type: IssueType;
  assignee: string | null;
  reporter: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  comments: IssueComment[];
  history: IssueHistoryEntry[];
  repositories: RepositoryBinding[];
  attachments: IssueAttachment[];
  evidence: IssueEvidence[];
  diagnosis: IssueDiagnosis;
  testRuns: IssueTestRun[];
  agentSession: AgentSessionBinding | null;
  workspace: CodeWorkspace;
}

interface IssueDatabase {
  version: 2;
  nextId: number;
  issues: Issue[];
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  priority?: IssuePriority;
  type?: IssueType;
  assignee?: string | null;
  reporter?: string;
  labels?: string[];
  repositories?: Array<{ url: string; baseBranch: string }>;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  type?: IssueType;
  assignee?: string | null;
  labels?: string[];
  actor?: string;
  expectedUpdatedAt?: string;
}

export interface SearchIssueInput {
  query?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  type?: IssueType;
  assignee?: string;
  label?: string;
  repositoryUrl?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
}

export interface IssueStatistics {
  total: number;
  active: number;
  completed: number;
  unassigned: number;
  byStatus: Record<IssueStatus, number>;
  byPriority: Record<IssuePriority, number>;
  byType: Record<IssueType, number>;
  byAssignee: Record<string, number>;
  byProject: Record<string, number>;
  cycleTimeHours: { average: number | null; median: number | null; p95: number | null };
  activeAgeHours: { average: number | null; oldest: number | null };
}

const EMPTY_DATABASE: IssueDatabase = { version: 2, nextId: 1, issues: [] };
const PRIORITY_ORDER: Record<IssuePriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function cleanText(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} must not be empty`);
  return result;
}

function cleanLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return [...new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean))].sort();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timestampAfter(previous: string): string {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(Date.now(), previousTime + 1)).toISOString();
}

function normalizeIssue(issue: Issue): Issue {
  issue.repositories ??= [];
  issue.attachments ??= [];
  issue.evidence ??= [];
  issue.diagnosis ??= {
    classification: "pending",
    rootCause: null,
    confidence: null,
    evidenceIds: [],
    updatedAt: null,
    updatedBy: null,
  };
  issue.testRuns ??= [];
  issue.agentSession ??= null;
  issue.workspace ??= {
    status: "not_created",
    url: null,
    ownerSubject: null,
    branchCreated: false,
    updatedAt: null,
  };
  return issue;
}

function assertDatabase(value: unknown): asserts value is IssueDatabase {
  if (!value || typeof value !== "object") throw new Error("issue database must be an object");
  const candidate = value as { version?: number; nextId?: number; issues?: Issue[] };
  if (![1, 2].includes(candidate.version ?? 0) || !Number.isInteger(candidate.nextId) || !Array.isArray(candidate.issues)) {
    throw new Error("unsupported or corrupt issue database");
  }
  candidate.version = 2;
  candidate.issues = candidate.issues.map(normalizeIssue);
}

export class IssueStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly issueKeyTimeZone: string;

  constructor(filePath: string, options: { now?: () => Date; timeZone?: string } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.issueKeyTimeZone = options.timeZone ?? process.env.ISSUE_AGENT_TIME_ZONE ?? "Asia/Shanghai";
  }

  async create(input: CreateIssueInput): Promise<Issue> {
    return this.mutate((database) => {
      const createdAt = this.now();
      const now = createdAt.toISOString();
      const id = nextDatedIssueKey(database.issues.map((issue) => issue.id), createdAt, this.issueKeyTimeZone);
      const issue: Issue = {
        id,
        title: cleanText(input.title, "title"),
        description: input.description?.trim() ?? "",
        status: "open",
        priority: input.priority ?? "p2",
        type: input.type ?? "request",
        assignee: input.assignee?.trim() || null,
        reporter: input.reporter?.trim() || "user",
        labels: cleanLabels(input.labels),
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        comments: [],
        history: [{ at: now, actor: input.reporter?.trim() || "user", action: "created" }],
        repositories: (input.repositories ?? []).map((repository) => ({
          id: randomUUID(),
          url: cleanText(repository.url, "repository url"),
          baseBranch: cleanText(repository.baseBranch, "base branch"),
          workingBranch: null,
          localPath: null,
        })),
        attachments: [],
        evidence: [],
        diagnosis: {
          classification: "pending",
          rootCause: null,
          confidence: null,
          evidenceIds: [],
          updatedAt: null,
          updatedBy: null,
        },
        testRuns: [],
        agentSession: null,
        workspace: {
          status: "not_created",
          url: null,
          ownerSubject: null,
          branchCreated: false,
          updatedAt: null,
        },
      };
      database.nextId += 1;
      database.issues.push(issue);
      return clone(issue);
    });
  }

  async get(id: string): Promise<Issue | undefined> {
    const database = await this.readDatabase();
    const issue = database.issues.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
    return issue ? clone(issue) : undefined;
  }

  async search(input: SearchIssueInput = {}): Promise<Issue[]> {
    const database = await this.readDatabase();
    const query = input.query?.trim().toLowerCase();
    const assignee = input.assignee?.trim().toLowerCase();
    const label = input.label?.trim().toLowerCase();
    const repositoryUrl = input.repositoryUrl?.trim().toLowerCase();
    const createdFrom = input.createdFrom ? Date.parse(input.createdFrom) : undefined;
    const createdTo = input.createdTo ? Date.parse(input.createdTo) : undefined;
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));

    return clone(database.issues
      .filter((issue) => !input.status || issue.status === input.status)
      .filter((issue) => !input.priority || issue.priority === input.priority)
      .filter((issue) => !input.type || issue.type === input.type)
      .filter((issue) => !assignee || issue.assignee?.toLowerCase() === assignee)
      .filter((issue) => !label || issue.labels.includes(label))
      .filter((issue) => !repositoryUrl || issue.repositories.some((repository) => repository.url.toLowerCase() === repositoryUrl))
      .filter((issue) => createdFrom === undefined || Date.parse(issue.createdAt) >= createdFrom)
      .filter((issue) => createdTo === undefined || Date.parse(issue.createdAt) < createdTo)
      .filter((issue) => {
        if (!query) return true;
        const haystack = [
          issue.id,
          issue.title,
          issue.description,
          issue.reporter,
          issue.assignee ?? "",
          issue.labels.join(" "),
          ...issue.comments.map((comment) => `${comment.author} ${comment.body}`),
        ].join(" ").toLowerCase();
        return haystack.includes(query);
      })
      .sort((left, right) => {
        const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
        return priority || right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, limit));
  }

  async update(id: string, input: UpdateIssueInput): Promise<Issue> {
    return this.mutate((database) => {
      const issue = database.issues.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
      if (!issue) throw new Error(`issue not found: ${id}`);
      if (input.expectedUpdatedAt && input.expectedUpdatedAt !== issue.updatedAt) {
        throw new Error(`issue ${issue.id} changed since ${input.expectedUpdatedAt}; read it again before updating`);
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const assign = <K extends keyof Issue>(key: K, value: Issue[K] | undefined) => {
        if (value === undefined || Object.is(issue[key], value)) return;
        if (Array.isArray(value) && Array.isArray(issue[key]) && JSON.stringify(issue[key]) === JSON.stringify(value)) return;
        changes[key] = { from: clone(issue[key]), to: clone(value) };
        issue[key] = value;
      };

      assign("title", input.title === undefined ? undefined : cleanText(input.title, "title"));
      assign("description", input.description?.trim());
      assign("status", input.status);
      assign("priority", input.priority);
      assign("type", input.type);
      assign("assignee", input.assignee === undefined ? undefined : input.assignee?.trim() || null);
      assign("labels", input.labels === undefined ? undefined : cleanLabels(input.labels));

      if (Object.keys(changes).length === 0) throw new Error("update contains no changes");
      const now = timestampAfter(issue.updatedAt);
      if (input.status === "resolved" || input.status === "closed") issue.resolvedAt ??= now;
      if (input.status && input.status !== "resolved" && input.status !== "closed") issue.resolvedAt = null;
      issue.updatedAt = now;
      issue.history.push({ at: now, actor: input.actor?.trim() || "agent", action: "updated", changes });
      return clone(issue);
    });
  }

  async addComment(id: string, body: string, author = "agent"): Promise<Issue> {
    return this.mutate((database) => {
      const issue = database.issues.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
      if (!issue) throw new Error(`issue not found: ${id}`);
      const now = timestampAfter(issue.updatedAt);
      const comment: IssueComment = {
        id: randomUUID(),
        author: cleanText(author, "author"),
        body: cleanText(body, "comment"),
        createdAt: now,
      };
      issue.comments.push(comment);
      issue.updatedAt = now;
      issue.history.push({ at: now, actor: comment.author, action: "commented" });
      return clone(issue);
    });
  }

  async bindAgentSession(
    id: string,
    binding: Omit<AgentSessionBinding, "updatedAt">,
    actor = "system",
    replace = false,
  ): Promise<AgentSessionBinding> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, id);
      if (issue.agentSession && !replace) return clone(issue.agentSession);
      const before = clone(issue.agentSession);
      const now = timestampAfter(issue.updatedAt);
      issue.agentSession = { ...binding, updatedAt: now };
      this.touchContext(issue, actor, "agentSession", before, issue.agentSession, now);
      return clone(issue.agentSession);
    });
  }

  async updateRepository(
    issueId: string,
    repositoryId: string,
    update: { workingBranch?: string | null; localPath?: string | null },
    actor = "system",
  ): Promise<RepositoryBinding> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, issueId);
      const repository = issue.repositories.find((candidate) => candidate.id === repositoryId);
      if (!repository) throw new Error(`repository not found on ${issue.id}: ${repositoryId}`);
      const before = clone(repository);
      if (update.workingBranch !== undefined) repository.workingBranch = update.workingBranch?.trim() || null;
      if (update.localPath !== undefined) repository.localPath = update.localPath?.trim() || null;
      const now = timestampAfter(issue.updatedAt);
      this.touchContext(issue, actor, "repository", before, repository, now);
      return clone(repository);
    });
  }

  async addEvidence(
    issueId: string,
    input: { source: EvidenceSource; summary: string; locator?: string | null; createdBy?: string },
  ): Promise<IssueEvidence> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, issueId);
      const now = timestampAfter(issue.updatedAt);
      const evidence: IssueEvidence = {
        id: randomUUID(),
        source: input.source,
        summary: cleanText(input.summary, "evidence summary"),
        locator: input.locator?.trim() || null,
        createdAt: now,
        createdBy: input.createdBy?.trim() || "agent",
      };
      issue.evidence.push(evidence);
      this.touchContext(issue, evidence.createdBy, "evidence", null, evidence, now);
      return clone(evidence);
    });
  }

  async recordDiagnosis(
    issueId: string,
    input: {
      classification: DiagnosisClassification;
      rootCause?: string | null;
      confidence?: number | null;
      evidenceIds?: string[];
      updatedBy?: string;
    },
  ): Promise<IssueDiagnosis> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, issueId);
      const evidenceIds = [...new Set(input.evidenceIds ?? [])];
      const unknown = evidenceIds.filter((id) => !issue.evidence.some((evidence) => evidence.id === id));
      if (unknown.length) throw new Error(`unknown evidence IDs: ${unknown.join(", ")}`);
      if (input.confidence !== undefined && input.confidence !== null && (input.confidence < 0 || input.confidence > 1)) {
        throw new Error("diagnosis confidence must be between 0 and 1");
      }
      const before = clone(issue.diagnosis);
      const now = timestampAfter(issue.updatedAt);
      const updatedBy = input.updatedBy?.trim() || "agent";
      issue.diagnosis = {
        classification: input.classification,
        rootCause: input.rootCause?.trim() || null,
        confidence: input.confidence ?? null,
        evidenceIds,
        updatedAt: now,
        updatedBy,
      };
      this.touchContext(issue, updatedBy, "diagnosis", before, issue.diagnosis, now);
      return clone(issue.diagnosis);
    });
  }

  async recordTestRun(
    issueId: string,
    input: Omit<IssueTestRun, "id" | "createdAt" | "createdBy"> & { createdBy?: string },
  ): Promise<IssueTestRun> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, issueId);
      const now = timestampAfter(issue.updatedAt);
      const run: IssueTestRun = {
        id: randomUUID(),
        scope: input.scope,
        command: cleanText(input.command, "test command"),
        status: input.status,
        summary: cleanText(input.summary, "test summary"),
        createdAt: now,
        createdBy: input.createdBy?.trim() || "agent",
      };
      issue.testRuns.push(run);
      this.touchContext(issue, run.createdBy, "testRun", null, run, now);
      return clone(run);
    });
  }

  async setWorkspace(
    issueId: string,
    input: Omit<CodeWorkspace, "updatedAt">,
    actor = "system",
  ): Promise<CodeWorkspace> {
    return this.mutate((database) => {
      const issue = this.requireIssue(database, issueId);
      const before = clone(issue.workspace);
      issue.workspace = { ...input, updatedAt: timestampAfter(issue.updatedAt) };
      this.touchContext(issue, actor, "workspace", before, issue.workspace, issue.workspace.updatedAt!);
      return clone(issue.workspace);
    });
  }

  async metrics(input: Pick<SearchIssueInput, "assignee" | "repositoryUrl" | "type" | "createdFrom" | "createdTo"> = {}): Promise<IssueStatistics> {
    const database = await this.readDatabase();
    const assignee = input.assignee?.trim().toLowerCase();
    const repositoryUrl = input.repositoryUrl?.trim().toLowerCase();
    const createdFrom = input.createdFrom ? Date.parse(input.createdFrom) : undefined;
    const createdTo = input.createdTo ? Date.parse(input.createdTo) : undefined;
    const issues = database.issues
      .filter((issue) => !assignee || issue.assignee?.toLowerCase() === assignee)
      .filter((issue) => !repositoryUrl || issue.repositories.some((repository) => repository.url.toLowerCase() === repositoryUrl))
      .filter((issue) => !input.type || issue.type === input.type)
      .filter((issue) => createdFrom === undefined || Date.parse(issue.createdAt) >= createdFrom)
      .filter((issue) => createdTo === undefined || Date.parse(issue.createdAt) < createdTo);
    const byStatus = Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0])) as Record<IssueStatus, number>;
    const byPriority = Object.fromEntries(ISSUE_PRIORITIES.map((priority) => [priority, 0])) as Record<IssuePriority, number>;
    const byType = Object.fromEntries(ISSUE_TYPES.map((type) => [type, 0])) as Record<IssueType, number>;
    const byAssignee: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    const cycleHours: number[] = [];
    const activeAges: number[] = [];
    const now = Date.now();
    for (const issue of issues) {
      byStatus[issue.status] += 1;
      byPriority[issue.priority] += 1;
      byType[issue.type] += 1;
      const owner = issue.assignee ?? "unassigned";
      byAssignee[owner] = (byAssignee[owner] ?? 0) + 1;
      for (const repository of issue.repositories) {
        byProject[repository.url] = (byProject[repository.url] ?? 0) + 1;
      }
      if (issue.resolvedAt) cycleHours.push((Date.parse(issue.resolvedAt) - Date.parse(issue.createdAt)) / 3_600_000);
      else activeAges.push((now - Date.parse(issue.createdAt)) / 3_600_000);
    }
    cycleHours.sort((left, right) => left - right);
    activeAges.sort((left, right) => left - right);
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const percentile = (values: number[], value: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)]! : null;
    const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
    const completed = issues.filter((issue) => Boolean(issue.resolvedAt)).length;
    return {
      total: issues.length,
      active: issues.length - completed,
      completed,
      byStatus,
      byPriority,
      byType,
      byAssignee,
      byProject,
      unassigned: issues.filter((issue) => !issue.assignee && !["resolved", "closed"].includes(issue.status)).length,
      cycleTimeHours: {
        average: round(average(cycleHours)),
        median: round(percentile(cycleHours, 0.5)),
        p95: round(percentile(cycleHours, 0.95)),
      },
      activeAgeHours: {
        average: round(average(activeAges)),
        oldest: round(activeAges.length ? activeAges.at(-1)! : null),
      },
    };
  }

  private requireIssue(database: IssueDatabase, id: string): Issue {
    const issue = database.issues.find((candidate) => candidate.id.toLowerCase() === id.trim().toLowerCase());
    if (!issue) throw new Error(`issue not found: ${id}`);
    return issue;
  }

  private touchContext(issue: Issue, actor: string, field: string, from: unknown, to: unknown, now: string): void {
    issue.updatedAt = now;
    issue.history.push({
      at: now,
      actor,
      action: "context_updated",
      changes: { [field]: { from: clone(from), to: clone(to) } },
    });
  }

  private async readDatabase(): Promise<IssueDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const value: unknown = JSON.parse(raw);
      assertDatabase(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY_DATABASE);
      if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${this.filePath}: ${error.message}`);
      throw error;
    }
  }

  private async mutate<T>(operation: (database: IssueDatabase) => T): Promise<T> {
    const run = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const release = await this.acquireLock();
      try {
        const database = await this.readDatabase();
        const result = operation(database);
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.filePath);
        return result;
      } finally {
        await release();
      }
    };

    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        return async () => {
          await handle.close();
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = await readFile(lockPath, "utf8");
          const timestamp = Number(lock.trim().split(/\s+/)[1]);
          if (Number.isFinite(timestamp) && Date.now() - timestamp > 30_000) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch {
          // Another process may have released the lock between operations.
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for issue store lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
