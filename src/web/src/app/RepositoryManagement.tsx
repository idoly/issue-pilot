import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Input, Modal, Select, Skeleton } from "../ui";
import { deleteRepository, loadRepositories, registerRepository, updateRepository, type ManagedRepository } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { settingsError } from "./settings-error";

const allRepositories = "all";
const otherRepositories = "other";
const repositoryGroups = new Map([
  ["oms", "oms"],
  ["srm", "srm"],
  ["xhgj-mall", "mall"],
  ["mdm", "mdm"],
  ["crm", "crm"],
  ["iqs", "iqs"],
  ["mpm", "mpm"],
]);
const groupOptions = [{ value: allRepositories, label: "全部" }, ...Array.from(repositoryGroups.values(), (value) => ({ value, label: value })), { value: otherRepositories, label: "其他" }];
const namespacePath = /^(?:(?:https|ssh):\/\/[^/]+\/|[\w.-]+@[\w.-]+:\/?)digital-biz-projects\/([^/]+)\/[^/]/i;
function repositoryGroup(url: string) {
  const namespace = namespacePath.exec(url)?.[1];
  return (namespace && repositoryGroups.get(namespace.toLowerCase())) || otherRepositories;
}

const addressPrefix = (url: string) => url.slice(0, Math.max(url.lastIndexOf("/"), url.includes("://") ? -1 : url.indexOf(":")) + 1);
const repositoryName = (url: string) =>
  url
    .trim()
    .split(/[/:]/)
    .at(-1)
    ?.replace(/\.git$/, "") ?? "";
