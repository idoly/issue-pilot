# Kubernetes基线与演进边界

本文定义Issue Pilot从Podman Compose迁移到Kubernetes时必须保持的边界。`deploy/kubernetes/base`提供可由Kustomize渲染的单副本应用基线，但当前推荐生产方式仍是[部署说明](DEPLOYMENT.md)中的Compose。基线不包含Ingress、备份、私有镜像凭据或临时Job runner，不能绕过本页验收直接上线。

## 目标拓扑

```text
Ingress / organization authentication
  -> ClusterIP Service
  -> StatefulSet issue-pilot (replicas: 1)
       -> one RWO persistent volume: SQLite, Issue evidence, Git and workspaces
       -> Pi model configuration mounted read-only
       -> ContainerRuntime adapter
            -> short-lived Kubernetes Jobs for Node, Maven and Aliyun CLI
```

Issue Pilot是有状态单体。SQLite、bare Git、worktree metadata、Pi JSONL和附件具有跨介质事务关系，因此Kubernetes阶段仍必须是一个StatefulSet副本。基线使用`OnDelete`更新策略，升级时由Operator先隔离流量、完成备份并确认PVC恢复条件，再删除旧Pod触发新版本；StatefulSet不存在`Recreate`更新策略。在把SQLite、Git workspace和Agent reservation迁移到支持分布式协调的事实源之前，不允许增加replica。

## 应用基线

`deploy/kubernetes/base`包含：

- `ServiceAccount`，不自动挂载API token，也没有RBAC授权。
- `ClusterIP Service`，只暴露容器内`3000`端口。
- 单副本`StatefulSet`和一个`ReadWriteOnce`、50 Gi的PVC；缩容或删除StatefulSet时PVC保持`Retain`。
- 固定UID/GID、只读rootfs、drop all capabilities、RuntimeDefault seccomp和受限`/tmp`。
- `/health`的startup、readiness和liveness probe，以及与Agent关闭预算一致的30分钟termination grace period。
- 可选`issue-pilot-pi-agent`Secret，只读挂到`/home/issue-pilot/.pi/agent`。

基线明确给生产入口传入`--container-runtime=unavailable`。因此主应用、SQLite、Git生命周期、Web和只读Source browser可运行；Node/Maven、DMS和SLS等临时容器请求返回稳定`container_runtime_unavailable`，不会尝试寻找Docker/Podman socket。需要这些能力的Service必须等Job adapter完成后再迁移。

先用根配置中的固定基础镜像、Podman remote版本和SHA-256构建`/opt/issue-pilot`镜像；参数是目标registry引用，不是应用配置覆盖：

```bash
infra/application.sh prepare-kubernetes registry.example.test/internal/issue-pilot:0.1.0
podman push registry.example.test/internal/issue-pilot:0.1.0
```

在overlay中至少替换镜像和PVC storage class，不要直接修改base：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: issue-pilot
resources:
  - ../../base
images:
  - name: localhost/issue-pilot
    newName: registry.example.test/internal/issue-pilot
    newTag: 0.1.0
patches:
  - target:
      kind: StatefulSet
      name: issue-pilot
    patch: |-
      - op: add
        path: /spec/volumeClaimTemplates/0/spec/storageClassName
        value: production-rwo
```

先在临时namespace检查渲染结果，再应用：

```bash
kubectl kustomize deploy/kubernetes/overlays/staging
kubectl apply -k deploy/kubernetes/overlays/staging
```

应用镜像必须用`infra/images/application/Containerfile`的默认`APP_ROOT=/opt/issue-pilot`构建；同一个Containerfile和生产入口供Compose及Kubernetes使用，不维护平台专属应用镜像。PVC固定挂到`/opt/issue-pilot/.issue-pilot`。Pi配置由Operator创建为`issue-pilot-pi-agent`Secret；Deployment credential仍只通过应用API写入PVC中的SQLite，不进入Kubernetes Secret、ConfigMap或环境变量。

## 上线前必做项

1. 实现`ContainerRuntime`的Kubernetes Job adapter，并在生产入口增加明确的adapter选择；不能在Pod中挂Docker/Podman管理socket作为长期方案。
2. Job adapter必须为每次请求创建有TTL的Job，等待完成后删除Job和调用级Secret；超时或abort必须终止Job。
3. Node/Maven Job只挂载目标Issue Repository和对应包管理配置，不挂SQLite、Pi配置、其他Issue目录或集群管理credential。
4. Aliyun Job只接收调用级临时Secret和结构化命令；AccessKey不能进入Job command、label、annotation、event或日志。
5. 为应用ServiceAccount增加最小Role：只能创建、读取、删除带Issue Pilot label的Job、Pod和调用级Secret，不能读取任意Secret。
6. Ingress必须完成组织认证、TLS和SSE禁用buffer。NetworkPolicy只允许Ingress访问应用端口，只允许应用和Job访问明确目标。
7. 用CronJob或存储快照执行一致备份；备份前必须让应用停止写入，不能只复制SQLite主文件。
8. 在临时namespace完成migration副本dry-run、Agent abort、Job timeout、Pod重建、PVC重新挂载和完整恢复演练。
9. 根据真实仓库与构建负载调整PVC、CPU、内存、probe和grace period；base中的数值只是受限起点。

## 不接受的过渡方案

- 多副本共享同一个SQLite和worktree PVC。
- 把完整Deployment credential放入ConfigMap、环境变量、prompt或Agent可见tool input。
- 给应用Pod挂宿主Podman/Docker socket并把它描述为Kubernetes隔离。
- 让Node/Maven/Aliyun Job挂载完整state root。
- 为兼容旧路径在启动时自动移动、猜测或删除state。
- 在Job失败后无限期保留Pod、Secret或日志中的query/credential。
