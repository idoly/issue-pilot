import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Button, Input, PasswordInput, Modal, Skeleton, Tag, TextArea } from "../ui";
import {
  loadPersonalCredentials,
  loadSharedDmsCredentials,
  loadSharedSlsCredentials,
  updateAgentConfiguration,
  updatePersonalCredentials,
  updateSharedDmsCredentials,
  updateSharedSlsCredentials,
  type AgentModelSelection,
  type PersonalCredentialStatus,
  type PersonalCredentialUpdate,
  type SharedDmsCredentialStatus,
  type SharedSlsCredentialStatus,
} from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { ModelCredentialDialog } from "./ModelCredentialDialog";
import { settingsError } from "./settings-error";

type Group = "model" | "git" | "dms" | "sls";
const groups: Array<{ key: Group; label: string }> = [
  { key: "model", label: "API Key" },
  { key: "git", label: "SSH Key" },
  { key: "dms", label: "DMS" },
  { key: "sls", label: "SLS" },
];
const sharedGroups: readonly Group[] = ["model", "dms", "sls"];

export function PersonalCredentials() {
  const { currentUser, configuration, configurationLoaded, refreshConfiguration } = useApplicationResources();
  const [status, setStatus] = createSignal<PersonalCredentialStatus | null>(null, { ownedWrite: true });
  const [sharedDms, setSharedDms] = createSignal<SharedDmsCredentialStatus | null>(null, { ownedWrite: true });
  const [sharedSls, setSharedSls] = createSignal<SharedSlsCredentialStatus | null>(null, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [selected, setSelected] = createSignal<Group | null>(null, { ownedWrite: true });
  // Admins edit the application shared group by default; clearing the checkbox edits their own credentials.
  const [shared, setShared] = createSignal(false, { ownedWrite: true });
  const [secret, setSecret] = createSignal("", { ownedWrite: true });
  const [accessKeyId, setAccessKeyId] = createSignal("", { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  let generation = 0;
  const isAdmin = () => currentUser()?.isAdmin === true;
  const canEditPersonal = (group: Group) => group !== "git" || currentUser()?.role === "developer";
  const configured = (group: Group) =>
    group === "model"
      ? Boolean(status()?.model)
      : group === "git"
        ? status()?.gitSshConfigured === true
        : group === "dms"
          ? status()?.productionDmsConfigured === true
          : status()?.productionSlsConfigured === true;
  const sharedConfigured = (group: Group) => (group === "model" ? configuration().agent.apiKeyConfigured : group === "dms" ? sharedDms()?.configured === true : sharedSls()?.configured === true);
  const targetConfigured = (group: Group) => (shared() ? sharedConfigured(group) : configured(group));
  const sharedModel = (): AgentModelSelection => {
    const agent = configuration().agent;
    return { provider: agent.provider, model: agent.model, thinkingLevel: agent.thinkingLevel, codemode: agent.codemode };
  };
  // A new personal group starts from the shared model so only the key has to be filled in.
  const modelInitial = () => (shared() ? sharedModel() : (status()?.model ?? sharedModel()));
  const dmsUrl = (sharedTarget = shared()) => (sharedTarget ? (sharedDms()?.url ?? "") : (status()?.productionDmsUrl ?? ""));
  // Signal writes are not readable until the next flush, so callers pass the new group and target explicitly.
  const resetDrafts = (group: Group | null, sharedTarget: boolean) => {
    setSecret("");
    setAccessKeyId("");
    setUrl(group === "dms" ? dmsUrl(sharedTarget) : "");
    setSaveError("");
    setConflict(false);
  };
  const close = () => {
    setSelected(null);
    setShared(false);
    resetDrafts(null, false);
  };
  const load = async (admin: boolean) => {
    const owner = ++generation;
    setStatus(null);
    setSharedDms(null);
    setSharedSls(null);
    setError("");
    try {
      const [value, dms, sls] = await Promise.all([loadPersonalCredentials(), admin ? loadSharedDmsCredentials() : null, admin ? loadSharedSlsCredentials() : null]);
      if (owner === generation) {
        setStatus(value);
        setSharedDms(dms);
        setSharedSls(sls);
      }
    } catch (cause) {
      if (owner === generation) setError(settingsError(cause));
    }
  };
  createEffect(
    () => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}:${isAdmin()}`,
    (identity, previous) => {
      if (identity === previous) return;
      generation++;
      close();
      setSaving(false);
      setStatus(null);
      setError("");
      const [subject, , admin] = identity.split(":");
      if (subject) void load(admin === "true");
    },
  );
  onCleanup(() => {
    generation++;
  });
  const open = (group: Group) => {
    close();
    if (group === "model" && !configurationLoaded()) void refreshConfiguration().catch(() => undefined);
    const sharedTarget = isAdmin() && sharedGroups.includes(group);
    setShared(sharedTarget);
    setSelected(group);
    resetDrafts(group, sharedTarget);
  };
  const switchTarget = (value: boolean) => {
    setShared(value);
    resetDrafts(selected(), value);
  };
  const targetSwitch = (group: Group | null) => (
    <Show when={isAdmin() && group && sharedGroups.includes(group)}>
      <label class="settings-checkbox">
        <input type="checkbox" checked={shared()} disabled={saving() || !canEditPersonal(group!)} onChange={(event) => switchTarget(event.currentTarget.checked)} />
        共享凭证（影响所有未配置个人凭证的人）
      </label>
    </Show>
  );
  const saveModel = async (selection: AgentModelSelection | null, apiKey: string | undefined) => {
    const owner = generation;
    if (shared()) {
      const apiKeyUpdate = selection ? (apiKey ? { apiKey: { mode: "replace" as const, value: apiKey } } : {}) : { apiKey: { mode: "clear" as const } };
      await updateAgentConfiguration({ ...(selection ?? sharedModel()), runtime: configuration().agent.runtime, ...apiKeyUpdate });
      await refreshConfiguration().catch(() => undefined);
      if (owner === generation) close();
      return;
    }
    const credentials = status();
    if (!credentials) return;
    const model: NonNullable<PersonalCredentialUpdate["model"]> = selection ? { mode: "replace", ...selection, ...(apiKey ? { apiKey } : {}) } : { mode: "clear" };
    let value: Awaited<ReturnType<typeof updatePersonalCredentials>>;
    try {
      value = await updatePersonalCredentials({ expectedRevision: credentials.revision, model });
    } catch (error) {
      // The model dialog has no reload action; refresh the revision so the next save is not stale forever.
      if (owner === generation && error instanceof Error && error.message === "configuration_changed")
        void loadPersonalCredentials().then(
          (value) => {
            // Keep the open dialog's model object so its draft and error stay; take the new revision and statuses.
            if (owner !== generation) return;
            const current = untrack(status);
            setStatus(current ? { ...value, model: current.model } : value);
          },
          () => undefined,
        );
      throw error;
    }
    if (owner === generation) {
      setStatus(value);
      close();
    }
  };
  const saveShared = async (group: "dms" | "sls", clear: boolean, owner: number) => {
    if (group === "dms") {
      const current = sharedDms();
      if (!current) throw new Error("shared_credentials_not_loaded");
      const value = await updateSharedDmsCredentials(
        clear ? { expectedRevision: current.revision, mode: "clear" } : { expectedRevision: current.revision, mode: "replace", url: url().trim(), authorization: secret() },
      );
      if (owner === generation) setSharedDms(value);
      return;
    }
    const current = sharedSls();
    if (!current) throw new Error("shared_credentials_not_loaded");
    const value = await updateSharedSlsCredentials(
      clear ? { expectedRevision: current.revision, mode: "clear" } : { expectedRevision: current.revision, mode: "replace", accessKeyId: accessKeyId(), accessKeySecret: secret() },
    );
    if (owner === generation) setSharedSls(value);
  };
  const save = async (clear = false) => {
    const group = selected(),
      credentials = status();
    if (!group || !credentials || saving()) return;
    const owner = generation;
    const supplied = Boolean(secret() || accessKeyId());
    if (!clear && !supplied) {
      if (targetConfigured(group) && (group !== "dms" || url().trim() === dmsUrl())) {
        close();
        return;
      }
      setSaveError(group === "dms" && targetConfigured(group) ? "更换地址时请填写 Authorization" : "请填写凭证");
      return;
    }
    if (!clear && (!secret().trim() || (group === "sls" && !accessKeyId().trim()) || (group === "dms" && !url().trim()))) {
      setSaveError("请填写完整凭证");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      if (shared() && (group === "dms" || group === "sls")) {
        await saveShared(group, clear, owner);
        if (owner === generation) close();
        return;
      }
      const input: PersonalCredentialUpdate = { expectedRevision: credentials.revision };
      if (group === "git") input.git = clear ? { mode: "clear" } : { mode: "replace", type: "ssh", privateKey: secret() };
      if (group === "dms") input.production = { dms: clear ? { mode: "clear" } : { mode: "replace", url: url().trim(), authorization: secret() } };
      if (group === "sls") input.production = { sls: clear ? { mode: "clear" } : { mode: "replace", accessKeyId: accessKeyId(), accessKeySecret: secret() } };
      const value = await updatePersonalCredentials(input);
      if (owner === generation) {
        setStatus(value);
        close();
      }
    } catch (cause) {
      if (owner === generation) {
        setSaveError(settingsError(cause));
        setConflict(cause instanceof Error && cause.message === "configuration_changed");
      }
    } finally {
      if (owner === generation) setSaving(false);
    }
  };
  const title = (group: Group | null) => {
    const label = groups.find((row) => row.key === group)?.label ?? "";
    return shared() ? `共享 ${label}` : `${group && configured(group) ? "更新" : "设置"} ${label}`;
  };
  return (
    <Show when={currentUser()}>
      <section class="user-management-card personal-credentials" aria-label="我的凭证">
        <header class="user-management-header">
          <div>
            <strong>我的凭证</strong>
            <span>
              {currentUser()?.name} · {currentUser()?.subject}
            </span>
          </div>
        </header>
        <Show when={error()}>
          <div role="alert" class="user-management-error">
            {error()}
            <Button
              size="small"
              onClick={() => {
                void load(isAdmin());
              }}
            >
              重试
            </Button>
          </div>
        </Show>
        <Show
          when={status()}
          fallback={
            <Show when={!error()}>
              <div class="user-management-loading">
                <Skeleton active paragraph={{ rows: 4 }} />
              </div>
            </Show>
          }
        >
          <div class="personal-credential-summary">
            <For each={groups}>
              {(group) => (
                <div>
                  <strong>{group.label}</strong>
                  <Tag color={configured(group.key) ? "green" : "default"}>{configured(group.key) ? "已配置" : "未配置"}</Tag>
                  <Button size="small" disabled={saving() || (!canEditPersonal(group.key) && !(isAdmin() && sharedGroups.includes(group.key)))} onClick={() => open(group.key)}>
                    {configured(group.key) ? "更新凭证" : "设置凭证"}
                  </Button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <ModelCredentialDialog
          open={selected() === "model"}
          draftKey={`${currentUser()?.subject}:${currentUser()?.role}:${isAdmin()}:${shared()}`}
          onSavingChange={setSaving}
          title={title("model")}
          models={configuration().agentModels}
          initial={modelInitial()}
          keyConfigured={targetConfigured("model")}
          onClose={close}
          onSave={(selection, apiKey) => saveModel(selection, apiKey)}
          onClear={() => saveModel(null, undefined)}
        >
          {targetSwitch("model")}
        </ModelCredentialDialog>
        <Modal
          width={460}
          open={selected() !== null && selected() !== "model"}
          title={title(selected())}
          okText="保存"
          cancelText="取消"
          confirmLoading={saving()}
          onCancel={close}
          onOk={() => {
            void save();
          }}
        >
          <div class="settings-form">
            {targetSwitch(selected())}
            <Show when={saveError()}>
              <div role="alert" class="user-management-error">
                {saveError()}
                <Show when={conflict()}>
                  <Button
                    size="small"
                    onClick={() => {
                      close();
                      void load(isAdmin());
                    }}
                  >
                    重新加载
                  </Button>
                </Show>
              </div>
            </Show>
            <Show when={selected() === "dms"}>
              <label>
                <span>DMS 地址</span>
                <Input aria-label="DMS 地址" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
              </label>
            </Show>
            <Show when={selected() === "sls"}>
              <label>
                <span>AccessKey ID</span>
                <PasswordInput
                  aria-label="AccessKey ID"
                  value={accessKeyId()}
                  placeholder={selected() && targetConfigured(selected()!) ? "留空保留原值" : ""}
                  onInput={(event) => setAccessKeyId(event.currentTarget.value)}
                />
              </label>
            </Show>
            <label>
              <span>{selected() === "git" ? "SSH 私钥" : selected() === "dms" ? "Authorization" : "AccessKey Secret"}</span>
              <Show
                when={selected() === "git"}
                fallback={
                  <PasswordInput
                    aria-label="新凭证"
                    value={secret()}
                    placeholder={selected() && targetConfigured(selected()!) ? "留空保留原值" : ""}
                    onInput={(event) => setSecret(event.currentTarget.value)}
                  />
                }
              >
                <TextArea aria-label="SSH 私钥" value={secret()} placeholder="留空保留原值" onInput={(event) => setSecret(event.currentTarget.value)} autoSize={{ minRows: 5, maxRows: 10 }} />
              </Show>
            </label>
            <Show when={selected() && targetConfigured(selected()!)}>
              <Button
                danger
                type="text"
                size="small"
                disabled={saving()}
                onClick={() => {
                  void save(true);
                }}
              >
                清除凭证
              </Button>
            </Show>
          </div>
        </Modal>
      </section>
    </Show>
  );
}
