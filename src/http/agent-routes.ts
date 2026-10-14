import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadGlobalAgentConfiguration } from "../configuration/agent.ts";
import { sessionTranscript, subscribeBufferedAgentEvents, type RunEvent } from "../agent/events.ts";
import { sessionFooterStats } from "../agent/footer.ts";
import { agentSessions, issues, subjects } from "../db/schema.ts";
import type { AgentFooterStats } from "../domain/contracts.ts";
import { pathExists } from "../workspace/state.ts";
import { ApiError, record, text } from "./input.ts";
import { ensureCurrentSubject, requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
import { createOrderedSseWriter } from "./sse.ts";

const agentImageMediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function agentMessageText(value: unknown): string {
  if (typeof value === "string" && value.length > issuePilotConfig.limits.agentMessageChars) throw new ApiError(400, "agent_message_too_long");
  return text(value, "agent_message", issuePilotConfig.limits.agentMessageChars);
}

async function readAgentMessage(request: FastifyRequest): Promise<{ message: string; images: ImageContent[] }> {
  if (!request.isMultipart()) return { message: agentMessageText(record(request.body).message), images: [] };
  const limits = issuePilotConfig.limits.agentImage;
  const images: ImageContent[] = [];
  let message: string | undefined;
  let totalBytes = 0;
  for await (const part of request.parts()) {
    if (part.type === "field") {
      if (part.fieldname !== "message" || message !== undefined) throw new ApiError(400, "invalid_agent_message");
      message = agentMessageText(part.value);
      continue;
    }
    if (part.fieldname !== "images" || !agentImageMediaTypes.has(part.mimetype) || images.length >= limits.files) throw new ApiError(400, "invalid_agent_image");
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    for await (const chunk of part.file) {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fileBytes += content.length; totalBytes += content.length;
      if (fileBytes > limits.fileBytes || totalBytes > limits.requestBytes) throw new ApiError(413, "agent_image_limit_exceeded");
      chunks.push(content);
    }
    if (part.file.truncated) throw new ApiError(413, "agent_image_limit_exceeded");
    images.push({ type: "image", mimeType: part.mimetype, data: Buffer.concat(chunks).toString("base64") });
  }
  if (!message) throw new ApiError(400, "invalid_agent_message");
  return { message, images };
}

export function registerAgentRoutes(context: ApiRouteContext): void {
  const { app, database, engine, events, modelCatalog } = context;

  app.post<{ Params: { key: string } }>("/api/issues/:key/retry", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    await runIssueExclusive(engine, [issue.id], async (reservation) => {
      const currentIssue = await requireIssue(database, issue.key);
      if (currentIssue.status !== "open") throw new ApiError(409, "issue_not_retryable");
      reservation.enqueue(issue.id);
    });
    return reply.code(202).send({ ok: true });
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/agent-stream", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const { provider, model, thinkingLevel } = await loadGlobalAgentConfiguration(database.db);
    const configuredModel = (await modelCatalog.list()).find((candidate) => candidate.provider === provider && candidate.id === model);
    const contextWindow = configuredModel?.contextWindow ?? 0;
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const sessionReady = Boolean(binding && await pathExists(binding.sessionFile));
    const liveEvents = subscribeBufferedAgentEvents(events, issue.id);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let hijacked = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      reply.raw.off("close", cleanup);
      if (heartbeat) clearInterval(heartbeat);
      liveEvents.unsubscribe();
    };
    try {
      const [currentIssue] = await database.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id)).limit(1);
      if (!currentIssue) throw new ApiError(404, "issue_not_found");
      const manager = binding && sessionReady ? SessionManager.open(binding.sessionFile) : undefined;
      const transcript = manager ? sessionTranscript(manager, issue.id) : [];
      const footer: AgentFooterStats = manager ? sessionFooterStats(manager, contextWindow) : {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
        latestCacheHitRate: null, contextPercent: 0, contextWindow, autoCompact: true,
      };
      reply.raw.once("close", cleanup);
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      const writer = createOrderedSseWriter(reply.raw, (error) => {
        try { app.log.error(error); }
        finally {
          cleanup();
          reply.raw.destroy();
        }
      });
      const sent = new Set<string>();
      const send = (event: RunEvent) => {
        if (sent.has(event.id)) return;
        sent.add(event.id);
        writer.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for (const event of transcript) send(event);
      for (const event of events.replayCurrent(issue.id)) send(event);
      writer.write(`event: snapshot_ready\ndata: ${JSON.stringify({ agent: { provider, model, thinkingLevel }, footer, running: engine.isRunning(issue.id), issueStatus: currentIssue.status })}\n\n`);
      if (cleaned) return;
      heartbeat = setInterval(() => writer.write("event: heartbeat\ndata: {}\n\n"), issuePilotConfig.http.sseHeartbeatMs); heartbeat.unref();
      liveEvents.activate(send);
    } catch (error) {
      cleanup();
      if (hijacked && !reply.raw.destroyed) reply.raw.destroy();
      throw error;
    }
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/agent-messages", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    if (issue.status === "resolved") throw new ApiError(409, "resolved_issue_cannot_run_agent");
    const { message, images } = await readAgentMessage(request);
    const subject = await ensureCurrentSubject(database, request);
    const [person] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new ApiError(400, "invalid_current_subject");
    try {
      await engine.send(issue.id, message, {
        name: person.displayName ?? person.subject,
        email: person.email ?? `${person.subject}@localhost`,
      }, images);
    }
    catch (error) {
      if (error instanceof Error && ["issue_already_running", "resolved_issue_cannot_run_agent"].includes(error.message)) throw new ApiError(409, error.message);
      throw error;
    }
    return reply.code(202).send();
  });

}
