import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadGlobalAgentConfiguration } from "../configuration/agent.ts";
import { sessionTranscript, subscribeBufferedAgentEvents, type RunEvent } from "../agent/events.ts";
import { sessionFooterStats } from "../agent/footer.ts";
import { agentSessions, issues } from "../db/schema.ts";
import { pathExists } from "../workspace/state.ts";
import { ApiError, record, text } from "./input.ts";
import { requireCurrentUser, requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
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
  const recentEventLimit = issuePilotConfig.http.sseRecentEventIds;
  if (!Number.isSafeInteger(recentEventLimit) || recentEventLimit < 1) throw new Error("invalid_sse_event_id_budget");

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
    const { provider, model, thinkingLevel, runtime } = await loadGlobalAgentConfiguration(database.db);
    const autoCompact = SettingsManager.inMemory(runtime.settings).getCompactionEnabled();
    const configuredModel = (await modelCatalog.list()).find((candidate) => candidate.provider === provider && candidate.id === model);
    const contextWindow = configuredModel?.contextWindow ?? 0;
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const sessionReady = Boolean(binding && await pathExists(binding.sessionFile));
    if (reply.raw.destroyed) { reply.hijack(); return; }
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
    reply.raw.once("close", cleanup);
    try {
      // Read durable and in-flight events together before awaiting newer Issue state.
      const manager = binding && sessionReady ? SessionManager.open(binding.sessionFile) : undefined;
      const transcript = manager ? sessionTranscript(manager, issue.id) : [];
      const footer = sessionFooterStats(manager, contextWindow, autoCompact);
      const currentEvents = events.replayCurrent(issue.id);
      const [currentIssue] = await database.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id)).limit(1);
      if (cleaned) { reply.hijack(); return; }
      if (!currentIssue) throw new ApiError(404, "issue_not_found");
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
      const sentEntries = new Set<string>();
      const sentTransient = new Set<string>();
      let replayComplete = false;
      let recentIds: string[] = [];
      let nextRecent = 0;
      const send = (event: RunEvent) => {
        if (event.event.type === "entry_appended") {
          if (sentEntries.has(event.event.entry.id)) return;
          sentEntries.add(event.event.entry.id);
        } else {
          if (sentTransient.has(event.id)) return;
          if (replayComplete) {
            if (recentIds.length === recentEventLimit) {
              sentTransient.delete(recentIds[nextRecent]!);
              recentIds[nextRecent] = event.id;
              nextRecent = (nextRecent + 1) % recentEventLimit;
            } else recentIds.push(event.id);
          }
          sentTransient.add(event.id);
        }
        let serialized: string;
        try { serialized = JSON.stringify(event); }
        catch (error) {
          cleanup();
          reply.raw.destroy();
          throw error;
        }
        writer.write(`id: ${event.id}\ndata: ${serialized}\n\n`);
      };
      for (const event of transcript) send(event);
      // Snapshot totals also include hidden entries, such as cache-warming usage.
      for (const entry of manager?.getEntries() ?? []) sentEntries.add(entry.id);
      for (const event of currentEvents) send(event);
      writer.write(`event: snapshot_ready\ndata: ${JSON.stringify({ agent: { provider, model, thinkingLevel }, footer, running: engine.isRunning(issue.id), issueStatus: currentIssue.status })}\n\n`);
      if (cleaned) return;
      heartbeat = setInterval(() => writer.write("event: heartbeat\ndata: {}\n\n"), issuePilotConfig.http.sseHeartbeatMs); heartbeat.unref();
      liveEvents.activate(send);
      // Replay can exceed the live window; prune only after its buffered overlap is deduplicated.
      replayComplete = true;
      recentIds = [...sentTransient].slice(-recentEventLimit);
      sentTransient.clear();
      for (const id of recentIds) sentTransient.add(id);
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
    const person = await requireCurrentUser(database, request);
    try {
      await engine.send(issue.id, message, {
        name: person.displayName ?? person.subject,
        email: person.email ?? `${person.subject}@localhost`,
      }, images);
    }
    catch (error) {
      if (error instanceof Error && ["issue_already_running", "resolved_issue_cannot_run_agent", "agent_message_outcome_unknown"].includes(error.message)) throw new ApiError(409, error.message);
      throw error;
    }
    return reply.code(202).send();
  });

}
