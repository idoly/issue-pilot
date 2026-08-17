# Kubernetes单容器基线

`deploy/kubernetes/base`是Issue Pilot当前Kustomize基线。它与Compose使用同一application image，但生产推荐仍是[Compose部署](DEPLOYMENT.md)。Kubernetes上线前必须完成存储、Ingress、备份和恢复演练。

## 拓扑

```text
Ingress + organization authentication
  -> ClusterIP Service :3000
  -> StatefulSet issue-pilot, replicas=1
       application image
       one RWO PVC for .issue-pilot
       read-only Pi/package config copied to private emptyDir
       writable npm/Maven cache emptyDir
```

Issue Pilot是有状态单体。SQLite、bare Git、worktree metadata、Pi JSONL和Attachment存在跨介质关系；在这些事实迁移到支持分布式协调的存储前，replica必须为1。

StatefulSet使用`OnDelete`：Operator隔离流量、备份和验证后手工删除旧Pod触发更新。PVC在delete和scale时均Retain。

## Image contract

`infra/images/application/Containerfile`包含：

- Node 26和npm。
- Pi production dependencies和`pi`。
- Maven 3.9/Temurin 8。
- Aliyun CLI latest。
- Fastify、Web/Workbench、Git/SSH、ripgrep、curl和migration。

`ProcessToolRuntime`只允许`npm`、`mvn`、`aliyun dms-enterprise`和`aliyun sls`。执行仍有path authorization、timeout、abort和output budget，但没有独立Pod、rootfs或cgroup。

构建/push标准`/opt/issue-pilot` image：

```bash
infra/application.sh prepare-kubernetes registry.example.test/internal/issue-pilot:0.1.0
podman push registry.example.test/internal/issue-pilot:0.1.0
```

## Base resources

- `ServiceAccount`不automount API token，无RBAC。
- `ClusterIP Service`只暴露port 3000。
- 单副本`StatefulSet`，`OrderedReady`，`OnDelete`。
- 一个50Gi `ReadWriteOnce` PVC，挂到`/opt/issue-pilot/.issue-pilot`。
- UID/GID 1000、non-root、readonly rootfs、drop all capabilities、RuntimeDefault seccomp。
- 1Gi `/tmp` emptyDir。
- Startup/readiness/liveness `/health` probes。
- 1800s termination grace period。
- Main container request 1CPU/1Gi，limit 4CPU/4Gi。
- 2Gi npm cache和5Gi Maven cache emptyDir。

Init container从Secret复制配置到16MiB private runtime-home：

- Optional `issue-pilot-pi-agent` -> `~/.pi/agent`
- Required `issue-pilot-package-config` -> `~/.npmrc`和Maven settings

Directory设`0700`，file设`0600`，main container只读挂载。Deployment business credential仍通过API写入PVC SQLite，不进入Secret、ConfigMap或environment。

创建：

```bash
kubectl create namespace issue-pilot
kubectl -n issue-pilot create secret generic issue-pilot-pi-agent \
  --from-file="$HOME/.pi/agent"
kubectl -n issue-pilot create secret generic issue-pilot-package-config \
  --from-file="npmrc=$HOME/.npmrc" \
  --from-file="maven-settings.xml=$HOME/.m2/settings.xml"
```

## Overlay

至少替换image、namespace和storage class，不直接编辑base：

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

```bash
kubectl kustomize deploy/kubernetes/overlays/staging
kubectl apply -k deploy/kubernetes/overlays/staging
```

Base仓库当前只包含`deploy/kubernetes/base`；overlay由部署环境维护。

## Ingress和NetworkPolicy

Ingress必须：

- 执行组织authentication/authorization和TLS。
- 禁用SSE response buffering并提供长read timeout。
- 不记录Config write body、Source body或capability result。

NetworkPolicy只允许Ingress访问port 3000，并按实际Repository、Pi provider和capability target限制出站。Application不需要Kubernetes API访问。

## Upgrade

1. Build/push reviewed image。
2. 在临时namespace用backup副本dry-run migration。
3. 隔离production Ingress流量。
4. 等待Agent/Workspace operation结束并正常终止Pod。
5. 创建一致PVC snapshot或完整backup。
6. 更新image overlay。
7. 手工删除旧Pod。
8. 等待startup/readiness通过。
9. 验证DB、Git/runtime、Attachment、SSE、Source和capability smoke。

不要只在线复制SQLite主文件。Rollback必须使用matching code和matching DB/state backup。

## 上线验收

- Storage支持RWO、stable inode、file mode、symlink和Git worktree语义。
- PVC容量覆盖state和peak dev workspace；cache容量覆盖build。
- Pod重建后PVC可重新挂载，runtime/checkouts可受管恢复。
- Grace period覆盖30分钟project action。
- Migration failure保留Pod log和PVC evidence。
- 完成Agent abort、project timeout、Pod restart、PVC restore和full recovery演练。
- 生产只运行可信Repository；同UID project script可读取该UID可读state/config。

## 禁止方案

- 多副本共享SQLite/worktree PVC。
- 挂Docker/Podman socket或授予Kubernetes API RBAC。
- 为Node/Maven/Aliyun动态创建Job/Pod。
- 把Deployment credential放入ConfigMap、environment、prompt或tool input。
- 启动时自动移动、猜测或删除旧state。
- 把application container称为untrusted code sandbox。
