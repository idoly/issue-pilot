import { createSignal, onCleanup, Show } from "solid-js";
import { Button, Input, PasswordInput } from "../ui";
import { currentUserSubject, loadIssueSearchConfiguration, saveIssueSearchConfiguration, type IssueSearchConfiguration } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

function SearchSettingsForm(props: { subject: string }) {
  const { refreshCatalog } = useApplicationResources();
  const [state, setState] = createSignal<IssueSearchConfiguration>();
  const [enabled, setEnabled] = createSignal(false);
  const [accountId, setAccountId] = createSignal("");
  const [token, setToken] = createSignal("");
  const [clearToken, setClearToken] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const isCurrent = () => !lifetime.signal.aborted && currentUserSubject() === props.subject;
  const apply = (value: IssueSearchConfiguration) => {
    setState(value);
    setEnabled(value.enabled);
    setAccountId(value.accountId);
    setToken("");
    setClearToken(false);
  };
  void loadIssueSearchConfiguration(lifetime.signal).then(
    (value) => {
      if (isCurrent()) apply(value);
    },
    (cause) => {
      if (isCurrent()) setError(settingsError(cause));
    },
  );
  const save = async () => {
    const current = state();
    if (!current || saving() || !isCurrent()) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const value = await saveIssueSearchConfiguration({
        expectedRevision: current.revision,
        enabled: enabled(),
        accountId: accountId(),
        ...(clearToken() ? { apiToken: null } : token().trim() ? { apiToken: token().trim() } : {}),
      });
      if (isCurrent()) {
        apply(value);
        setSaved(true);
        void refreshCatalog().catch(() => undefined);
      }
    } catch (cause) {
      if (isCurrent()) setError(settingsError(cause));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <>
      <Show when={error()}>
        <p class="user-management-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p class="parameters-hint" role="status">
          工单搜索配置已保存。
        </p>
      </Show>
      <Show
        when={state()}
        fallback={
          <Show when={!error()}>
            <p class="parameters-hint" role="status">
              正在加载配置…
            </p>
          </Show>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="parameters-grid">
            <label>
              <span>启用工单搜索</span>
              <input type="checkbox" checked={enabled()} disabled={saving()} onChange={(event) => setEnabled(event.currentTarget.checked)} />
            </label>
            <label>
              <span>Cloudflare Account ID</span>
              <Input value={accountId()} maxlength={32} disabled={saving()} onInput={(event) => setAccountId(event.currentTarget.value)} />
            </label>
            <label>
              <span>Cloudflare API Token</span>
              <PasswordInput
                value={token()}
                disabled={saving() || clearToken()}
                placeholder={state()?.tokenConfigured ? "已配置，留空保留" : "Workers AI Read Token"}
                maxlength={1024}
                onInput={(event) => setToken(event.currentTarget.value)}
              />
            </label>
            <Show when={state()?.tokenConfigured}>
              <label>
                <span>清除已保存的 Token</span>
                <input type="checkbox" checked={clearToken()} disabled={saving()} onChange={(event) => setClearToken(event.currentTarget.checked)} />
              </label>
            </Show>
          </div>
          <div class="user-management-header parameters-header">
            <span>开启后，索引所需的工单标题和描述，以及用户输入的搜索词，会发送给 Cloudflare。索引由管理员显式更新。</span>
            <Button htmlType="submit" type="primary" loading={saving()}>
              保存工单搜索配置
            </Button>
          </div>
        </form>
      </Show>
    </>
  );
}

export function IssueSearchSettings() {
  const { currentUser } = useApplicationResources();
  return (
    <section class="user-management-card parameters-card" aria-label="工单搜索">
      <header class="user-management-header">
        <strong>工单搜索</strong>
      </header>
      <Show when={currentUser()?.isAdmin ? currentUser()?.subject : undefined} keyed fallback={<p class="parameters-hint">只有管理人员可以修改工单搜索配置。</p>}>
        {(subject) => <SearchSettingsForm subject={subject} />}
      </Show>
    </section>
  );
}
