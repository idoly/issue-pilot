import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, PasswordInput, Modal, Skeleton, Tag, TextArea } from "../ui";
import { loadPersonalCredentials, updatePersonalCredentials, type PersonalCredentialStatus, type PersonalCredentialUpdate } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

type Group = "model" | "git" | "dms" | "sls";
const groups: Array<{ key: Group; label: string }> = [{ key: "model", label: "API Key" }, { key: "git", label: "SSH Key" }, { key: "dms", label: "DMS" }, { key: "sls", label: "SLS" }];

export function PersonalCredentials() {
  const { currentUser, configuration } = useApplicationResources();
  const [status, setStatus] = createSignal<PersonalCredentialStatus | null>(null, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [selected, setSelected] = createSignal<Group | null>(null, { ownedWrite: true });
  const [secret, setSecret] = createSignal("", { ownedWrite: true });
  const [accessKeyId, setAccessKeyId] = createSignal("", { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  let generation = 0, providerDraft = "";
  const provider = () => configuration().agent.provider || status()?.provider;
  const configured = (group: Group) => group === "model" ? Boolean(provider() && status()?.modelProviders.includes(provider()!)) : group === "git" ? status()?.gitSshConfigured === true : group === "dms" ? status()?.productionDmsConfigured === true : status()?.productionSlsConfigured === true;
  const close = () => { setSelected(null); setSecret(""); setAccessKeyId(""); setUrl(""); setSaveError(""); setConflict(false); };
  const load = async () => {
    const owner = ++generation; setStatus(null); setError("");
    try { const value = await loadPersonalCredentials(); if (owner === generation) setStatus(value); }
    catch (cause) { if (owner === generation) setError(settingsError(cause)); }
  };
  createEffect(() => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, (identity, previous) => { if (identity === previous) return; generation++; close(); setSaving(false); setStatus(null); setError(""); if (identity.split(":")[0]) void load(); });
  onCleanup(() => { generation++; });
  const open = (group: Group) => { close(); providerDraft = provider() ?? ""; setUrl(group === "dms" ? status()?.productionDmsUrl ?? "" : ""); setSelected(group); };
  const save = async (clear = false) => {
    const group = selected(), credentials = status(); if (!group || !credentials || saving()) return;
    const owner = generation;
    const supplied = Boolean(secret() || accessKeyId());
    if (!clear && !supplied) {
      if (configured(group) && (group !== "dms" || url().trim() === status()?.productionDmsUrl)) { close(); return; }
      setSaveError(group === "dms" && configured(group) ? "更换地址时请填写 Authorization" : "请填写凭证"); return;
    }
    if (!clear && (!secret().trim() || group === "sls" && !accessKeyId().trim() || group === "dms" && !url().trim())) { setSaveError("请填写完整凭证"); return; }
    const input: PersonalCredentialUpdate = { expectedRevision: credentials.revision };
    if (group === "model") input.model = clear ? { mode: "clear", provider: providerDraft } : { mode: "replace", provider: providerDraft, apiKey: secret() };
    if (group === "git") input.git = clear ? { mode: "clear" } : { mode: "replace", type: "ssh", privateKey: secret() };
    if (group === "dms") input.production = { dms: clear ? { mode: "clear" } : { mode: "replace", url: url().trim(), authorization: secret() } };
    if (group === "sls") input.production = { sls: clear ? { mode: "clear" } : { mode: "replace", accessKeyId: accessKeyId(), accessKeySecret: secret() } };
    setSaving(true); setSaveError("");
    try { const value = await updatePersonalCredentials(input); if (owner === generation) { setStatus(value); close(); } }
    catch (cause) { if (owner === generation) { setSaveError(settingsError(cause)); setConflict(cause instanceof Error && cause.message === "configuration_changed"); } }
    finally { if (owner === generation) setSaving(false); }
  };
  return <Show when={currentUser()}><section class="user-management-card personal-credentials" aria-label="我的凭证">
    <header class="user-management-header"><div><strong>我的凭证</strong><span>{currentUser()?.name} · {currentUser()?.subject}</span></div></header>
    <Show when={error()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    <Show when={status()} fallback={<Show when={!error()}><div class="user-management-loading"><Skeleton active paragraph={{ rows: 4 }} /></div></Show>}>
      <div class="personal-credential-summary"><For each={groups}>{group => <div><strong>{group.label}</strong><Tag color={configured(group.key) ? "green" : "default"}>{configured(group.key) ? "已配置" : "未配置"}</Tag><Button size="small" disabled={saving() || (group.key === "model" || group.key === "git") && currentUser()?.role !== "developer"} onClick={() => open(group.key)}>{configured(group.key) ? "更新凭证" : "设置凭证"}</Button></div>}</For></div>
    </Show>
    <Modal width={460} open={selected() !== null} title={`${selected() && configured(selected()!) ? "更新" : "设置"} ${groups.find(group => group.key === selected())?.label ?? ""}`} okText="保存" cancelText="取消" confirmLoading={saving()} onCancel={close} onOk={() => { void save(); }}>
      <div class="settings-form"><Show when={saveError()}><div role="alert" class="user-management-error">{saveError()}<Show when={conflict()}><Button size="small" onClick={() => { close(); void load(); }}>重新加载</Button></Show></div></Show>
        <Show when={selected() === "dms"}><label><span>DMS 地址</span><Input aria-label="DMS 地址" value={url()} onInput={event => setUrl(event.currentTarget.value)} /></label></Show>
        <Show when={selected() === "sls"}><label><span>AccessKey ID</span><PasswordInput aria-label="AccessKey ID" value={accessKeyId()} placeholder="留空保留原值" onInput={event => setAccessKeyId(event.currentTarget.value)} /></label></Show>
        <label><span>{selected() === "model" ? "API Key" : selected() === "git" ? "SSH 私钥" : selected() === "dms" ? "Authorization" : "AccessKey Secret"}</span><Show when={selected() === "git"} fallback={<PasswordInput aria-label="新凭证" value={secret()} placeholder={selected() && configured(selected()!) ? "留空保留原值" : ""} onInput={event => setSecret(event.currentTarget.value)} />}><TextArea aria-label="SSH 私钥" value={secret()} placeholder="留空保留原值" onInput={event => setSecret(event.currentTarget.value)} autoSize={{ minRows: 5, maxRows: 10 }} /></Show></label>
        <Show when={selected() && configured(selected()!)}><Button danger type="text" size="small" disabled={saving()} onClick={() => { void save(true); }}>清除凭证</Button></Show>
      </div>
    </Modal>
  </section></Show>;
}
