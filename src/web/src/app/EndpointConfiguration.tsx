import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Select, Skeleton } from "../ui";
import { errorMessage, loadApplicationEndpoints, type ApplicationEndpoint } from "../data/client";
import { copyText } from "../ui/clipboard";
import { useApplicationResources } from "./ApplicationResources";

const clientFormats = [
  { value: "json", label: "Pi / Cursor / Claude Code", guidance: "Pi：~/.pi/agent/mcp.json；Cursor：.cursor/mcp.json；Claude Code：.mcp.json。将下面的条目加入已有配置。" },
  { value: "vscode", label: "VS Code", guidance: "将下面的 servers 条目加入 .vscode/mcp.json。" },
  { value: "codex", label: "Codex", guidance: "将下面的配置追加到 ~/.codex/config.toml。" },
] as const;

export function EndpointConfiguration() {
  const { currentUser } = useApplicationResources();
  const [endpoints, setEndpoints] = createSignal<ApplicationEndpoint[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [copied, setCopied] = createSignal("", { ownedWrite: true });
  const [copyError, setCopyError] = createSignal("", { ownedWrite: true });
  const [format, setFormat] = createSignal<(typeof clientFormats)[number]["value"]>("json", { ownedWrite: true });
  let controller: AbortController | undefined;
  const load = async () => {
    controller?.abort(); const request = new AbortController(); controller = request;
    setLoading(true); setError("");
    try { const value = await loadApplicationEndpoints(request.signal); if (!request.signal.aborted) setEndpoints(value.endpoints); }
    catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  };
  createEffect(() => currentUser()?.subject, () => { setEndpoints([]); setCopied(""); setCopyError(""); void load(); });
  onCleanup(() => controller?.abort());
  const url = (endpoint: ApplicationEndpoint) => new URL(endpoint.path, window.location.origin).href;
  const client = () => clientFormats.find(client => client.value === format())!;
  const configuration = (endpoint: ApplicationEndpoint) => {
    const subject = currentUser()?.subject;
    if (!subject) return "";
    if (format() === "codex") return `[mcp_servers.issue-pilot]\nurl = ${JSON.stringify(url(endpoint))}\nhttp_headers = { "X-Issue-Pilot-Subject" = ${JSON.stringify(subject)} }`;
    return JSON.stringify({ [format() === "vscode" ? "servers" : "mcpServers"]: { "issue-pilot": { type: "http", url: url(endpoint), headers: { "X-Issue-Pilot-Subject": subject } } } }, null, 2);
  };
  const copyKey = (endpoint: ApplicationEndpoint) => `${currentUser()?.subject}:${endpoint.path}:${format()}`;
  const copy = async (endpoint: ApplicationEndpoint) => {
    const text = configuration(endpoint);
    if (!text) return;
    const key = copyKey(endpoint);
    setCopied(""); setCopyError("");
    try { await copyText(text); if (key === copyKey(endpoint)) setCopied(key); }
    catch { if (key === copyKey(endpoint)) setCopyError("复制失败，请选中下方配置手动复制。"); }
  };
  return <main class="endpoint-configuration"><section class="user-management-card" aria-label="端点说明">
    <Show when={error()}><div class="workspace-error" role="alert">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    <Show when={!loading()} fallback={<div class="user-management-loading"><Skeleton active paragraph={{ rows: 5 }} /></div>}>
      <For each={endpoints()} fallback={<Show when={!error()}><div class="empty-band">暂无可用端点</div></Show>}>{endpoint => <article class="endpoint-description">
        <div class="endpoint-config">
          <div class="endpoint-config-toolbar"><Select aria-label="接入客户端" value={format()} options={clientFormats} onChange={value => { setFormat(value); setCopied(""); setCopyError(""); }} /><Button type="primary" size="small" disabled={!currentUser()?.subject} onClick={() => { void copy(endpoint); }}>{copied() === copyKey(endpoint) ? "已复制配置" : "复制配置"}</Button></div>
          <p class="endpoint-guidance">{client().guidance}</p>
          <Show when={currentUser()} fallback={<p class="endpoint-guidance">连接身份加载后即可复制配置。</p>}>{user => <>
            <p class="endpoint-identity">连接身份：{user().name} <code>{user().subject}</code></p>
            <pre aria-label="MCP 客户端配置"><code>{configuration(endpoint)}</code></pre>
          </>}</Show>
          <p class="endpoint-guidance">配置使用右上角选择的用户身份；为其他用户提供配置时请先切换用户。身份头用于选择用户，入口网关认证需在客户端另行配置。</p>
          <Show when={copyError()}><p class="workspace-error" role="alert">{copyError()}</p></Show>
          <span class="visually-hidden" role="status">{copied() ? "复制成功" : ""}</span>
        </div>
        <Show when={!endpoint.readOnly}><p class="endpoint-guidance">连接后先用 users_list 确认身份、services_list 查看服务，再创建工单或发送消息；用 issue_get 和 issue_conversation 查看处理进展及回复。</p></Show>
        <details class="endpoint-tools"><summary>可用工具（{endpoint.tools.length}）</summary><div class="endpoint-tool-list"><For each={endpoint.tools}>{tool => <div class="endpoint-tool"><code>{tool.name}</code><p>{tool.description}</p></div>}</For></div></details>
      </article>}</For>
    </Show>
  </section></main>;
}
