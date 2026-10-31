import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { issuePilotConfig } from "../../../../issue-pilot.config";
import { Button, Input, Modal, PasswordInput, Skeleton, Tag } from "../ui";
import { loadSharedDmsCredentials, loadSharedSlsCredentials, updateSharedDmsCredentials, updateSharedSlsCredentials, type CapabilityName, type SharedDmsCredentialStatus, type SharedSlsCredentialStatus } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

type SharedStatus = SharedDmsCredentialStatus | SharedSlsCredentialStatus;
const dmsUrl = (value: SharedStatus | null) => value && "url" in value ? value.url : "";

export function SharedCredentials(props: { capability: CapabilityName }) {
  const { currentUser } = useApplicationResources();
  const isDms = props.capability === "dms";
  const title = `共享 ${props.capability.toUpperCase()} 凭据`;
  const [status, setStatus] = createSignal<SharedStatus | null>(null, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [account, setAccount] = createSignal("", { ownedWrite: true });
  const [secret, setSecret] = createSignal("", { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  let generation = 0;
  const close = () => { setOpen(false); setAccount(""); setSecret(""); setSaveError(""); setConflict(false); };
  const load = async () => {
    const owner = ++generation; setStatus(null); setError("");
    try { const value = await (isDms ? loadSharedDmsCredentials() : loadSharedSlsCredentials()); if (owner === generation) setStatus(value); }
    catch (cause) { if (owner === generation) setError(settingsError(cause)); }
  };
  createEffect(() => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, identity => {
    generation++; close(); setStatus(null); setError(""); setSaving(false);
    if (identity.endsWith(":developer")) void load();
  });
  onCleanup(() => { generation++; });
  const save = async (clear = false) => {
    const current = status(); if (!current || saving()) return;
    if (!clear && !secret() && current.configured && (isDms ? account().trim() === dmsUrl(current) : !account())) { close(); return; }
    if (!clear && (!account().trim() || !secret().trim())) { setSaveError(isDms ? "请填写完整凭据；更换地址时需同时填写 Authorization" : "请填写完整凭据"); return; }
    const owner = generation;
    setSaving(true); setSaveError("");
    try {
      const common = { expectedRevision: current.revision };
      const value = isDms
        ? await updateSharedDmsCredentials(clear ? { ...common, mode: "clear" } : { ...common, mode: "replace", url: account().trim(), authorization: secret() })
        : await updateSharedSlsCredentials(clear ? { ...common, mode: "clear" } : { ...common, mode: "replace", accessKeyId: account(), accessKeySecret: secret() });
      if (owner === generation) { setStatus(value); close(); }
    } catch (cause) {
      if (owner === generation) { setSaveError(settingsError(cause)); setConflict(cause instanceof Error && cause.message === "configuration_changed"); }
    } finally { if (owner === generation) setSaving(false); }
  };
  return <Show when={currentUser()?.role === "developer"}>
    <section class="user-management-card shared-credentials" aria-label={title}>
      <header class="user-management-header">
        <div><strong>{title}</strong><span>个人未配置时使用，适用于正式和测试环境</span></div>
        <Show when={status()} fallback={<Show when={!error()}><Skeleton active paragraph={{ rows: 1 }} /></Show>}>
          <span class="settings-row-actions"><Tag color={status()?.configured ? "green" : "default"}>{status()?.configured ? "已配置" : "未配置"}</Tag><Button size="small" disabled={saving()} onClick={() => { close(); setAccount(isDms ? dmsUrl(status()) || issuePilotConfig.defaults.dms.sseUrl : ""); setOpen(true); }}>{status()?.configured ? "更新凭据" : "设置凭据"}</Button></span>
        </Show>
      </header>
      <Show when={error()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    </section>
    <Modal width={460} open={open()} title={title} okText="保存" confirmLoading={saving()} onCancel={close} onOk={() => { void save(); }}>
      <div class="settings-form">
        <Show when={saveError()}><div role="alert" class="user-management-error">{saveError()}<Show when={conflict()}><Button size="small" onClick={() => { close(); void load(); }}>重新加载</Button></Show></div></Show>
        <label><span>{isDms ? "DMS 地址" : "AccessKey ID"}</span><Show when={isDms} fallback={<PasswordInput aria-label="共享 SLS AccessKey ID" value={account()} placeholder={status()?.configured ? "留空保留原值" : ""} onInput={event => setAccount(event.currentTarget.value)} />}><Input aria-label="共享 DMS 地址" value={account()} onInput={event => setAccount(event.currentTarget.value)} /></Show></label>
        <label><span>{isDms ? "Authorization" : "AccessKey Secret"}</span><PasswordInput aria-label={isDms ? "共享 DMS Authorization" : "共享 SLS AccessKey Secret"} value={secret()} placeholder={status()?.configured ? "留空保留原值" : isDms ? "Bearer token" : ""} onInput={event => setSecret(event.currentTarget.value)} /></label>
        <Show when={status()?.configured}><Button danger type="text" size="small" disabled={saving()} onClick={() => { void save(true); }}>清除凭据</Button></Show>
      </div>
    </Modal>
  </Show>;
}
