import { stat } from "node:fs/promises";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export async function assertWebBuild(root: string): Promise<void> {
  const name = "index.html";
  try {
    const metadata = await stat(path.join(root, name));
    if (metadata.isFile()) return;
  } catch {
    // Normalize missing and inaccessible production build files to one startup error.
  }
  throw new Error(`web_build_file_missing:${name}`);
}

// Defense in depth for content rendered from Issues and Agent output; Monaco needs workers and inline styles.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  // Attachment PDF previews use blob: URLs in an iframe.
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
function securityHeaders(reply: FastifyReply): void {
  reply.header("Content-Security-Policy", contentSecurityPolicy);
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
}
// Vite emits content-hashed bundles; public files keep stable names and must not be cached for a year.
const hashedAsset = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
function cacheControl(file: string): string {
  if (file.endsWith(".html")) return "private, no-cache, no-store, must-revalidate";
  return hashedAsset.test(path.basename(file)) ? "public, max-age=31536000, immutable" : "public, max-age=3600";
}

export async function registerWebRoutes(app: FastifyInstance, configuredRoot: string): Promise<void> {
  const root = path.resolve(configuredRoot);
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    maxAge: 0,
    immutable: false,
    allowedPath: (name) => {
      const relative = name.replace(/^\/+/, "");
      return relative === "index.html" || relative.startsWith("assets/");
    },
    setHeaders(reply, file) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", cacheControl(file));
      if (file.endsWith(".html")) securityHeaders(reply);
    },
  });
  const sendHtml = (_request: FastifyRequest, reply: FastifyReply) => {
    securityHeaders(reply);
    reply.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
    reply.sendFile("index.html", { maxAge: 0, immutable: false });
  };
  app.get("/", sendHtml);
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.split(",").some((value) => value.trim().startsWith("text/html")) ?? false;
    const requestedPath = request.url.split("?")[0] ?? "/";
    if ((request.method === "GET" || request.method === "HEAD") && !requestedPath.startsWith("/api/") && !path.extname(requestedPath) && acceptsHtml) {
      sendHtml(request, reply);
      return;
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
