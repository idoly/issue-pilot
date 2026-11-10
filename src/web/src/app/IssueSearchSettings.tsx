import { createSignal, onCleanup, Show } from "solid-js";
import { Button, Input, PasswordInput, Select } from "../ui";
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
  const dirty = () => {
    const current = state();
    return current && (enabled() !== current.enabled || (enabled() && (accountId().trim() !== current.accountId || Boolean(token().trim()))) || clearToken());
  };
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
    if (!current || !dirty() || saving() || !isCurrent()) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const value = await saveIssueSearchConfiguration({
        expectedRevision: current.revision,
        enabled: enabled(),
        accountId: enabled() ? accountId() : current.accountId,
        ...(!enabled() && clearToken() ? { apiToken: null } : enabled() && token().trim() ? { apiToken: token().trim() } : {}),
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
        <p class="user-management-error search-parameter-message" role="alert">
          {error()}
        </p>
      </Show>
      <Show
        when={state()}
        fallback={
          <Show when={!error()}>
            <p class="search-parameter-message" role="status">
              正在加载工单搜索设置…
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
              工单搜索
              <small>（查询及索引文本发送给 Cloudflare）</small>
            </span>
            <Select
              aria-label="工单搜索"
              value={enabled() ? "enabled" : "disabled"}
              options={[
                { value: "disabled", label: "关闭" },
                { value: "enabled", label: "启用" },
              ]}
              disabled={saving()}
              onChange={(value) => {
                setEnabled(value === "enabled");
                setClearToken(false);
              }}
            />
          </label>
          <Show when={enabled()}>
            <label>
              <span>
                Cloudflare Account ID
                <small>（32 位十六进制）</small>
              </span>
              <Input aria-label="Cloudflare Account ID" value={accountId()} maxlength={32} disabled={saving()} onInput={(event) => setAccountId(event.currentTarget.value)} />
            </label>
            <label>
              <span>
                Cloudflare API Token
                <small>（Workers AI Read 权限）</small>
              </span>
              <PasswordInput
                aria-label="Cloudflare API Token"
                value={token()}
                disabled={saving()}
                placeholder={state()?.tokenConfigured ? "已配置，留空保留" : "填写 API Token"}
                maxlength={1024}
                onInput={(event) => setToken(event.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={!enabled() && state()?.tokenConfigured}>
            <label class="search-parameter-clear">
              <input type="checkbox" checked={clearToken()} disabled={saving()} onChange={(event) => setClearToken(event.currentTarget.checked)} />
              <span>清除已保存的 Token</span>
            </label>
          </Show>
          <div class="search-parameter-actions">
            <Show when={saved() && !dirty()}>
              <p role="status">工单搜索配置已保存。</p>
            </Show>
            <Button htmlType="submit" loading={saving()} disabled={!dirty()}>
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
    <Show when={currentUser()?.isAdmin ? currentUser()?.subject : undefined} keyed>
      {(subject) => <SearchSettingsForm subject={subject} />}
    </Show>
  );
}
