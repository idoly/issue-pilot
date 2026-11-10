export const ISSUE_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_BATCH_SIZE = 16;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const QUERY_INSTRUCTION = "Given a search query, retrieve historical issue reports that describe the same problem.";

export class WorkersAiError extends Error {}

export async function issueEmbeddings(
  credentials: { accountId: string; apiToken: string },
  input: { documents: string[] } | { query: string },
  signal: AbortSignal,
  request: typeof fetch,
): Promise<Buffer[]> {
  const { accountId, apiToken } = credentials;
  const count = "documents" in input ? input.documents.length : 1;
  const body = "documents" in input ? input : { queries: input.query, instruction: QUERY_INSTRUCTION };
  const deadline = AbortSignal.timeout("documents" in input ? 12_000 : 20_000);
  try {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${ISSUE_EMBEDDING_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([signal, deadline]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new WorkersAiError(
        response.status === 401 || response.status === 403
          ? "issue_search_cloudflare_access_denied"
          : response.status === 429
            ? "issue_search_cloudflare_rate_limited"
            : "issue_search_cloudflare_failed",
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_BYTES) {
          await reader.cancel();
          throw new WorkersAiError("issue_search_cloudflare_invalid_response");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    } catch {
      throw new WorkersAiError("issue_search_cloudflare_invalid_response");
    }
    return parseEmbeddings(parsed, count);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkersAiError) throw error;
    // Provider errors can contain credentials and input; keep only a stable error at the boundary.
    throw new WorkersAiError(deadline.aborted ? "issue_search_cloudflare_timed_out" : "issue_search_cloudflare_failed");
  }
}

function parseEmbeddings(value: unknown, count: number): Buffer[] {
  const invalid = () => new WorkersAiError("issue_search_cloudflare_invalid_response");
  if (!value || typeof value !== "object") throw invalid();
  const response = value as { success?: unknown; result?: { data?: unknown; shape?: unknown } };
  const result = response.result;
  if (response.success === false || !Array.isArray(result?.data) || result.data.length !== count) throw invalid();
  if (result.shape !== undefined && (!Array.isArray(result.shape) || result.shape.length !== 2 || result.shape[0] !== count || result.shape[1] !== EMBEDDING_DIMENSIONS)) throw invalid();
  return result.data.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== EMBEDDING_DIMENSIONS) throw invalid();
    const buffer = Buffer.allocUnsafe(EMBEDDING_DIMENSIONS * 4);
    let norm = 0;
    for (const [index, item] of row.entries()) {
      const component = typeof item === "number" ? Math.fround(item) : NaN;
      if (!Number.isFinite(component)) throw invalid();
      buffer.writeFloatLE(component, index * 4);
      norm += component * component;
    }
    if (Math.fround(norm) === 0 || !Number.isFinite(Math.fround(norm))) throw invalid();
    return buffer;
  });
}
