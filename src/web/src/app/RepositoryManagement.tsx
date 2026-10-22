import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Skeleton } from "../ui";
import { errorMessage, loadRepositories, type ManagedRepository } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";

const addressPrefix = (url: string) => url.slice(0, Math.max(url.lastIndexOf("/"), url.includes("://") ? -1 : url.indexOf(":")) + 1);

export function RepositoryManagement() {
  const { currentUser } = useApplicationResources();
  const [rows, setRows] = createSignal<ManagedRepository[]>([], { ownedWrite: true });
  const sortedRows = createMemo(() => [...rows()].sort((left, right) => addressPrefix(left.url).localeCompare(addressPrefix(right.url)) || left.url.localeCompare(right.url)));
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0;
  createEffect(() => currentUser()?.subject, subject => {
    const owner = ++generation;
    setRows([]); setError(""); setLoading(Boolean(subject));
    if (!subject) return;
    void loadRepositories().then(value => { if (owner === generation) setRows(value); })
      .catch(cause => { if (owner === generation) setError(errorMessage(cause)); })
      .finally(() => { if (owner === generation) setLoading(false); });
  });
  onCleanup(() => { generation++; });
  return <section class="user-management-card repository-management" aria-label="仓库管理">
    <header class="user-management-header"><strong>仓库</strong></header>
    <Show when={error()}><div class="user-management-error" role="alert">{error()}</div></Show>
    <Show when={!loading()} fallback={<div class="user-management-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>}>
      <Show when={!error()}><div class="repository-catalog-table"><div class="repository-catalog-head"><span>名称</span><span>地址</span></div>
        <For each={sortedRows()} fallback={<div class="empty-band">暂无仓库</div>}>{row => <div class="repository-catalog-row"><strong>{row.name}</strong><code title={row.url}>{row.url}</code></div>}</For>
      </div></Show>
    </Show>
  </section>;
}
