import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Input, Modal } from "../ui";
import { currentUserSubject, errorMessage, searchIssues, type IssueSearchHit } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";

const errors: Record<string, string> = {
  issue_search_index_required: "工单索引尚未准备好，请联系管理员更新索引。",
  issue_search_disabled: "工单搜索已关闭。",
  issue_search_busy: "工单搜索繁忙，请稍后再试。",
  issue_search_cloudflare_access_denied: "Cloudflare 拒绝了请求，请联系管理员检查配置。",
  issue_search_cloudflare_rate_limited: "Cloudflare 暂时限制了请求，请稍后再试。",
  issue_search_cloudflare_timed_out: "搜索请求超时，请重试。",
};

export function IssueSearchDialog(props: { onOpenIssue: (key: string) => boolean }) {
  const { catalog, currentUser } = useApplicationResources();
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<IssueSearchHit[]>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  let request: AbortController | undefined;
  const enabled = () => catalog().issueSearchEnabled && currentUser();
  const cancel = () => {
    request?.abort();
    request = undefined;
    setPending(false);
  };
  const close = () => {
    cancel();
    setOpen(false);
    setHits(undefined);
    setQuery("");
    setError("");
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyK" || event.defaultPrevented || event.repeat || event.isComposing || !enabled()) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    setOpen(true);
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    request?.abort();
  });
  createEffect(
    () => enabled()?.subject,
    (subject, previous) => {
      if (previous && subject !== previous) close();
    },
  );
  const submit = async () => {
    const subject = enabled()?.subject;
    const value = query().trim();
    if (!subject || !value || pending()) return;
    const controller = new AbortController();
    request = controller;
    const current = () => request === controller && !controller.signal.aborted && currentUserSubject() === subject && enabled()?.subject === subject;
    setPending(true);
    setHits(undefined);
    setError("");
    try {
      const found = await searchIssues(value, controller.signal);
      if (current()) setHits(found);
    } catch (cause) {
      if (current()) setError(errors[errorMessage(cause)] ?? "工单搜索失败，请稍后再试。");
    } finally {
      if (current()) {
        request = undefined;
        setPending(false);
      }
    }
  };
  return (
    <Modal open={Boolean(enabled() && open())} title="搜索所有工单" footer={<small>Enter 搜索 · Esc 关闭</small>} onOk={() => void submit()} onCancel={close}>
      <Input
        aria-label="工单搜索词"
        placeholder="描述你遇到的问题"
        value={query()}
        maxlength={500}
        onInput={(event) => {
          cancel();
          setQuery(event.currentTarget.value);
          setHits(undefined);
          setError("");
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          void submit();
        }}
      />
      <Show when={pending()}>
        <p role="status">正在搜索…</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={hits()}>
        {(items) => (
          <Show when={items().length} fallback={<p role="status">没有找到相关工单。</p>}>
            <ul class="issue-search-results" aria-label="工单搜索结果">
              <For each={items()}>
                {(issue) => (
                  <li>
                    <a
                      href={`/?issue=${encodeURIComponent(issue.key)}`}
                      onClick={(event) => {
                        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        if (props.onOpenIssue(issue.key)) close();
                      }}
                    >
                      {issue.title}
                    </a>
                    <span>
                      {" "}
                      · {issue.key} · {issue.status === "resolved" ? "已解决" : "未解决"}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </Modal>
  );
}
