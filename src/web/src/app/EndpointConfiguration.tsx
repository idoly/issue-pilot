import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Skeleton } from "../ui";
import { errorMessage, loadApplicationEndpoints, type ApplicationEndpoint } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";

export function EndpointConfiguration() {
  const { currentUser } = useApplicationResources();
  const [endpoints, setEndpoints] = createSignal<ApplicationEndpoint[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [copied, setCopied] = createSignal("", { ownedWrite: true });
  let controller: AbortController | undefined;
  const load = async () => {
    controller?.abort(); const request = new AbortController(); controller = request;
    setLoading(true); setError("");
    try { const value = await loadApplicationEndpoints(request.signal); if (!request.signal.aborted) setEndpoints(value.endpoints); }
    catch (cause) { if (!request.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!request.signal.aborted) setLoading(false); }
  };
  createEffect(() => currentUser()?.subject, () => { setEndpoints([]); setCopied(""); void load(); });
  onCleanup(() => controller?.abort());
  const url = (endpoint: ApplicationEndpoint) => new URL(endpoint.path, window.location.origin).href;
  const copy = async (endpoint: ApplicationEndpoint) => {
    try { await navigator.clipboard.writeText(url(endpoint)); setCopied(endpoint.path); }
    catch { setError("复制失败，请直接选中地址复制"); }
  };
  return <main class="endpoint-configuration"><section class="user-management-card" aria-label="端点说明">
    <Show when={error()}><div class="workspace-error" role="alert">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    <Show when={!loading()} fallback={<div class="user-management-loading"><Skeleton active paragraph={{ rows: 5 }} /></div>}>
      <For each={endpoints()} fallback={<Show when={!error()}><div class="empty-band">暂无可用端点</div></Show>}>{endpoint => <article class="endpoint-description">
        <div class="endpoint-address"><code>{url(endpoint)}</code><Button size="small" onClick={() => { void copy(endpoint); }}>{copied() === endpoint.path ? "已复制" : "复制地址"}</Button></div>
        <p class="endpoint-guidance">{endpoint.transport} · {endpoint.readOnly ? "只读" : "支持创建工单与发送消息"} · 在外部客户端添加此地址，沿用应用入口认证。</p>
        <Show when={!endpoint.readOnly}><p class="endpoint-guidance">先查看服务和用户，再创建工单；用工单编号发送消息、查看状态和回复。客户端用 X-Issue-Pilot-Subject 选择用户，身份校验由入口网关负责。</p></Show>
        <div class="endpoint-tool-list"><For each={endpoint.tools}>{tool => <div class="endpoint-tool"><code>{tool.name}</code><p>{tool.description}</p></div>}</For></div>
      </article>}</For>
    </Show>
  </section></main>;
}