export function RepositoryManagement(props: { onSelectService?: (key: string) => void } = {}) {
  const { currentUser, refreshConfiguration, refreshCatalog } = useApplicationResources();
  const [rows, setRows] = createSignal<ManagedRepository[]>([], { ownedWrite: true });
  const [group, setGroup] = createSignal(allRepositories, { ownedWrite: true });
  const sortedRows = createMemo(() => [...rows()].sort((left, right) => addressPrefix(left.url).localeCompare(addressPrefix(right.url)) || left.url.localeCompare(right.url)));
  const visibleRows = createMemo(() => {
    const selected = group();
    return selected === allRepositories ? sortedRows() : sortedRows().filter((row) => repositoryGroup(row.url) === selected);
  });
  let list: HTMLDivElement | undefined;
  createEffect(group, () => {
    if (list) list.scrollTop = 0;
  });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  // A load failure hides the table; an action or shared-refresh failure keeps the loaded rows visible.
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  const [actionError, setActionError] = createSignal("", { ownedWrite: true });
  // The delete dialog shows its own failure; the page banner covers everything else.
  const error = () => loadError() || (remove() ? "" : actionError());
  const [saveError, setSaveError] = createSignal("", { ownedWrite: true });
  const [conflict, setConflict] = createSignal(false, { ownedWrite: true });
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [editing, setEditing] = createSignal<ManagedRepository | null>(null, { ownedWrite: true });
  const [name, setName] = createSignal("", { ownedWrite: true });
  const [url, setUrl] = createSignal("", { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [remove, setRemove] = createSignal<ManagedRepository | null>(null, { ownedWrite: true });
  let generation = 0,
    loadGeneration = 0;
  const canEdit = () => currentUser()?.role === "developer";
  const close = () => {
    setOpen(false);
    setEditing(null);
    setName("");
    setUrl("");
    setSaveError("");
    setConflict(false);
  };
  const load = async () => {
    const owner = generation,
      request = ++loadGeneration;
    setLoading(true);
    setLoadError("");
    try {
      const value = await loadRepositories();
      if (owner === generation && request === loadGeneration) setRows(value);
    } catch (cause) {
      if (owner === generation && request === loadGeneration) setLoadError(settingsError(cause));
    } finally {
      if (owner === generation && request === loadGeneration) setLoading(false);
    }
  };
  createEffect(
    () => `${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`,
    (identity, previous) => {
      if (identity === previous) return;
      generation++;
      close();
      setRemove(null);
      setSaving(false);
      setActionError("");
      setRows([]);
      setGroup(allRepositories);
      if (identity.split(":")[0]) void load();
      else setLoading(false);
    },
  );
  onCleanup(() => {
    generation++;
  });
  const edit = (repository?: ManagedRepository) => {
    if (!canEdit()) return;
    setEditing(repository ?? null);
    setName(repository?.name ?? "");
    setUrl(repository?.url ?? "");
    setSaveError("");
    setOpen(true);
  };
  const refresh = async (owner: number) => {
    if (owner !== generation) return;
    setActionError("");
    const results = await Promise.allSettled([load(), refreshConfiguration(), refreshCatalog()]);
    if (owner !== generation) return;
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") setActionError(settingsError(failure.reason));
  };
  const save = async () => {
    if (saving() || !canEdit()) return;
    if (!url().trim()) {
      setSaveError("请填写仓库地址");
      return;
    }
    const owner = generation,
      target = editing();
    const input = { name: name().trim() || repositoryName(url()), url: url().trim() };
    setSaving(true);
    setSaveError("");
    try {
      if (target) await updateRepository(target.id, { ...input, expectedRevision: target.revision });
      else await registerRepository(input);
      if (owner === generation) close();
      await refresh(owner);
    } catch (cause) {
      if (owner === generation) {
        if (open()) {
          setSaveError(settingsError(cause));
          setConflict(cause instanceof Error && cause.message === "configuration_changed");
        } else setActionError(settingsError(cause));
      }
    } finally {
      if (owner === generation) setSaving(false);
    }
  };
  const confirmRemove = async () => {
    const target = remove();
    if (!target || saving() || !canEdit()) return;
    const owner = generation;
    setSaving(true);
    setActionError("");
    try {
      await deleteRepository(target.id);
      if (owner === generation) setRemove(null);
      await refresh(owner);
    } catch (cause) {
      if (owner === generation) setActionError(settingsError(cause));
    } finally {
      if (owner === generation) setSaving(false);
    }
  };
  return (
    <section class="user-management-card repository-management" aria-label="仓库管理">
      <header class="user-management-header">
        <strong>仓库</strong>
        <div class="repository-toolbar">
          <Select aria-label="仓库分组" value={group()} options={groupOptions} onChange={setGroup} />
          <Show when={canEdit()}>
            <Button size="small" type="primary" disabled={saving()} onClick={() => edit()}>
              登记仓库
            </Button>
          </Show>
        </div>
      </header>
      <Show when={error()}>
        <div class="user-management-error" role="alert">
          {error()}
          <Button
            size="small"
            onClick={() => {
              void refresh(generation);
            }}
          >
            重试
          </Button>
        </div>
      </Show>
      <Show
        when={!loading()}
        fallback={
          <div class="user-management-loading">
            <Skeleton active paragraph={{ rows: 6 }} />
          </div>
        }
      >
        <Show when={!loadError()}>
          <div ref={list} class="settings-table-scroll ip-scrollbar" role="region" aria-label="仓库列表" tabindex={0}>
            <table class="settings-table">
              <colgroup>
                <col class="repository-name-column" />
                <col />
                <col class="repository-services-column" />
                <col class="repository-actions-column" />
              </colgroup>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>地址</th>
                  <th>使用服务</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={visibleRows()}
                  fallback={
                    <tr>
                      <td colspan={4}>{group() === allRepositories ? "暂无仓库" : "此分组暂无仓库"}</td>
                    </tr>
                  }
                >
                  {(row) => (
                    <tr>
                      <td>
                        <strong title={row.name}>{row.name}</strong>
                      </td>
                      <td>
                        <code title={row.url}>{row.url}</code>
                      </td>
                      <td>
                        <For each={row.services} fallback="—">
                          {(service) => (
                            <button class="settings-service-link" type="button" title={service.name} onClick={() => props.onSelectService?.(service.key)}>
                              {service.name}
                            </button>
                          )}
                        </For>
                      </td>
                      <td>
                        <Show when={canEdit()}>
                          <div class="settings-row-actions">
                            <Button type="text" size="small" disabled={saving()} onClick={() => edit(row)}>
                              编辑
                            </Button>
                            <Show when={!row.services.length}>
                              <Button type="text" danger size="small" disabled={saving()} onClick={() => setRemove(row)}>
                                删除
                              </Button>
                            </Show>
                          </div>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
      <Modal
        width={540}
        open={open()}
        title={editing() ? "编辑仓库" : "登记仓库"}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving()}
        onCancel={close}
        onOk={() => {
          void save();
        }}
      >
        <div class="settings-form">
          <Show when={saveError()}>
            <div class="user-management-error" role="alert">
              {saveError()}
              <Show when={conflict()}>
                <Button
                  size="small"
                  onClick={() => {
                    close();
                    void load();
                  }}
                >
                  重新加载
                </Button>
              </Show>
            </div>
          </Show>
          <label>
            <span>仓库地址</span>
            <Input aria-label="仓库地址" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
          </label>
          <label>
            <span>显示名称</span>
            <Input aria-label="仓库显示名称" value={name()} placeholder="默认使用仓库名" onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <Show when={editing()?.services.length}>
            <p class="muted">
              使用服务：
              {editing()
                ?.services.map((service) => service.name)
                .join("、")}
            </p>
          </Show>
        </div>
      </Modal>
      <Modal
        open={remove() !== null}
        title="删除仓库"
        okText="删除"
        cancelText="取消"
        confirmLoading={saving()}
        okButtonProps={{ danger: true }}
        onCancel={() => {
          setRemove(null);
          setActionError("");
        }}
        onOk={() => {
          void confirmRemove();
        }}
      >
        <p>删除“{remove()?.name}”？</p>
        <Show when={actionError()}>
          <div class="user-management-error" role="alert">
            {actionError()}
          </div>
        </Show>
      </Modal>
    </section>
  );
}
