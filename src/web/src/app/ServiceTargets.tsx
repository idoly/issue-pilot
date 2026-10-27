import { createSignal, For, untrack } from "solid-js";
import { Button, Input } from "../ui";
import type { MysqlTarget } from "../../../domain/contracts";

type SlsTarget = { name: string; region: string; project: string; logstores: string[] };

function focusNewTarget(root: HTMLElement | undefined) {
  requestAnimationFrame(() => {
    if (!root?.isConnected) return;
    const input = root.querySelector<HTMLInputElement>(".settings-target-row:last-child input");
    input?.focus({ preventScroll: true }); input?.scrollIntoView?.({ block: "nearest" });
  });
}

export function MysqlTargetsEditor(props: { value: MysqlTarget[]; environment: string; onChange(value: MysqlTarget[]): void }) {
  let root: HTMLElement | undefined;
  const [targets, setTargets] = createSignal(untrack(() => props.value.map(value => ({ ...value }))), { ownedWrite: true });
  const emit = (next: MysqlTarget[]) => { setTargets(next); props.onChange(next.map(value => ({ ...value }))); };
  return <section ref={value => { root = value; }} class="settings-targets"><div class="settings-targets-head"><code>mysql</code><Button size="small" onClick={() => { emit([...targets(), { host: "", port: 3306, username: "", password: "", database: "" }]); focusNewTarget(root); }}>添加 MySQL</Button></div><For each={targets()}>{(target, index) => <div class="settings-target-row"><div class="settings-target-actions"><Button type="text" danger size="small" aria-label={`移除 MySQL ${props.environment} ${index() + 1}`} onClick={() => emit(targets().filter(value => value !== target))}>移除</Button></div><div class="settings-target-fields"><For each={["host", "port", "username", "password", "database"] as const}>{key => <label><span>{key}</span><Input aria-label={`mysql ${props.environment} ${index() + 1} ${key}`} type={key === "port" ? "number" : "text"} value={target[key]} onInput={event => { Object.assign(target, { [key]: key === "port" ? Number(event.currentTarget.value) : event.currentTarget.value }); emit([...targets()]); }} /></label>}</For></div></div>}</For></section>;
}

export function SlsTargetsEditor(props: { value: SlsTarget[]; deploymentIndex: number; onChange(value: SlsTarget[]): void }) {
  let root: HTMLElement | undefined;
  const [targets, setTargets] = createSignal(untrack(() => props.value.map(value => ({ ...value, logstores: value.logstores.join(", ") }))), { ownedWrite: true });
  type Draft = ReturnType<typeof targets>[number];
  const emit = (next: Draft[]) => { setTargets(next); props.onChange(next.map(value => ({ ...value, logstores: value.logstores.split(/[,，]/).map(name => name.trim()).filter(Boolean) }))); };
  const add = () => {
    let number = 1; while (targets().some(value => value.name === `target-${number}`)) number++;
    emit([...targets(), { name: `target-${number}`, region: "", project: "", logstores: "" }]); focusNewTarget(root);
  };
  const labels = { name: "目标名称", region: "地域（region）", project: "项目（project）", logstores: "日志库（logstore）" };
  return <section ref={value => { root = value; }} class="settings-targets" aria-label="SLS 查询目标">
    <div class="settings-targets-head"><span>查询目标</span><Button size="small" aria-label="添加 SLS 目标" onClick={add}>添加目标</Button></div>
    <For each={targets()}>{(target, index) => <div class="settings-target-row">
      <div class="settings-target-actions"><Button size="small" type="text" danger aria-label={`移除 SLS ${props.deploymentIndex} ${index() + 1}`} disabled={targets().length === 1} onClick={() => emit(targets().filter(value => value !== target))}>移除</Button></div>
      <div class="settings-target-fields"><For each={["name", "region", "project", "logstores"] as const}>{key => <label><span>{labels[key]}</span><Input aria-label={index() === 0 && key !== "name" ? `sls ${key === "logstores" ? "logstore" : key} ${props.deploymentIndex}` : `sls ${key} ${props.deploymentIndex}-${index() + 1}`} value={target[key]} onInput={event => { target[key] = event.currentTarget.value; emit([...targets()]); }} /></label>}</For></div>
    </div>}</For>
  </section>;
}
