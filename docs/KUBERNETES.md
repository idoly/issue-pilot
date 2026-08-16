# Kubernetes单容器基线

`deploy/kubernetes/base`提供可由Kustomize渲染的单副本Issue Pilot基线。它与Compose使用同一个application大镜像；Pod内不挂Docker/Podman socket，不创建Node、Maven或Aliyun Job，也不需要Kubernetes API RBAC。当前推荐生产方式仍是[部署说明](DEPLOYMENT.md)中的Compose；Kubernetes上线前必须完成本页的存储、备份、Ingress和恢复验收。

## 拓扑

```text
Ingress / organization authentication
  -> ClusterIP Service
  -> StatefulSet issue-pilot (replicas: 1)
       -> application image
            Fastify + Web/Workbench + Pi
            Node/npm + Maven/JDK + Aliyun CLI
       -> one RWO PVC: SQLite, Issue evidence, Git and workspaces
       -> read-only Pi and package-manager Secrets
       -> writable npm/Maven cache emptyDir
```

Issue Pilot是有状态单体。SQLite、bare Git、worktree metadata、Pi JSONL和附件具有跨介质事务关系，因此Kubernetes阶段仍必须是一个StatefulSet副本。基线使用`OnDelete`更新策略；升级时由Operator先隔离流量、完成备份并确认PVC恢复条件，再删除旧Pod触发新版本。在把SQLite、Git workspace和Agent reservation迁移到支持分布式协调的事实源之前，不允许增加replica。

## 大镜像合同

`infra/images/application/Containerfile`的最终镜像包含：

- Node `26`和随镜像提供的npm。
- Pi生产依赖和`pi`命令。
- Maven `3.9`和Eclipse Temurin `8`。
- 构建时获取的Aliyun CLI latest。
- Fastify API、静态Web/Workbench、Git/SSH、ripgrep、curl和migration。

Node和Maven使用Containerfile中的稳定系列tag；Aliyun CLI按目标架构获取官方latest包。application镜像使用唯一的`ProcessToolRuntime`，只允许镜像PATH中的`npm`、`mvn`和`aliyun dms-enterprise/sls`命令。每次调用仍有路径授权、只读配置挂载、timeout、abort和输出预算，但不会获得独立Pod、rootfs或cgroup。

构建并推送`/opt/issue-pilot`镜像：

```bash
infra/application.sh prepare-kubernetes registry.example.test/internal/issue-pilot:0.1.0
podman push registry.example.test/internal/issue-pilot:0.1.0
```

## 基础资源

`deploy/kubernetes/base`包含：

- 不自动挂API token、无RBAC授权的`ServiceAccount`。
- 只暴露容器`3000`端口的`ClusterIP Service`。
- 单副本`StatefulSet`和一个`ReadWriteOnce`、50 Gi PVC；缩容或删除时PVC保持`Retain`。
- 固定UID/GID、只读rootfs、drop all capabilities、RuntimeDefault seccomp和受限`/tmp`。
- `/health`的startup、readiness、liveness probe和30分钟termination grace period。
- 可选`issue-pilot-pi-agent`Secret和必需`issue-pilot-package-config`Secret；同镜像init container把只读Secret复制到16 MiB `emptyDir`，以运行UID创建`0600`配置后再供主容器只读挂载。
- Pod生命周期内的2 Gi npm cache和5 Gi Maven cache；需要跨Pod保留时由overlay替换为PVC。

创建namespace和配置Secret：

```bash
kubectl create namespace issue-pilot
kubectl -n issue-pilot create secret generic issue-pilot-pi-agent \
  --from-file="$HOME/.pi/agent"
kubectl -n issue-pilot create secret generic issue-pilot-package-config \
  --from-file="npmrc=$HOME/.npmrc" \
  --from-file="maven-settings.xml=$HOME/.m2/settings.xml"
```

Deployment数据库credential仍只通过应用API写入PVC中的SQLite，不进入Kubernetes Secret、ConfigMap或环境变量。

## Overlay

至少替换镜像和PVC storage class，不直接修改base：

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

## 上线前验收

1. PVC必须支持`ReadWriteOnce`和稳定inode/权限语义；SQLite、Git和workspace固定挂到`/opt/issue-pilot/.issue-pilot`。
2. Ingress必须完成组织认证、TLS和SSE禁用buffer；NetworkPolicy只允许Ingress访问应用端口，并按Service依赖限制Pod出站。
3. 使用CronJob或存储快照执行一致备份；备份前必须停止应用写入，不能只复制SQLite主文件。
4. 在临时namespace完成migration副本dry-run、Agent abort、Node/Maven超时、Pod重建、PVC重新挂载和完整恢复演练。
5. 根据真实构建负载调整PVC、cache、CPU、内存、probe和grace period；base数值只是受限起点。
6. 生产大容器只适用于可信内部Repository。npm/Maven项目脚本与API使用同一UID，能读取该UID可读的应用state和配置；不可信代码必须使用另行实现的独立sandbox。

## 不接受的方案

- 多副本共享同一个SQLite和worktree PVC。
- 给应用Pod挂宿主Docker/Podman socket。
- 把完整Deployment credential放入ConfigMap、环境变量、prompt或Agent可见tool input。
- 为兼容旧路径在启动时自动移动、猜测或删除state。
- 把大容器内嵌执行描述成不可信代码sandbox。
