import { Button, Input, PasswordInput } from "../ui";
import { createEffect, createSignal, Show } from "solid-js";
import { errorMessage, loadPersonalCredentials, updatePersonalCredentials, type PersonalCredentialStatus, type PersonalCredentialUpdate } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";

export function PersonalCredentials() {
  const { currentUser } = useApplicationResources();
  const [status, setStatus] = createSignal<PersonalCredentialStatus | null>(null, { ownedWrite: true });
  const [apiKey, setApiKey] = createSignal("", { ownedWrite: true });
  const [sshKey, setSshKey] = createSignal("", { ownedWrite: true });
  const [dmsUrl, setDmsUrl] = createSignal("", { ownedWrite: true });
  const [dmsToken, setDmsToken] = createSignal("", { ownedWrite: true });
  const [slsId, setSlsId] = createSignal("", { ownedWrite: true });
  const [slsSecret, setSlsSecret] = createSignal("", { ownedWrite: true });
  const [productionMessage, setProductionMessage] = createSignal("", { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [message, setMessage] = createSignal("", { ownedWrite: true });
  let generation = 0;
  createEffect(() => ({ subject: currentUser()?.subject, role: currentUser()?.role }), ({ subject }) => {
    const current = ++generation;
    setStatus(null); setApiKey(""); setSshKey(""); setDmsUrl(""); setDmsToken(""); setSlsId(""); setSlsSecret(""); setProductionMessage(""); setMessage(""); setBusy(false);
    if (!subject) return;
    void loadPersonalCredentials().then((value) => { if (current === generation) { setStatus(value); setDmsUrl(value.productionDmsUrl ?? ""); } }).catch((error) => { if (current === generation) setMessage(errorMessage(error)); });
  });
  const save = async () => {
    if (busy() || !status() || (!apiKey().trim() && !sshKey().trim())) return;
    const current = generation;
    const input: PersonalCredentialUpdate = {
      ...(apiKey().trim() ? { model: { mode: "replace", apiKey: apiKey() } } : {}),
      ...(sshKey().trim() ? { git: { mode: "replace", type: "ssh", privateKey: sshKey() } } : {}),
    };
    setBusy(true); setMessage("");
    try {
      const value = await updatePersonalCredentials(input);
      if (current !== generation) return;
      setStatus(value); setMessage("已保存");
    } catch (error) {
      if (current === generation) setMessage(errorMessage(error) === "issue_already_running" ? "有使用你凭证的工单正在运行，请等待结束后保存" : errorMessage(error));
    } finally { if (current === generation) setBusy(false); }
  };
  const saveProduction = async (kind: "dms" | "sls") => {
    if (busy() || !status()) return;
    if (kind === "dms" && !dmsToken().trim() && dmsUrl().trim() !== (status()?.productionDmsUrl ?? "")) { setProductionMessage("修改 DMS 地址时请同时填写 Token"); return; }
    if (kind === "sls" && (slsId().trim() || slsSecret().trim()) && !(slsId().trim() && slsSecret().trim())) { setProductionMessage("请同时填写 SLS AccessKey ID 和 Secret"); return; }
    const input: PersonalCredentialUpdate = { production: {
      ...(kind === "dms" && dmsToken().trim() ? { dms: { mode: "replace", url: dmsUrl().trim(), authorization: dmsToken().trim() } } : {}),
      ...(kind === "sls" && slsId().trim() && slsSecret().trim() ? { sls: { mode: "replace", accessKeyId: slsId().trim(), accessKeySecret: slsSecret().trim() } } : {}),
    } };
    if (!input.production?.dms && !input.production?.sls) return;
    const current = generation; setBusy(true); setProductionMessage("");
    try {
      const value = await updatePersonalCredentials(input);
      if (current !== generation) return;
      setStatus(value);
      if (kind === "dms") { setDmsUrl(value.productionDmsUrl ?? ""); setDmsToken(""); }
      else { setSlsId(""); setSlsSecret(""); }
      setProductionMessage("已保存");
    } catch (error) { if (current === generation) setProductionMessage(errorMessage(error) === "issue_already_running" ? "有使用你凭证的工单正在运行，请等待结束后保存" : errorMessage(error)); }
    finally { if (current === generation) setBusy(false); }
  };
  const hasApiKey = () => Boolean(status()?.provider && status()?.modelProviders.includes(status()!.provider!));
  return <Show when={currentUser()}>
    <section class="user-management-card personal-credentials" aria-label="我的凭证">
      <header class="user-management-header"><div><strong>我的凭证</strong><span>留空保留；生产查询优先使用个人配置，未配置时使用服务配置。</span></div></header>
      <div class="production-credentials-form personal-credentials-form">
        <Show when={currentUser()?.role === "developer"}><div>
          <h3>开发</h3>
          <label><span>API Key</span><input class="user-input credential-input" type="password" autocomplete="off" aria-label="apiKey" value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} placeholder={hasApiKey() ? "已配置，输入新值替换" : "未配置"} /></label>
          <label><span>SSH Key</span><textarea class="user-input credential-input secret-key-input" rows={1} aria-label="sshKey" autocomplete="off" spellcheck={false} value={sshKey()} onInput={(event) => setSshKey(event.currentTarget.value)} placeholder={status()?.gitSshConfigured ? "已配置，粘贴新私钥替换" : "粘贴 SSH 私钥"} /></label>
          <Button aria-label="保存凭证" type="primary" loading={busy()} disabled={!status() || busy() || (!apiKey().trim() && !sshKey().trim())} onClick={() => { void save(); }}>保存</Button>
        </div></Show>
      <div><h3>DMS</h3><label><span>地址</span><Input aria-label="生产 DMS 地址" value={dmsUrl()} placeholder="https://example.com/sse" onInput={event => setDmsUrl(event.currentTarget.value)} /></label><label><span>Token</span><PasswordInput aria-label="生产 DMS Token" autocomplete="off" value={dmsToken()} placeholder={status()?.productionDmsConfigured ? "已配置，留空保留" : "Bearer token"} onInput={event => setDmsToken(event.currentTarget.value)} /></label><Button aria-label="保存 DMS 生产凭证" type="primary" loading={busy()} disabled={!status() || busy() || !dmsUrl().trim() || !dmsToken().trim()} onClick={() => { void saveProduction("dms"); }}>保存</Button></div>
      <div><h3>SLS</h3><label><span>AccessKey ID</span><PasswordInput aria-label="生产 SLS AccessKey ID" autocomplete="off" value={slsId()} placeholder={status()?.productionSlsConfigured ? "已配置，留空保留" : "未配置"} onInput={event => setSlsId(event.currentTarget.value)} /></label><label><span>AccessKey Secret</span><PasswordInput aria-label="生产 SLS AccessKey Secret" autocomplete="off" value={slsSecret()} onInput={event => setSlsSecret(event.currentTarget.value)} /></label><Button aria-label="保存 SLS 生产凭证" type="primary" loading={busy()} disabled={!status() || busy() || !slsId().trim() || !slsSecret().trim()} onClick={() => { void saveProduction("sls"); }}>保存</Button></div></div>
      <Show when={message()}><div class="personal-credentials-message" role="status">{message()}</div></Show>
      <Show when={productionMessage()}><div class="personal-credentials-message" role="status">{productionMessage()}</div></Show>
    </section>
  </Show>;
}
