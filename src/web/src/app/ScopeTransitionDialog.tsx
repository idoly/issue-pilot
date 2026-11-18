import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { Modal, Select } from "../ui";
import { GitBranch } from "../ui/icons";
import { applyIssueScopeTransition, canModifyIssueCode, issueWorkMode, planIssueScopeTransition, type IssueDetail, type IssueScopeTransitionPlan, type IssueWorkMode } from "../data/client";
import { createLatestTask } from "../data/latest";
import { useApplicationResources } from "./ApplicationResources";
import { selectedChoice } from "./IssueForm";
import { errorText } from "./error-text";
import { availableWorkModes, environmentKind, servicesForWorkMode, workModeLabel } from "./model";

/** Preflight then apply one scope change; the dialog owns the plan so a changed target invalidates it. */
export function ScopeTransitionDialog(props: { issue: IssueDetail; open: boolean; register: (open: () => void) => void; onClose: () => void; onApplied: () => Promise<void> }) {
  const { catalog, currentUser } = useApplicationResources();
  const [mode, setMode] = createSignal<IssueWorkMode>("production_analysis");
  const [service, setService] = createSignal("");
  const [plan, setPlan] = createSignal<IssueScopeTransitionPlan | null>(null);
  const [planning, setPlanning] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal("");
  const planTask = createLatestTask();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    planTask.cancel();
  });

  const currentWorkMode = () => {
    const kind = environmentKind(props.issue.environmentKey);
    return kind && issueWorkMode(kind, props.issue.type);
  };
  // Code-changing Issues only migrate between services within their own work mode.
  const availableModes = createMemo(() => {
    const kind = environmentKind(props.issue.environmentKey);
    return availableWorkModes(currentUser()?.role, catalog().services).filter(({ value }) => !kind || !canModifyIssueCode(kind) || value === currentWorkMode());
  });
  const availableServices = createMemo(() => servicesForWorkMode(catalog().services, mode()));
  const resetPlan = () => {
    planTask.cancel();
    setPlanning(false);
    setPlan(null);
    setError("");
  };

  // Opening is an event: start from the current work mode and service, with no stale plan.
  props.register(() => {
    setMode(currentWorkMode() ?? "production_analysis");
    setService(props.issue.service.key);
    resetPlan();
  });

  const requestPlan = async () => {
    if (!service()) return;
    const request = planTask.begin();
    setPlanning(true);
    setError("");
    try {
      const next = await planIssueScopeTransition(props.issue.id, { serviceKey: service(), workMode: mode() }, request.signal);
      if (request.isCurrent()) setPlan(next);
    } catch (cause) {
      if (request.isCurrent()) setError(errorText(cause));
    } finally {
      if (request.isCurrent()) setPlanning(false);
      request.finish();
    }
  };

  const apply = async () => {
    const current = plan();
    if (!current) {
      await requestPlan();
      return;
    }
    setApplying(true);
    setError("");
    try {
      await applyIssueScopeTransition(props.issue.id, { serviceKey: service(), workMode: mode() }, current);
      if (disposed) return;
      await props.onApplied();
      if (!disposed) props.onClose();
    } catch (cause) {
      if (!disposed) {
        setPlan(null);
        setError(errorText(cause));
      }
    } finally {
      if (!disposed) setApplying(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title="变更处理范围"
      okText={plan() ? "确认变更" : "预检变更"}
      cancelText="取消"
      confirmLoading={planning() || applying()}
      cancelButtonProps={{ disabled: planning() || applying() }}
      okButtonProps={{ disabled: !service() }}
      onOk={() => {
        void apply();
      }}
      onCancel={() => {
        if (!planning() && !applying()) props.onClose();
      }}
    >
      <div class="create-issue-form compact-issue-form">
        <label>
          <span>目标处理方式</span>
          <Select
            aria-label="目标处理方式"
            disabled={applying()}
            value={mode()}
            onChange={(value) => {
              const selected = selectedChoice(
                value,
                availableModes().map((option) => option.value),
              );
              if (!selected) return;
              setMode(selected);
              const candidates = servicesForWorkMode(catalog().services, selected);
              setService((current) => (candidates.some((row) => row.key === current) ? current : (candidates[0]?.key ?? "")));
              resetPlan();
            }}
            options={availableModes()}
          />
        </label>
        <label>
          <span>目标服务</span>
          <Select
            aria-label="目标服务"
            disabled={applying()}
            value={service()}
            onChange={(value) => {
              const selected = selectedChoice(
                value,
                availableServices().map((row) => row.key),
              );
              if (selected) {
                setService(selected);
                resetPlan();
              }
            }}
            options={availableServices().map((row) => ({ value: row.key, label: row.name }))}
          />
        </label>
        <Show when={plan()}>
          {(current) => (
            <section class="repository-band scope-transition-preview" aria-label="范围变更预览">
              <div class="band-title">
                <GitBranch size={16} />
                <h2>
                  {workModeLabel[current().current.workMode]} → {workModeLabel[current().target.workMode]}
                </h2>
              </div>
              <div class="scope-transition-repositories">
                <For each={current().repositories.retained}>
                  {(repository) => (
                    <div class="scope-transition-repository">
                      <strong>保留 · {repository.name}</strong>
                      <small>{repository.baseBranch}</small>
                    </div>
                  )}
                </For>
                <For each={current().repositories.added}>
                  {(repository) => (
                    <div class="scope-transition-repository">
                      <strong>新增 · {repository.name}</strong>
                      <small>{repository.baseBranch}</small>
                    </div>
                  )}
                </For>
                <For each={current().repositories.removed}>
                  {(repository) => (
                    <div class="scope-transition-repository">
                      <strong>移除 · {repository.name}</strong>
                      <small>{repository.baseBranch}</small>
                    </div>
                  )}
                </For>
                <Show when={current().branch}>
                  <div class="scope-transition-repository">
                    <strong>分支</strong>
                    <small>{current().branch}</small>
                  </div>
                </Show>
              </div>
              <p>已有对话和附件将保留；{current().session.closeCurrent ? "当前 Agent 会话将关闭并按目标范围重建。" : "当前范围无需变更。"}</p>
            </section>
          )}
        </Show>
        <Show when={error()}>
          <div class="create-error modal-form-error" role="alert">
            {error()}
          </div>
        </Show>
      </div>
    </Modal>
  );
}
