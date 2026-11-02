import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Modal, PasswordInput, Select } from "../ui";
import { AGENT_CODEMODE_MODES, type AgentModelOption, type AgentModelSelection } from "../data/client";
import { settingsError } from "./settings-error";

export const codemodeLabels = { off: "关闭", on: "开启", only: "仅 Codemode" } as const;

export const modelSummary = (selection: AgentModelSelection) => `${selection.provider || "未配置"} / ${selection.model || "未配置"} · ${selection.thinkingLevel} · Codemode ${codemodeLabels[selection.codemode]}`;

/** Edits one model group (provider, model, thinking level, Codemode and its API key) for shared or personal credentials. */
export function ModelCredentialDialog(props: {
  open: boolean;
  /** User identity and shared/personal target, independent of identical model settings. */
  draftKey: string;
  onSavingChange: (saving: boolean) => void;
  title: string;
  models: AgentModelOption[];
  initial: AgentModelSelection;
  /** A key is stored for `initial.provider`; it is preserved only while that provider stays selected. */
  keyConfigured: boolean;
  onClose: () => void;
  onSave: (selection: AgentModelSelection, apiKey: string | undefined) => Promise<void>;
  onClear: () => Promise<void>;
  /** Controls shown above the fields, such as the shared/personal target switch. */
  children?: JSX.Element;
}) {
  const [provider, setProvider] = createSignal("", { ownedWrite: true });
  const [model, setModel] = createSignal("", { ownedWrite: true });
  const [thinkingLevel, setThinkingLevel] = createSignal<AgentModelSelection["thinkingLevel"]>("off", { ownedWrite: true });
  const [codemode, setCodemode] = createSignal<AgentModelSelection["codemode"]>("on", { ownedWrite: true });
  const [apiKey, setApiKey] = createSignal("", { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const providers = createMemo(() => [...new Set(props.models.map(option => option.provider))]);
  const modelsOf = (value: string) => props.models.filter(option => option.provider === value);
  const thinkingLevelsOf = (value: string, id: string) => props.models.find(option => option.provider === value && option.id === id)?.thinkingLevels ?? [];
  const keyPreserved = () => props.keyConfigured && provider() === props.initial.provider;
  let generation = 0;
  // A target change invalidates both secret drafts and results of already-submitted writes.
  createEffect(() => props.open ? JSON.stringify([props.draftKey, props.initial, props.keyConfigured]) : "", key => {
    generation++;
    setApiKey(""); setError(""); setSaving(false); props.onSavingChange(false);
    if (!key) return;
    const initial = props.initial;
    setProvider(initial.provider); setModel(initial.model); setThinkingLevel(initial.thinkingLevel); setCodemode(initial.codemode);
  });
  onCleanup(() => { generation++; });
  const selectProvider = (value: string) => {
    const first = modelsOf(value)[0];
    setProvider(value);
    setModel(first?.id ?? "");
    if (first && !first.thinkingLevels.includes(thinkingLevel())) setThinkingLevel(first.thinkingLevels[0] ?? "off");
  };
  const selectModel = (value: string) => {
    setModel(value);
    const levels = thinkingLevelsOf(provider(), value);
    if (levels.length && !levels.includes(thinkingLevel())) setThinkingLevel(levels[0]!);
  };
  const run = async (operation: () => Promise<void>) => {
    if (saving()) return;
    const owner = generation;
    setSaving(true); props.onSavingChange(true); setError("");
    try { await operation(); }
    catch (cause) { if (owner === generation) setError(settingsError(cause)); }
    finally { if (owner === generation) { setSaving(false); props.onSavingChange(false); } }
  };
  const save = () => {
    if (!provider() || !model()) { setError("请选择 provider 和模型"); return; }
    if (!apiKey() && !keyPreserved()) { setError(props.keyConfigured ? "更换 provider 时请填写新的 API Key，或清除凭据" : "请填写 API Key"); return; }
    if (apiKey() && !apiKey().trim()) { setError("请填写有效的 API Key"); return; }
    void run(() => props.onSave({ provider: provider(), model: model(), thinkingLevel: thinkingLevel(), codemode: codemode() }, apiKey() || undefined));
  };
  return <Modal width={460} open={props.open} title={props.title} okText="保存" cancelText="取消" confirmLoading={saving()} onCancel={props.onClose} onOk={save}>
    <div class="settings-form">
      {props.children}
      <Show when={error()}><div role="alert" class="user-management-error">{error()}</div></Show>
      <Show when={providers().length} fallback={<div class="settings-target-feedback">全局 Pi models.json 未提供可用 provider。</div>}>
        <label><span>Provider</span><Select aria-label="Provider" value={provider()} options={providers().map(value => ({ value, label: value }))} onChange={selectProvider} /></label>
        <label><span>模型</span><Select aria-label="模型" value={model()} options={modelsOf(provider()).map(option => ({ value: option.id, label: option.id }))} onChange={selectModel} /></label>
        <label><span>思考级别</span><Select aria-label="思考级别" value={thinkingLevel()} options={thinkingLevelsOf(provider(), model()).map(value => ({ value, label: value }))} onChange={value => setThinkingLevel(value as AgentModelSelection["thinkingLevel"])} /></label>
        <label><span>Codemode</span><Select aria-label="Codemode" value={codemode()} options={AGENT_CODEMODE_MODES.map(value => ({ value, label: `${value} · ${codemodeLabels[value]}` }))} onChange={value => setCodemode(value as AgentModelSelection["codemode"])} /></label>
        <label><span>API Key</span><PasswordInput aria-label="API Key" value={apiKey()} placeholder={keyPreserved() ? "留空保留原值" : props.keyConfigured ? "更换 provider 需填写新的 API Key" : ""} onInput={event => setApiKey(event.currentTarget.value)} /></label>
      </Show>
      <Show when={props.keyConfigured}><Button danger type="text" size="small" disabled={saving()} onClick={() => { void run(props.onClear); }}>清除凭据</Button></Show>
    </div>
  </Modal>;
}
