import { createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Modal, Select } from "../ui";
import type { CapabilityName } from "../../../domain/contracts";
import { updateService } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { ServiceDeploymentEditorRow, serviceDeploymentDraft, serializeServiceDeployment, deploymentValidationError, serviceSaveErrorMessage, type ServiceDeploymentDraft } from "./ConfigurationView";

export function CapabilityConfigurationDialog(props: { capability: CapabilityName; onClose: () => void }) {
  const { configuration, refreshConfiguration } = useApplicationResources();
  const [serviceKey, setServiceKey] = createSignal(untrack(() => configuration().services.find(service => service.deployments.some(row => row.capabilities.includes(props.capability)))?.key ?? configuration().services[0]?.key ?? ""), { ownedWrite: true });
  const [environment, setEnvironment] = createSignal("prod", { ownedWrite: true });
  const [draft, setDraft] = createSignal<ServiceDeploymentDraft | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const service = createMemo(() => configuration().services.find(row => row.key === serviceKey()));
  const deployment = createMemo(() => service()?.deployments.find(row => row.environmentKey === environment()));
  const repositories = () => service()?.repositories.map(row => ({ ...row, key: row.id })) ?? [];
  const select = (key: string, env: string) => { setServiceKey(key); setEnvironment(env); setDraft(null); setError(""); };
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const save = async () => {
    const current = service(), value = draft(); if (saving() || !current || !value) return;
    const validation = deploymentValidationError(value); if (validation) { setError(validation); return; }
    setSaving(true); setError("");
    try {
      await updateService(current.key, { name: current.name, description: current.description, repositories: current.repositories, deployments: current.deployments.map(row => serializeServiceDeployment(row.environmentKey === environment() ? value : serviceDeploymentDraft(row), repositories())) });
      await refreshConfiguration();
      if (!disposed) props.onClose();
    } catch (cause) { if (!disposed) setError(serviceSaveErrorMessage(cause)); }
    finally { if (!disposed) setSaving(false); }
  };
  return <Modal open title={`${props.capability.toUpperCase()} 配置`} width={800} okText="保存" confirmLoading={saving()} okButtonProps={{ disabled: !draft() }} onCancel={props.onClose} onOk={() => { void save(); }}><div class="user-form">
    <label><span>服务</span><Select aria-label="能力配置服务" value={serviceKey()} options={configuration().services.map(row => ({ value: row.key, label: row.name }))} disabled={saving()} onChange={key => select(key, environment())} /></label>
    <label><span>环境</span><Select aria-label="能力配置环境" value={environment()} options={configuration().environments.filter(row => row.key !== "dev" && service()?.deployments.some(deployment => deployment.environmentKey === row.key)).map(row => ({ value: row.key, label: row.name }))} disabled={saving()} onChange={env => select(serviceKey(), env)} /></label>
    <For each={deployment() ? [`${serviceKey()}:${environment()}`] : []} fallback={<p>该服务尚未配置此环境，请在服务中添加部署。</p>}>{() => <ServiceDeploymentEditorRow capability={props.capability} initiallyExpanded serviceKey={serviceKey()} index={0} deployment={serviceDeploymentDraft(deployment()!)} environmentName={configuration().environments.find(row => row.key === environment())?.name ?? environment()} repositories={repositories} repositoryName={row => row.url.split("/").at(-1)?.replace(/\.git$/, "") ?? row.alias} onChange={next => { setDraft(next); }} />}</For>
    <Show when={error()}><div role="alert" class="form-error">{error()}</div></Show>
  </div></Modal>;
}
