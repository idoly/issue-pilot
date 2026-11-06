import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadGlobalAgentConfiguration, selectAgentConfiguration } from "../configuration/agent.ts";
import { loadIssueCredentialOwner } from "../configuration/user-credentials.ts";
import { sessionTranscript, subscribeBufferedAgentEvents, type RunEvent } from "../agent/events.ts";
import { assertSessionFileComplete } from "../agent/pi-session.ts";
import { resetIssueSession, issueSessionHistory, readIssueSessionHistory } from "../agent/session-reset.ts";
import { sessionFooterStats } from "../agent/footer.ts";
import { agentSessions, issues } from "../db/schema.ts";
import { pathExists } from "../workspace/state.ts";
import { personGitIdentity } from "../domain/contracts.ts";
import { ApiError, record, text } from "./input.ts";
import { requireCurrentUser, requireDeveloper, requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
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
      fileBytes += content.length;
      totalBytes += content.length;
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
  const { app, database, engine, events, modelCatalog, runScopeExclusive, stateRoot } = context;
  const recentEventLimit = issuePilotConfig.http.sseRecentEventIds;
  if (!Number.isSafeInteger(recentEventLimit) || recentEventLimit < 1) throw new Error("invalid_sse_event_id_budget");

  app.get<{ Params: { key: string } }>("/api/issues/:key/sessions", async (request, _reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    return runScopeExclusive(async () => (await issueSessionHistory(database.db, stateRoot, issue)).map(({ file: _file, ...entry }) => entry));
  });

  app.get<{ Params: { key: string; sessionId: string }; Querystring: { offset?: string } }>("/api/issues/:key/sessions/:sessionId", async (request, _reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    let manager: Awaited<ReturnType<typeof readIssueSessionHistory>>;
    try {
      manager = await runScopeExclusive(() => readIssueSessionHistory(database.db, stateRoot, issue, request.params.sessionId));
    } catch (error) {
      if (error instanceof Error && error.message === "agent_session_not_found") throw new ApiError(404, "agent_session_not_found");
      throw error;
    }
    // A readonly transcript uses the same private-entry projection as the live conversation.
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, "invalid_offset");
    const transcript = sessionTranscript(manager, issue.id),
      page = transcript.slice(offset, offset + 50);
    return { events: page, nextOffset: offset + page.length < transcript.length ? offset + page.length : null };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/reset-session", async (request, reply) => {
    await requireDeveloper(database, request);
    const input = record(request.body),
      expectedSessionId = text(input.expectedSessionId, "session_id", 255);
    const issue = await requireIssue(database, request.params.key);
    const result = await runScopeExclusive(() =>
      runIssueExclusive(engine, [issue.id], async (reservation) => {
        const actor = await requireDeveloper(database, request);
        const current = await requireIssue(database, issue.key);
        if (current.status === "resolved") throw new ApiError(409, "resolved_issue_cannot_reset_session");
        const history = await issueSessionHistory(database.db, stateRoot, current);
        if (history[0]?.sessionId !== expectedSessionId) throw new ApiError(409, "agent_session_changed");
        await reservation.closeSession(issue.id);
        const reset = await resetIssueSession(database.db, stateRoot, current, actor, expectedSessionId);
        events.publish({ id: crypto.randomUUID(), issueId: issue.id, createdAt: new Date().toISOString(), event: { type: "session_reset" } });
        return reset;
      }),
    );
    return reply.send(result);
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/abort", async (request, reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    if (!engine.abort) throw new ApiError(501, "agent_abort_unavailable");
    try {
      await engine.abort(issue.id, async () => {
        await requireCurrentUser(database, request);
        await requireIssue(database, issue.key);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "issue_already_running") throw new ApiError(409, error.message);
      throw error;
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/retry", async (request, reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    await runIssueExclusive(engine, [issue.id], async (reservation) => {
      const currentIssue = await requireIssue(database, issue.key);
      // The engine can start any unresolved Issue; the detail view offers the same retry for pending ones.
      if (currentIssue.status === "resolved") throw new ApiError(409, "issue_not_retryable");
      reservation.enqueue(issue.id);
    });
    return reply.code(202).send({ ok: true });
  });

  // Long-lived SSE streams keep a graceful stop from completing; end them when the server closes.
  const activeStreams = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...activeStreams]) end();
  });
  app.get<{ Params: { key: string } }>("/api/issues/:key/agent-stream", async (request, reply) => {
    // Validate an explicitly selected identity. Browser EventSource sends no subject header, so the
    // default active user applies; an inactive explicit subject is refused here like other routes.
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    const sharedConfiguration = await loadGlobalAgentConfiguration(database.db);
    // Same owner rule as execution; an inactive owner has no usable personal group, so this view falls back to the shared one.
    const owner = await loadIssueCredentialOwner(database.db, issue.id).catch((error: unknown) => {
      if (error instanceof Error && error.message === "issue_credential_owner_inactive") return undefined;
      throw error;
    });
    const configured = selectAgentConfiguration(sharedConfiguration, owner?.credentials?.modelCredentials);
    const autoCompact = SettingsManager.inMemory(configured.runtime.settings).getCompactionEnabled();
    const models = await modelCatalog.list();
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const sessionReady = Boolean(binding && (await pathExists(binding.sessionFile)));
    if (reply.raw.destroyed) {
      reply.hijack();
      return;
    }
    const liveEvents = subscribeBufferedAgentEvents(events, issue.id, {
      maxPendingBytes: issuePilotConfig.http.sseQueuedBytes,
      onFailure(error) {
        try {
          app.log.error(error);
        } finally {
          cleanup();
          reply.raw.destroy();
        }
      },
    });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let hijacked = false;
    let cleaned = false;
    let stopStream: (() => void) | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (stopStream) activeStreams.delete(stopStream);
      reply.raw.off("close", cleanup);
      if (heartbeat) clearInterval(heartbeat);
      liveEvents.unsubscribe();
    };
    reply.raw.once("close", cleanup);
    try {
      if (binding && sessionReady) await assertSessionFileComplete(binding.sessionFile);
      // Read durable and in-flight events together before awaiting newer Issue state.
      const manager = binding && sessionReady ? SessionManager.open(binding.sessionFile) : undefined;
      const transcript = manager ? sessionTranscript(manager, issue.id) : [];
      const sessionContext = manager?.buildSessionContext();
      // A persisted session describes the displayed conversation, even if its owner has since changed models.
      const { provider, model, thinkingLevel } = sessionContext?.model
        ? { provider: sessionContext.model.provider, model: sessionContext.model.modelId, thinkingLevel: sessionContext.thinkingLevel }
        : configured;
      const contextWindow = models.find((candidate) => candidate.provider === provider && candidate.id === model)?.contextWindow ?? 0;
      const footer = sessionFooterStats(manager, contextWindow, autoCompact, sessionContext);
      const currentEvents = events.replayCurrent(issue.id);
      const [currentIssue] = await database.db.select({ status: issues.status }).from(issues).where(eq(issues.id, issue.id)).limit(1);
      if (cleaned) {
        reply.hijack();
        return;
      }
      if (!currentIssue) throw new ApiError(404, "issue_not_found");
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      stopStream = () => {
        if (!reply.raw.destroyed) reply.raw.end();
      };
      activeStreams.add(stopStream);
      const writer = createOrderedSseWriter(reply.raw, (error) => {
        try {
          app.log.error(error);
        } finally {
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
        try {
          serialized = JSON.stringify(event);
        } catch (error) {
          cleanup();
          reply.raw.destroy();
          throw error;
        }
        writer.write(`id: ${event.id}\ndata: ${serialized}\n\n`);
      };
      // Pace replay instead of queueing the entire transcript behind a slow socket.
      for (const event of transcript) {
        send(event);
        await writer.drain();
        if (cleaned) return;
      }
      // Snapshot totals also include hidden entries, such as cache-warming usage.
      for (const entry of manager?.getEntries() ?? []) sentEntries.add(entry.id);
      for (const event of currentEvents) {
        send(event);
        await writer.drain();
        if (cleaned) return;
      }
      writer.write(
        `event: snapshot_ready\ndata: ${JSON.stringify({ agent: { provider, model, thinkingLevel }, footer, running: engine.isRunning(issue.id), runState: engine.getRunState(issue.id), issueStatus: currentIssue.status })}\n\n`,
      );
      if (cleaned) return;
      heartbeat = setInterval(() => writer.write("event: heartbeat\ndata: {}\n\n"), issuePilotConfig.http.sseHeartbeatMs);
      heartbeat.unref();
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
      await engine.send(issue.id, message, personGitIdentity(person), images, () => requireCurrentUser(database, request));
    } catch (error) {
      if (error instanceof Error && ["issue_already_running", "resolved_issue_cannot_run_agent", "agent_message_outcome_unknown"].includes(error.message)) throw new ApiError(409, error.message);
      throw error;
    }
    return reply.code(202).send();
  });
}
