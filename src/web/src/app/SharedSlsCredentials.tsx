import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Button, Modal, PasswordInput, Skeleton, Tag } from "../ui";
import { loadSharedSlsCredentials, updateSharedSlsCredentials, type SharedSlsCredentialStatus } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

export function SharedSlsCredentials() {
  const { currentUser } = useApplicationResources();
  const [status, setStatus] = createSignal<SharedSlsCredentialStatus | null>(null, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [accessKeyId, setAccessKeyId] = createSignal("", { ownedWrite: true });
  const [secret, setSecret] = createSignal("", { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  let generation = 0;
  const close = () => { setOpen(false); setAccessKeyId(""); setSecret(""); setSaveError(""); setConflict(false); };
  const load = async () => {
    const owner = ++generation; setStatus(null); setError("");
    try { const value = await loadSharedSlsCredentials(); if (owner === generation) setStatus(value); }
    catch (cause) { if (owner === generation) setError(settingsError(cause)); }
  };
  createEffect(() => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, identity => {
    generation++; close(); setStatus(null); setError(""); setSaving(false);
    if (identity.endsWith(":developer")) void load();
  });
  onCleanup(() => { generation++; });
  const save = async (clear = false) => {
    const current = status(); if (!current || saving()) return;
    if (!clear && !accessKeyId() && !secret() && current.configured) { close(); return; }
    if (!clear && (!accessKeyId().trim() || !secret().trim())) { setSaveError("请填写完整凭据"); return; }
    const owner = generation;
    setSaving(true); setSaveError("");
    try {
      const value = await updateSharedSlsCredentials(clear
        ? { expectedRevision: current.revision, mode: "clear" }
        : { expectedRevision: current.revision, mode: "replace", accessKeyId: accessKeyId(), accessKeySecret: secret() });
      if (owner === generation) { setStatus(value); close(); }
    } catch (cause) {
      if (owner === generation) { setSaveError(settingsError(cause)); setConflict(cause instanceof Error && cause.message === "configuration_changed"); }
    } finally { if (owner === generation) setSaving(false); }
  };
  return <Show when={currentUser()?.role === "developer"}>
    <section class="user-management-card shared-sls-credentials" aria-label="共享 SLS 凭据">
      <header class="user-management-header">
        <div><strong>共享 SLS 凭据</strong><span>个人未配置时使用，适用于正式和测试环境</span></div>
        <Show when={status()} fallback={<Show when={!error()}><Skeleton active paragraph={{ rows: 1 }} /></Show>}>
          <span class="settings-row-actions"><Tag color={status()?.configured ? "green" : "default"}>{status()?.configured ? "已配置" : "未配置"}</Tag><Button size="small" disabled={saving()} onClick={() => { close(); setOpen(true); }}>{status()?.configured ? "更新凭据" : "设置凭据"}</Button></span>
        </Show>
      </header>
      <Show when={error()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    </section>
    <Modal width={460} open={open()} title="共享 SLS 凭据" okText="保存" confirmLoading={saving()} onCancel={close} onOk={() => { void save(); }}>
      <div class="settings-form">
        <Show when={saveError()}><div role="alert" class="user-management-error">{saveError()}<Show when={conflict()}><Button size="small" onClick={() => { close(); void load(); }}>重新加载</Button></Show></div></Show>
        <label><span>AccessKey ID</span><PasswordInput aria-label="共享 SLS AccessKey ID" value={accessKeyId()} placeholder={status()?.configured ? "留空保留原值" : ""} onInput={event => setAccessKeyId(event.currentTarget.value)} /></label>
        <label><span>AccessKey Secret</span><PasswordInput aria-label="共享 SLS AccessKey Secret" value={secret()} placeholder={status()?.configured ? "留空保留原值" : ""} onInput={event => setSecret(event.currentTarget.value)} /></label>
        <Show when={status()?.configured}><Button danger type="text" size="small" disabled={saving()} onClick={() => { void save(true); }}>清除凭据</Button></Show>
      </div>
    </Modal>
  </Show>;
}
