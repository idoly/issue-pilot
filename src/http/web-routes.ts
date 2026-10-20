import { stat } from "node:fs/promises";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

async function requireWebFile(root: string, name: string): Promise<void> {
  try {
    const metadata = await stat(path.join(root, name));
    if (metadata.isFile()) return;
  } catch {
    // Normalize missing and inaccessible production build files to one startup error.
  }
  throw new Error(`web_build_file_missing:${name}`);
}

export async function registerWebRoutes(app: FastifyInstance, configuredRoot: string): Promise<void> {
  const root = path.resolve(configuredRoot);
  await requireWebFile(root, "index.html");
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    maxAge: "1y",
    immutable: true,
    allowedPath: (name) => {
      const relative = name.replace(/^\/+/, "");
      return relative === "index.html" || relative.startsWith("assets/");
    },
    setHeaders(reply, file) {
      reply.header("X-Content-Type-Options", "nosniff");
      if (file.endsWith(".html")) reply.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    },
  });
  const sendHtml = (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return reply.sendFile("index.html", { maxAge: 0, immutable: false });
  };
  app.get("/", sendHtml);
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.split(",").some((value) => value.trim().startsWith("text/html")) ?? false;
    const requestedPath = request.url.split("?")[0] ?? "/";
    if ((request.method === "GET" || request.method === "HEAD") && !requestedPath.startsWith("/api/") && !path.extname(requestedPath) && acceptsHtml) return sendHtml(request, reply);
    return reply.code(404).send({ error: "not_found" });
  });
}
