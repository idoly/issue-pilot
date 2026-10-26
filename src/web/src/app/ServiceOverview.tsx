import { For, Show } from "solid-js";
import type { ManagedRepository, Service } from "../data/client";
import { GitBranch } from "../ui/icons";
import { Markdown } from "../ui/Markdown";

export function ServiceOverview(props: { service: Service; configurationDescription?: string | undefined; repositories: ManagedRepository[]; environments: Array<{ key: string; name: string }> }) {
  const description = () => props.configurationDescription ?? props.service.context ?? props.service.description;
  const environments = () => ["dev", "test", "prod"].filter(key => props.service.deployments.some(deployment => deployment.environmentKey === key));
  const repositoryName = (url: string) => props.repositories.find(repository => repository.url === url)?.name ?? url;
  const branch = (id: string, environment: string) => props.service.deployments.find(deployment => deployment.environmentKey === environment)?.repositoryBranches.find(row => row.repositoryId === id)?.baseBranch;
  const columns = () => `minmax(150px, 1fr) repeat(${environments().length}, minmax(140px, .7fr))`;
  return <article class="service-detail" aria-label="服务描述">
    <header class="service-overview-header"><h2>代码分支</h2></header>
    <section class="service-repositories" aria-label="仓库与环境分支"><div class="service-repository-matrix" style={{ "grid-template-columns": columns(), "min-width": `${150 + environments().length * 140}px` }}>
      <span class="repository-column-heading">仓库</span><For each={environments()}>{key => <span class="repository-column-heading">{props.environments.find(row => row.key === key)?.name ?? key}</span>}</For>
      <For each={props.service.repositories}>{repository => <><span class="service-repository-name" title={repository.url}><GitBranch size={14} /><span>{repositoryName(repository.url)}</span></span><For each={environments()}>{key => <code class="service-repository-branch" title={branch(repository.id, key) ?? "未配置"}>{branch(repository.id, key) ?? "—"}</code>}</For></>}</For>
    </div></section>
    <section class="service-detail-section service-description-section"><div class="service-detail-heading"><h3>服务描述</h3></div><Show when={description().trim()} fallback={<p class="service-description">暂无描述</p>}>
      <div class="service-description"><Markdown source={description()} cache={props.configurationDescription === undefined} /></div>
    </Show></section>
  </article>;
}
