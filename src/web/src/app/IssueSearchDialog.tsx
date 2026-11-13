import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Badge, Input, Modal } from "../ui";
import { Search } from "../ui/icons";
import { currentUserSubject, errorMessage, searchIssues, type IssueSearchHit } from "../data/client";
import { createLatestTask } from "../data/latest";
import { useApplicationResources } from "./ApplicationResources";
import { statusBadge, statusLabel } from "./model";

const errors: Record<string, string> = {
  issue_search_index_required: "工单索引尚未准备好，请联系管理员更新索引。",
  issue_search_disabled: "工单搜索已关闭。",
  issue_search_busy: "工单搜索繁忙，请稍后再试。",
  issue_search_cloudflare_access_denied: "Cloudflare 拒绝了请求，请联系管理员检查配置。",
  issue_search_cloudflare_rate_limited: "Cloudflare 暂时限制了请求，请稍后再试。",
  issue_search_cloudflare_timed_out: "语义搜索响应超时，已保留搜索词。按 Enter 可重试。",
  issue_search_cloudflare_failed: "语义搜索服务暂时不可用，按 Enter 可重试。",
};

export function IssueSearchDialog(props: { onOpenIssue: (key: string) => boolean }) {
  const { catalog, currentUser } = useApplicationResources();
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<IssueSearchHit[]>();
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const latest = createLatestTask();
  const enabled = () => catalog().issueSearchEnabled && currentUser();
  const cancel = () => {
    latest.cancel();
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
    latest.cancel();
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
    if (!subject || !value || pending() || hits()) return;
    const task = latest.begin();
    const current = () => task.isCurrent() && !task.signal.aborted && currentUserSubject() === subject && enabled()?.subject === subject;
    setPending(true);
    setHits(undefined);
    setError("");
    try {
      const found = await searchIssues(value, task.signal);
      if (current()) setHits(found);
    } catch (cause) {
      if (current()) setError(errors[errorMessage(cause)] ?? "工单搜索失败，请稍后再试。");
    } finally {
      if (current()) setPending(false);
      task.finish();
    }
  };
  const onSearchKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const target = event.target;
    if (target instanceof HTMLInputElement && event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href]"));
    const down = event.key === "ArrowDown";
    if (target instanceof HTMLInputElement) {
      const next = down ? links[0] : links.at(-1);
      if (!next) return;
      event.preventDefault();
      next.focus();
    } else if (target instanceof HTMLAnchorElement) {
      const index = links.indexOf(target);
      if (index < 0) return;
      event.preventDefault();
      const next = !down && index === 0 ? event.currentTarget.querySelector("input") : links[index + (down ? 1 : -1)];
      next?.focus();
    }
  };
  return (
    <Modal
      open={Boolean(enabled() && open())}
      title="查找相似工单"
      width={620}
      footer={<small class="issue-search-shortcuts">{hits()?.length ? "↑/↓ 浏览结果 · Enter 打开 · Esc 关闭" : "Enter 搜索 · Esc 关闭"}</small>}
      onOk={() => void submit()}
      onCancel={close}
    >
      <div onKeyDown={onSearchKeyDown}>
        <Input
          aria-label="工单搜索词"
          placeholder="例如：审批提交后一直转圈"
          prefix={<Search size={16} />}
          allowClear
          value={query()}
          maxlength={500}
          onInput={(event) => {
            cancel();
            setQuery(event.currentTarget.value);
            setHits(undefined);
            setError("");
          }}
        />
        <Show when={pending()}>
          <p class="issue-search-feedback" role="status">
            <span class="ui-spinner" aria-hidden="true" /> 正在搜索，按 Esc 可取消。
          </p>
        </Show>
        <Show when={error()}>
          <p class="issue-search-feedback issue-search-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={!pending() && !error() && !hits()}>
          <p class="issue-search-feedback">可输入问题现象、报错或复现条件，按 Enter 搜索。</p>
        </Show>
        <Show when={hits()}>
          {(items) => (
            <Show
              when={items().length}
              fallback={
                <p class="issue-search-feedback" role="status">
                  没有找到相关工单。试试换一种描述。
                </p>
              }
            >
              <p class="issue-search-feedback" role="status">
                显示 {items().length} 条相关工单
              </p>
              <ul class="issue-search-results" aria-label="工单搜索结果">
                <For each={items()}>
                  {(issue) => (
                    <li>
                      <a
                        aria-label={issue.title}
                        aria-describedby={`issue-search-meta-${issue.key}`}
                        href={`/?issue=${encodeURIComponent(issue.key)}`}
                        onClick={(event) => {
                          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          if (props.onOpenIssue(issue.key)) close();
                        }}
                      >
                        <span class="issue-search-title">{issue.title}</span>
                        <span id={`issue-search-meta-${issue.key}`} class="issue-search-meta">
                          <span>处理人：{issue.assignee ?? "未分配"}</span>
                          <Badge status={statusBadge[issue.status]} text={statusLabel[issue.status]} />
                          <span>{issue.key}</span>
                        </span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </div>
    </Modal>
  );
}
