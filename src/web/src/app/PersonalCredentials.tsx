import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Button, Skeleton, Tag } from "../ui";
import { errorMessage, loadPersonalCredentials, type PersonalCredentialStatus } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";

export function PersonalCredentials() {
  const { currentUser, configuration } = useApplicationResources();
  const [status, setStatus] = createSignal<PersonalCredentialStatus | null>(null, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0;
  const load = async () => {
    const owner = ++generation; setStatus(null); setError("");
    try { const value = await loadPersonalCredentials(); if (owner === generation) setStatus(value); }
    catch (cause) { if (owner === generation) setError(errorMessage(cause)); }
  };
  createEffect(() => currentUser()?.subject, subject => { generation++; setStatus(null); setError(""); if (subject) void load(); });
  onCleanup(() => { generation++; });
  const configured = (value: boolean | undefined) => <Tag color={value ? "green" : "default"}>{value ? "已配置" : "未配置"}</Tag>;
  const provider = () => configuration().agent.provider || status()?.provider;
  return <Show when={currentUser()}><section class="user-management-card personal-credentials" aria-label="我的凭证">
    <header class="user-management-header"><div><strong>个人凭证</strong><span>{currentUser()?.name} · {currentUser()?.subject}</span></div></header>
    <div class="empty-band">凭证由 user.yaml 管理。这里只展示配置状态，不显示密钥正文。</div>
    <Show when={error()}><div role="alert" class="user-management-error">{error()}<Button size="small" onClick={() => { void load(); }}>重试</Button></div></Show>
    <Show when={status()} fallback={<Show when={!error()}><div class="user-management-loading"><Skeleton active paragraph={{ rows: 5 }} /></div></Show>}>{value => <div class="personal-credential-summary">
      <div><strong>API Key</strong><span>{provider() || "模型服务商"}</span>{configured(Boolean(provider() && value().modelProviders.includes(provider()!)))}</div>
      <div><strong>SSH Key</strong><span>Git SSH 私钥</span>{configured(value().gitSshConfigured)}</div>
      <div><strong>SLS</strong><span>AccessKey ID / AccessKey Secret</span>{configured(value().productionSlsConfigured)}</div>
      <div><strong>DMS</strong><span>连接地址 / Authorization</span>{configured(value().productionDmsConfigured)}</div>
      <div><strong>钉钉</strong><span>MCP API Key</span>{configured(value().dingtalkConfigured)}</div>
    </div>}</Show>
  </section></Show>;
}
