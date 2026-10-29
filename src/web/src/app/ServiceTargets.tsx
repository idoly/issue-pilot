import { createSignal, For, untrack } from "solid-js";
import { Button, Input, Select } from "../ui";
import { DBHUB_DATABASES, type DbHubTarget } from "../../../domain/contracts";

type SlsTarget = { name: string; region: string; project: string; logstores: string[] };

function focusNewTarget(root: HTMLElement | undefined) {
  requestAnimationFrame(() => {
    if (!root?.isConnected) return;
    const input = root.querySelector<HTMLInputElement>(".settings-target-row:last-child input");
    input?.focus({ preventScroll: true }); input?.scrollIntoView?.({ block: "nearest" });
  });
}

export function DbHubTargetsEditor(props: { value: DbHubTarget[]; environment: string; onChange(value: DbHubTarget[]): void }) {
  let root: HTMLElement | undefined;
  const [targets, setTargets] = createSignal(untrack(() => props.value.map(value => ({ ...value }))), { ownedWrite: true });
  const emit = (next: DbHubTarget[]) => { setTargets(next); props.onChange(next.map(value => ({ ...value }))); };
  return <section ref={value => { root = value; }} class="settings-targets"><div class="settings-targets-head"><code>DBHub</code><Button size="small" onClick={() => { emit([...targets(), { type: "postgres", host: "", port: 5432, username: "", password: "", database: "" }]); focusNewTarget(root); }}>添加 DBHub</Button></div><p class="settings-target-feedback">支持 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle；DBHub 另支持 SQLite，本页配置远程数据库。</p><For each={targets()}>{(target, index) => <div class="settings-target-row"><div class="settings-target-actions"><Button type="text" danger size="small" aria-label={`移除 DBHub ${props.environment} ${index() + 1}`} onClick={() => emit(targets().filter(value => value !== target))}>移除</Button></div><div class="settings-target-fields"><label><span>数据库类型</span><Select aria-label={`dbhub ${props.environment} ${index() + 1} type`} value={target.type} options={DBHUB_DATABASES.map(database => ({ value: database.value, label: database.label }))} onChange={value => { const database = DBHUB_DATABASES.find(database => database.value === value); if (!database) return; emit(targets().map(value => value === target ? { ...target, type: database.value, port: database.port } : value)); }} /></label><For each={["host", "port", "username", "password", "database"] as const}>{key => <label><span>{key}</span><Input aria-label={`dbhub ${props.environment} ${index() + 1} ${key}`} type={key === "port" ? "number" : "text"} value={target[key]} onInput={event => { Object.assign(target, { [key]: key === "port" ? Number(event.currentTarget.value) : event.currentTarget.value }); emit([...targets()]); }} /></label>}</For></div></div>}</For></section>;
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
  const labels = { region: "地域（region）", project: "项目（project）", logstores: "日志库（logstore，* 表示全部）" };
  return <section ref={value => { root = value; }} class="settings-targets" aria-label="SLS 查询目标">
    <div class="settings-targets-head"><span>查询目标</span><Button size="small" aria-label="添加 SLS 目标" onClick={add}>添加目标</Button></div>
    <For each={targets()}>{(target, index) => <div class="settings-target-row">
      <div class="settings-target-actions"><Button size="small" type="text" danger aria-label={`移除 SLS ${props.deploymentIndex} ${index() + 1}`} disabled={targets().length === 1} onClick={() => emit(targets().filter(value => value !== target))}>移除</Button></div>
      <div class="settings-target-fields"><For each={["region", "project", "logstores"] as const}>{key => <label><span>{labels[key]}</span><Input aria-label={index() === 0 ? `sls ${key === "logstores" ? "logstore" : key} ${props.deploymentIndex}` : `sls ${key} ${props.deploymentIndex}-${index() + 1}`} value={target[key]} onInput={event => { target[key] = event.currentTarget.value; emit([...targets()]); }} /></label>}</For></div>
    </div>}</For>
  </section>;
}
