import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, Modal, Select, Skeleton, Tag } from "../ui";
import { createUser, loadManagedUsers, updateUser, USER_ROLES, type ManagedUser, type UserRole } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

const roleNames: Record<UserRole, string> = { product: "产品", test: "测试", developer: "开发" };
export function UserManagement() {
  const { currentUser, refreshPeople } = useApplicationResources();
  const [rows, setRows] = createSignal<ManagedUser[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [includeInactive, setIncludeInactive] = createSignal(false, { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [editing, setEditing] = createSignal<ManagedUser | null>(null, { ownedWrite: true });
  const [name, setName] = createSignal("", { ownedWrite: true });
  const [email, setEmail] = createSignal("", { ownedWrite: true });
  const [role, setRole] = createSignal<UserRole>("product", { ownedWrite: true });
  const [admin, setAdmin] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  let generation = 0, loadGeneration = 0;
  const canEdit = (user?: ManagedUser) => currentUser()?.role === "developer" && (!user?.isAdmin || currentUser()?.isAdmin === true);
  const visible = createMemo(() => rows().filter(user => (includeInactive() || user.active) && `${user.name} ${user.email} ${user.subject}`.toLowerCase().includes(query().trim().toLowerCase())));
  const close = () => { setOpen(false); setEditing(null); setName(""); setEmail(""); setSaveError(""); setConflict(false); };
  const load = async () => {
    const owner = generation, request = ++loadGeneration; setLoading(true); setError("");
    try { const value = await loadManagedUsers(); if (owner === generation && request === loadGeneration) setRows(value); }
    catch (cause) { if (owner === generation && request === loadGeneration) setError(settingsError(cause)); }
    finally { if (owner === generation && request === loadGeneration) setLoading(false); }
  };
  createEffect(() => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}:${currentUser()?.isAdmin ?? false}`, (identity, previous) => { if (identity === previous) return; generation++; close(); setSaving(false); setRows([]); setQuery(""); setIncludeInactive(false); if (identity.split(":")[0]) void load(); });
  onCleanup(() => { generation++; });
  const edit = (user?: ManagedUser) => { if (!canEdit(user)) return; setEditing(user ?? null); setName(user?.name ?? ""); setEmail(user?.email ?? ""); setRole(user?.role ?? "product"); setAdmin(user?.isAdmin ?? false); setSaveError(""); setOpen(true); };
  const refresh = async (owner: number) => {
    if (owner !== generation) return;
    const results = await Promise.allSettled([load(), refreshPeople()]);
    if (owner !== generation) return;
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") setError(settingsError(failure.reason));
  };
  const save = async () => {
    if (saving() || !canEdit(editing() ?? undefined)) return;
    if (!name().trim() || !email().trim()) { setSaveError("请填写姓名和邮箱"); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email().trim())) { setSaveError("请填写有效的邮箱地址"); return; }
    const owner = generation, target = editing();
    const input = { name: name().trim(), email: email().trim(), role: role(), ...(currentUser()?.isAdmin ? { isAdmin: admin() } : {}) };
    setSaving(true); setSaveError("");
    try {
      if (target) await updateUser(target.subject, { ...input, expectedRevision: target.revision });
      else await createUser({ subject: email().trim().toLowerCase(), ...input });
      if (owner === generation) close();
      await refresh(owner);
    } catch (cause) { if (owner === generation) { if (open()) { setSaveError(settingsError(cause)); setConflict(cause instanceof Error && cause.message === "configuration_changed"); } else setError(settingsError(cause)); } }
    finally { if (owner === generation) setSaving(false); }
  };
  const toggle = async (user: ManagedUser) => {
    if (saving() || !canEdit(user)) return;
    const owner = generation; setSaving(true); setError("");
    try { await updateUser(user.subject, { active: !user.active, expectedRevision: user.revision }); await refresh(owner); }
    catch (cause) { if (owner === generation) setError(settingsError(cause)); }
    finally { if (owner === generation) setSaving(false); }
  };
  return <section class="user-management-card settings-members" aria-label="人员管理">
    <header class="user-management-header"><strong>人员</strong><Show when={currentUser()?.role === "developer"}><Button type="primary" size="small" disabled={saving()} onClick={() => edit()}>添加人员</Button></Show></header>
    <div class="settings-list-toolbar"><Input aria-label="搜索人员" value={query()} placeholder="搜索姓名或邮箱" onInput={event => setQuery(event.currentTarget.value)} /><label><input type="checkbox" checked={includeInactive()} onChange={event => setIncludeInactive(event.currentTarget.checked)} />显示停用人员</label></div>
    <Show when={error()}><div class="user-management-error" role="alert">{error()}<Button size="small" onClick={() => { void refresh(generation); }}>重试</Button></div></Show>
    <Show when={!loading()} fallback={<div class="user-management-loading"><Skeleton active paragraph={{ rows: 4 }} /></div>}><div class="settings-table-scroll"><table class="settings-table users-management-table"><thead><tr><th>成员</th><th>角色</th><th>管理权限</th><th>状态</th><th></th></tr></thead><tbody><For each={visible()} fallback={<tr><td colspan={5}>没有匹配人员</td></tr>}>{user => <tr class={user.active ? "" : "settings-inactive"}><td><strong>{user.name}</strong><small>{user.email || user.subject}</small></td><td>{roleNames[user.role]}</td><td>{user.isAdmin ? "管理" : "—"}</td><td><Tag color={user.active ? "green" : "default"}>{user.active ? "在用" : "已停用"}</Tag></td><td><Show when={canEdit(user)}><div class="settings-row-actions"><Button type="text" size="small" disabled={saving()} onClick={() => edit(user)}>编辑</Button><Button type="text" size="small" danger={user.active} disabled={saving()} onClick={() => { void toggle(user); }}>{user.active ? "停用" : "启用"}</Button></div></Show></td></tr>}</For></tbody></table></div></Show>
    <Modal width={520} open={open()} title={editing() ? "编辑人员" : "添加人员"} okText="保存" cancelText="取消" confirmLoading={saving()} onCancel={close} onOk={() => { void save(); }}><div class="settings-form"><Show when={saveError()}><div class="user-management-error" role="alert">{saveError()}<Show when={conflict()}><Button size="small" onClick={() => { close(); void load(); }}>重新加载</Button></Show></div></Show><label><span>姓名</span><Input aria-label="人员姓名" value={name()} onInput={event => setName(event.currentTarget.value)} /></label><label><span>邮箱</span><Input aria-label="人员邮箱" type="email" value={email()} onInput={event => setEmail(event.currentTarget.value)} /></label><label><span>角色</span><Select aria-label="人员角色" value={role()} options={USER_ROLES.map(value => ({ value, label: roleNames[value] }))} onChange={value => { if (typeof value === "string" && USER_ROLES.includes(value as UserRole)) setRole(value as UserRole); }} /></label><Show when={currentUser()?.isAdmin}><label class="settings-checkbox"><input type="checkbox" checked={admin()} onChange={event => setAdmin(event.currentTarget.checked)} />管理权限</label></Show></div></Modal>
  </section>;
}
