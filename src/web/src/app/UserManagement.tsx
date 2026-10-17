import { Button, Modal, Select, Skeleton, Toggle, Tag } from "../ui";
import { createSignal, For, Show } from "solid-js";

import { createUser, errorMessage, loadManagedUsers, updateUser, type ManagedUser, type UserRole } from "../data/client";
import { Pencil, UserCheck, UserPlus, UserX } from "../ui/icons";
import { PersonalCredentials } from "./PersonalCredentials";
import { useApplicationResources } from "./ApplicationResources";

const userErrors: Record<string, string> = {
  developer_role_required: "只有开发角色可以管理用户或配置个人凭证",
  invalid_user_role: "请选择产品、测试或开发角色",
  conflict: "用户标识已存在",
  invalid_user_subject: "用户标识格式无效",
  invalid_user_name: "请输入用户姓名",
  invalid_user_email: "邮箱格式无效",
  last_active_developer: "至少保留一名启用的开发用户，以管理角色和个人凭证",
  last_active_user: "至少保留一名启用用户",
  user_not_found: "用户不存在",
};

function message(error: unknown): string {
  const code = errorMessage(error);
  return userErrors[code] ?? code;
}

const userDateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function localDate(value: string): string {
  return userDateFormatter.format(new Date(value));
}

export function UserManagement() {
  const { refreshPeople, currentUser } = useApplicationResources();
  const canManage = () => currentUser()?.role === "developer";
  const [role, setRole] = createSignal<UserRole>("product", { ownedWrite: true });
  const [users, setUsers] = createSignal<ManagedUser[]>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [modalOpen, setModalOpen] = createSignal(false, { ownedWrite: true });
  const [editingSubject, setEditingSubject] = createSignal<string | null>(null, { ownedWrite: true });
  const [subject, setSubject] = createSignal("", { ownedWrite: true });
  const [name, setName] = createSignal("", { ownedWrite: true });
  const [email, setEmail] = createSignal("", { ownedWrite: true });
  const [active, setActive] = createSignal(true, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [changingSubject, setChangingSubject] = createSignal("", { ownedWrite: true });
  let subjectInput!: HTMLInputElement;
  let nameInput!: HTMLInputElement;
  let emailInput!: HTMLInputElement;
  let loadGeneration = 0;

  const load = async () => {
    const generation = ++loadGeneration;
    setLoading(true);
    try {
      const value = await loadManagedUsers();
      if (generation === loadGeneration) {
        setUsers(value);
        setError("");
      }
      return value;
    } catch (loadError) {
      if (generation === loadGeneration) setError(message(loadError));
      throw loadError;
    } finally {
      if (generation === loadGeneration) setLoading(false);
    }
  };

  const openCreate = () => {
    setEditingSubject(null);
    setSubject("");
    setName("");
    setEmail("");
    setActive(true);
    setRole("product");
    setError("");
    setModalOpen(true);
  };

  const openEdit = (user: ManagedUser) => {
    setEditingSubject(user.subject);
    setSubject(user.subject);
    setName(user.name);
    setEmail(user.email);
    setActive(user.active);
    setRole(user.role);
    setError("");
    setModalOpen(true);
  };

  const save = async () => {
    if (saving()) return;
    setSaving(true);
    setError("");
    try {
      const editing = editingSubject();
      const values = { subject: subjectInput.value.trim(), name: nameInput.value.trim(), email: emailInput.value.trim() };
      if (editing) await updateUser(editing, { name: values.name, email: values.email, active: active(), role: role() });
      else await createUser({ ...values, role: role() });
      setModalOpen(false);
      await refreshPeople();
      await load();
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setSaving(false);
    }
  };

  const changeActive = async (user: ManagedUser) => {
    if (changingSubject()) return;
    setChangingSubject(user.subject);
    setError("");
    try {
      await updateUser(user.subject, { name: user.name, email: user.email, active: !user.active, role: user.role });
      await refreshPeople();
      await load();
    } catch (changeError) {
      setError(message(changeError));
    } finally {
      setChangingSubject("");
    }
  };

  void load().catch(() => undefined);

  return (
    <div class="user-management">
      <PersonalCredentials />
      <section class="user-management-card">
        <header class="user-management-header">
          <div><strong>团队成员</strong><span>共 {users().length} 人 · {users().filter((user) => user.active).length} 人启用</span></div>
          <Show when={canManage()}><Button type="primary" icon={<UserPlus size={15} />} onClick={openCreate}>添加用户</Button></Show>
        </header>
        <Show when={error()}>{(value) => <div class="user-management-error" role="alert">{value()}</div>}</Show>
        <Show when={!loading()} fallback={<section class="user-management-loading"><Skeleton active paragraph={{ rows: 8 }} /></section>}>
          <section class="user-table" aria-label="用户列表">
            <div class="user-table-head"><span>用户</span><span>登录标识</span><span>角色</span><span>状态</span><span>最近更新</span><span>操作</span></div>
            <For each={users()} fallback={<div class="empty-band">暂无用户</div>}>{(user) => (
              <div class="user-table-row">
                <div class="user-cell-primary"><span class="user-avatar" aria-hidden="true">{user.name.slice(0, 1)}</span><span class="user-cell-copy"><strong>{user.name}</strong><span>{user.email}</span></span></div>
                <code>{user.subject}</code>
                <div class="user-role-cell"><Tag>{({ product: "产品", test: "测试", developer: "开发" })[user.role]}</Tag></div>
                <div class="user-status-cell"><Tag color={user.active ? "green" : "default"}>{user.active ? "启用" : "停用"}</Tag></div>
                <time>{localDate(user.updatedAt)}</time>
                <Show when={canManage()}><div class="user-row-actions">
                  <Button size="small" icon={<Pencil size={14} />} onClick={() => openEdit(user)}>编辑</Button>
                  <Button size="small" loading={changingSubject() === user.subject} icon={user.active ? <UserX size={14} /> : <UserCheck size={14} />} onClick={() => { void changeActive(user); }}>{user.active ? "停用" : "启用"}</Button>
                </div></Show>
              </div>
            )}</For>
          </section>
        </Show>
      </section>
      <Modal open={modalOpen()} title={editingSubject() ? "编辑用户" : "添加用户"} okText="保存" cancelText="取消" confirmLoading={saving()} onOk={() => { void save(); }} onCancel={() => { if (!saving()) setModalOpen(false); }}>
        <div class="user-form">
          <label><span>用户标识</span><input ref={subjectInput} class="user-input" aria-label="用户标识" value={subject()} disabled={Boolean(editingSubject())} placeholder="name@example.com" onInput={(event) => setSubject(event.currentTarget.value)} /></label>
          <label><span>姓名</span><input ref={nameInput} class="user-input" aria-label="用户姓名" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
          <label><span>邮箱</span><input ref={emailInput} class="user-input" aria-label="用户邮箱" value={email()} inputmode="email" onInput={(event) => setEmail(event.currentTarget.value)} /></label>
          <label><span>角色</span><Select aria-label="用户角色" value={role()} options={[{ value: "product", label: "产品" }, { value: "test", label: "测试" }, { value: "developer", label: "开发" }]} onChange={(value) => setRole(value as UserRole)} /></label>
          <Show when={editingSubject()}><div class="user-active-field"><span>启用</span><Toggle aria-label="用户启用状态" checked={active()} onChange={setActive} /></div></Show>
          <Show when={error()}>{(value) => <div class="form-error" role="alert">{value()}</div>}</Show>
        </div>
      </Modal>
    </div>
  );
}
