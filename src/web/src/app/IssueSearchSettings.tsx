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
          class="search-parameter-fields"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            <span>
              启用工单搜索
              <small id="search-data-note">（查询和索引所需文本发送给 Cloudflare）</small>
            </span>
            <input
              aria-label="启用工单搜索"
              aria-describedby="search-data-note"
              type="checkbox"
              checked={enabled()}
              disabled={saving()}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
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
          <div>
            <Button htmlType="submit" type="primary" loading={saving()}>
              保存工单搜索配置
            </Button>
            <Show when={saved()}>
              <p role="status">工单搜索配置已保存。</p>
            </Show>
          </div>
        </form>
      </Show>
    </>
  );
}

export function IssueSearchSettings() {
  const { currentUser } = useApplicationResources();
  return (
    <Show when={currentUser()?.isAdmin ? currentUser()?.subject : undefined} keyed>
      {(subject) => <SearchSettingsForm subject={subject} />}
    </Show>
  );
}
