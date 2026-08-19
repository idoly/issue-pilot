import { and, eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { sessionTranscript, subscribeBufferedAgentEvents, type RunEvent } from "../agent/events.ts";
import { sessionFooterStats } from "../agent/footer.ts";
import { agentSessions, issues, serviceDeployments } from "../db/schema.ts";
import { AGENT_THINKING_LEVELS, type AgentFooterStats, type AgentThinkingLevel } from "../domain/contracts.ts";
import { pathExists } from "../workspace/state.ts";
import { ApiError, record, text } from "./input.ts";
import { requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
import { createOrderedSseWriter } from "./sse.ts";

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
    const [deployment] = await database.db.select({ config: serviceDeployments.config }).from(serviceDeployments)
      .where(and(eq(serviceDeployments.serviceId, issue.serviceId), eq(serviceDeployments.environmentId, issue.environmentId))).limit(1);
    const deploymentConfig = deployment?.config as Record<string, unknown> | undefined;
    const configuredAgent = deploymentConfig?.agent && typeof deploymentConfig.agent === "object" ? deploymentConfig.agent as Record<string, unknown> : {};
    const provider = typeof configuredAgent.provider === "string" && configuredAgent.provider ? configuredAgent.provider : "not-configured";
    const model = typeof configuredAgent.model === "string" && configuredAgent.model ? configuredAgent.model : "not-configured";
    const thinkingLevel = typeof configuredAgent.thinkingLevel === "string" && AGENT_THINKING_LEVELS.includes(configuredAgent.thinkingLevel as AgentThinkingLevel)
      ? configuredAgent.thinkingLevel : "not-configured";
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
      const writer = createOrderedSseWriter(reply.raw, issuePilotConfig.http.ssePendingBytes, (error) => {
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
      heartbeat = setInterval(() => writer.write(": heartbeat\n\n"), issuePilotConfig.http.sseHeartbeatMs); heartbeat.unref();
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
    const input = record(request.body);
    const message = text(input.message, "agent_message", issuePilotConfig.limits.agentMessageChars);
    try { await engine.send(issue.id, message); }
    catch (error) {
      if (error instanceof Error && ["issue_already_running", "resolved_issue_cannot_run_agent"].includes(error.message)) throw new ApiError(409, error.message);
      throw error;
    }
    return reply.code(202).send();
  });

}
