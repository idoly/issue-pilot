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
  await Promise.all([requireWebFile(root, "index.html"), requireWebFile(root, "vscode.html")]);
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    maxAge: "1y",
    immutable: true,
    allowedPath: (name) => {
      const relative = name.replace(/^\/+/, "");
      return relative === "index.html" || relative === "vscode.html" || relative.startsWith("assets/");
    },
    setHeaders(reply, file) {
      reply.header("X-Content-Type-Options", "nosniff");
      if (file.endsWith(".html")) reply.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    },
  });
  const sendHtml = (name: "index.html" | "vscode.html") => (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return reply.sendFile(name, { maxAge: 0, immutable: false });
  };
  app.get("/", sendHtml("index.html"));
  app.get("/vscode.html", sendHtml("vscode.html"));
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.split(",").some((value) => value.trim().startsWith("text/html")) ?? false;
    if ((request.method === "GET" || request.method === "HEAD") && !request.url.startsWith("/api/") && acceptsHtml) return sendHtml("index.html")(request, reply);
    return reply.code(404).send({ error: "not_found" });
  });
}
