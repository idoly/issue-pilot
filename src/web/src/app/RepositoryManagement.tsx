import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, Modal, Skeleton, Tag } from "../ui";
import { createRepository, deleteRepository, errorMessage, loadRepositories, updateRepository, type ManagedRepository } from "../data/client";
import { Pencil, Plus, Trash2 } from "../ui/icons";
import { useApplicationResources } from "./ApplicationResources";

const errors: Record<string, string> = {
  conflict: "仓库地址已登记，请选择已有仓库",
  invalid_repository_name: "请填写仓库名称",
  invalid_repository_url: "请填写有效的 SSH 或 HTTPS 仓库地址，地址中不能包含密码、Token 或查询参数",
  repository_is_used_by_services: "仓库仍被服务引用，请先在服务配置中移除引用",
  repository_not_found: "仓库不存在，请刷新列表",
  issue_already_running: "引用此仓库的服务有工单正在执行，请结束后再修改",
  developer_role_required: "只有开发角色可以维护仓库",
};
const message = (error: unknown) => errors[errorMessage(error)] ?? errorMessage(error);

const addressPrefix = (url: string) => url.slice(0, Math.max(url.lastIndexOf("/"), url.includes("://") ? -1 : url.indexOf(":")) + 1);

export function RepositoryManagement() {
  const { currentUser, configuration, refreshConfiguration, refreshCatalog } = useApplicationResources();
  const canManage = () => currentUser()?.role === "developer" && !configuration?.().fileManaged?.services;
  const [rows, setRows] = createSignal<ManagedRepository[]>([], { ownedWrite: true });
  const sortedRows = createMemo(() => [...rows()].sort((left, right) => addressPrefix(left.url).localeCompare(addressPrefix(right.url)) || left.url.localeCompare(right.url)));
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [editing, setEditing] = createSignal<string | null>(null, { ownedWrite: true });
  const [name, setName] = createSignal("", { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [deleting, setDeleting] = createSignal<ManagedRepository | null>(null, { ownedWrite: true });
  let generation = 0, loadGeneration = 0;
  onCleanup(() => { generation++; loadGeneration++; });
  const load = async () => {
    const owner = generation, request = ++loadGeneration;
    setLoading(true);
    try {
      const value = await loadRepositories();
      if (owner === generation && request === loadGeneration) { setRows(value); setError(""); }
    } catch (cause) {
      if (owner === generation && request === loadGeneration) setError(message(cause));
    } finally {
      if (owner === generation && request === loadGeneration) setLoading(false);
    }
  };
  createEffect(() => ({ subject: currentUser()?.subject, role: currentUser()?.role }), (identity, previous) => {
    if (identity.subject === previous?.subject && identity.role === previous?.role) return;
    generation += 1; setOpen(false); setDeleting(null); setSaving(false); setError("");
    if (identity.subject) void load();
    else { setRows([]); setLoading(false); }
  });
  const edit = (row?: ManagedRepository) => { setEditing(row?.id ?? null); setName(row?.name ?? ""); setUrl(row?.url ?? ""); setError(""); setOpen(true); };
  const save = async () => {
    if (saving() || !name().trim() || !url().trim()) return;
    const current = generation;
    setSaving(true); setError("");
    try {
      const input = { name: name().trim(), url: url().trim() };
      if (editing()) await updateRepository(editing()!, input); else await createRepository(input);
      if (current !== generation) return;
      setOpen(false); await Promise.all([load(), refreshConfiguration(), refreshCatalog()]);
    } catch (cause) { if (current === generation) setError(message(cause)); }
    finally { if (current === generation) setSaving(false); }
  };
  const remove = async () => {
    const row = deleting(); if (!row || saving()) return;
    const current = generation;
    setSaving(true); setError("");
    try { await deleteRepository(row.id); if (current !== generation) return; setDeleting(null); await load(); }
    catch (cause) { if (current === generation) setError(message(cause)); }
    finally { if (current === generation) setSaving(false); }
  };
  return <section class="user-management-card repository-management" aria-label="仓库管理">
    <Show when={configuration?.().fileManaged?.services}><div class="empty-band">仓库由 service.yaml 管理；修改后重启生效。</div></Show>
    <header class="user-management-header"><div><strong>仓库</strong><span>统一维护仓库地址，服务选择引用 · 共 {rows().length} 个</span></div><Button type="primary" icon={<Plus size={14} />} disabled={!canManage()} title={canManage() ? "添加仓库" : "仅开发角色可维护仓库"} onClick={() => edit()}>添加仓库</Button></header>
    <Show when={error() && !open() && !deleting()}><div class="user-management-error" role="alert">{error()}</div></Show>
    <Show when={!loading()} fallback={<div class="user-management-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>}>
      <div class="repository-catalog-table"><div class="repository-catalog-head"><span>名称</span><span>地址</span><span>引用服务</span><span>操作</span></div>
        <For each={sortedRows()} fallback={<div class="empty-band">暂无仓库，先添加仓库再在服务中选择</div>}>{(row) => <div class="repository-catalog-row"><strong>{row.name}</strong><code>{row.url}</code><div class="repository-service-tags"><For each={row.services} fallback={<span class="muted">未引用</span>}>{(service) => <Tag>{service.name}</Tag>}</For></div><div class="user-row-actions repository-actions"><Button size="small" icon={<Pencil size={13} />} disabled={!canManage()} title={canManage() ? "编辑仓库" : "仅开发角色可维护仓库"} onClick={() => edit(row)}>编辑</Button><Button size="small" icon={<Trash2 size={13} />} disabled={!canManage() || Boolean(row.services.length)} title={!canManage() ? "仅开发角色可维护仓库" : row.services.length ? "请先从服务配置移除引用" : "删除仓库"} onClick={() => { setError(""); setDeleting(row); }}>删除</Button></div></div>}</For>
      </div>
    </Show>
    <Modal open={open()} title={editing() ? "编辑仓库" : "添加仓库"} okText="保存" confirmLoading={saving()} okButtonProps={{ disabled: !name().trim() || !url().trim() }} onOk={() => { void save(); }} onCancel={() => setOpen(false)}>
      <div class="user-form"><label><span>名称</span><Input aria-label="统一仓库名称" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label><label><span>仓库地址</span><Input aria-label="统一仓库地址" placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} /></label><Show when={editing()}><p class="muted">修改地址会更新所有服务的引用；已有工单的仓库和分支历史保留。</p></Show><Show when={error()}><div class="form-error" role="alert">{error()}</div></Show></div>
    </Modal>
    <Modal open={Boolean(deleting())} title="删除仓库" okText="确认删除" confirmLoading={saving()} okButtonProps={{ danger: true }} onOk={() => { void remove(); }} onCancel={() => setDeleting(null)}><p>删除仓库 {deleting()?.name}？</p><Show when={error()}><div class="workspace-error" role="alert">{error()}</div></Show></Modal>
  </section>;
}
