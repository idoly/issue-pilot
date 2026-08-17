# 部署说明

Issue Pilot只支持单节点Kubernetes部署。应用代码和Node/Pi/Maven/Aliyun工具封装在一个image中；运行时只挂载state和一个私有配置目录。

## 拓扑

```text
TLS/auth Ingress
  -> ClusterIP Service :3000
  -> Deployment issue-pilot, replicas=1, strategy=Recreate
       application image
       hostPath .issue-pilot
       hostPath: Pi/npm/Maven/SSH配置
       emptyDir: /tmp和npm/Maven cache
```

SQLite、bare Git、worktree metadata、Pi JSONL和Attachment存在跨介质关系，因此必须保持单副本。应用不访问Kubernetes API，也不挂载Docker/Podman socket。

## 文件

生产部署只由两个文件定义：

| 文件 | 作用 |
| --- | --- |
| `Containerfile` | 构建application image |
| `deploy/issue-pilot.yaml` | 单副本Deployment和ClusterIP Service |

`Containerfile`包含：

- Node 26、npm和production dependencies。
- Pi CLI。
- Maven 3.9和Temurin 8。
- Git `2.53.0`、SSH、ripgrep和curl；Git从kernel.org固定源码包构建并校验SHA-256，以支持应用生成的relative worktree格式。
- Aliyun CLI `3.4.11`，从官方GitHub release下载并按架构校验SHA-256，用于DMS/SLS。
- 已构建的Solid Web和Workbench。

## 宿主准备

当前manifest使用单节点`hostPath`：

```text
宿主 /var/lib/issue-pilot
  -> 容器 /opt/issue-pilot/.issue-pilot
```

正式部署使用全新state或正式backup，不读取当前checkout中的测试`.issue-pilot`。SQLite和Git worktree metadata会从首次启动开始使用容器内稳定的`/opt/issue-pilot/.issue-pilot`namespace。

目录必须预先存在，归UID/GID 1000所有，并只允许该账号访问：

```bash
install -d -m 0700 -o 1000 -g 1000 /var/lib/issue-pilot
```

给唯一承载state的节点添加标签：

```bash
kubectl label node <node-name> issue-pilot/state=true
```

`nodeSelector`阻止Pod调度到没有该state的节点。不要把`hostPath.type`改为`DirectoryOrCreate`，错误节点或错误路径必须显式失败。

## 运行配置目录

宿主只使用一个私有配置目录`/etc/issue-pilot`，按工具原生层级保存Pi、npm、Maven和Git SSH配置：

```text
/etc/issue-pilot/
  .pi/agent/
    auth.json
    models.json
    models-store.json
  .npmrc
  .m2/settings.xml
  .ssh/
    id_ed25519
    known_hosts
```

准备目录：

```bash
install -d -m 0700 -o 1000 -g 1000 \
  /etc/issue-pilot \
  /etc/issue-pilot/.pi/agent \
  /etc/issue-pilot/.m2 \
  /etc/issue-pilot/.ssh
install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/auth.json" /etc/issue-pilot/.pi/agent/auth.json
install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/models.json" /etc/issue-pilot/.pi/agent/models.json
install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/models-store.json" /etc/issue-pilot/.pi/agent/models-store.json
install -m 0600 -o 1000 -g 1000 "$HOME/.npmrc" /etc/issue-pilot/.npmrc
install -m 0600 -o 1000 -g 1000 "$HOME/.m2/settings.xml" /etc/issue-pilot/.m2/settings.xml
install -m 0600 -o 1000 -g 1000 "$HOME/.ssh/id_ed25519" /etc/issue-pilot/.ssh/id_ed25519
install -m 0600 -o 1000 -g 1000 "$HOME/.ssh/known_hosts" /etc/issue-pilot/.ssh/known_hosts
```

Manifest把该目录整体只读挂到Node image原生HOME `/home/node`，再用emptyDir覆盖`.npm`和`.m2/repository`缓存。这样SSH私钥保持owner-only`0600`，无需Secret复制init container。不要把配置目录写入image、manifest、ConfigMap、environment或日志。

Deployment capability credential仍通过API写入SQLite，不进入该目录。

## 构建

在仓库根目录执行标准容器命令，不需要项目专用构建脚本：

```bash
podman build --pull=always \
  --file Containerfile \
  --tag registry.example.com/issue-pilot:0.1.0 \
  .

podman push registry.example.com/issue-pilot:0.1.0
```

将`deploy/issue-pilot.yaml`中的image改为实际不可变tag或digest，然后部署：

```bash
kubectl create namespace issue-pilot
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=10m
```

## Runtime约束

Manifest保留以下必要条件：

- `replicas: 1`和`strategy: Recreate`，避免两个Pod同时写SQLite/Git。
- UID/GID 1000、non-root、drop all capabilities、RuntimeDefault seccomp。
- Read-only root filesystem。
- 1Gi `/tmp` emptyDir。
- 2Gi npm cache和5Gi Maven cache emptyDir。
- Startup、readiness和liveness `/health` probes。
- 1800秒termination grace period，覆盖最长project action。
- 不automount ServiceAccount token。

不要挂载整个项目目录。应用源码必须来自image；只挂载正式state目录和明确的工具配置/缓存。

## 网络

Service仅在cluster内暴露3000端口。Ingress必须：

- 提供TLS和组织authentication/authorization。
- 禁用SSE response buffering。
- 提供至少1小时read timeout。
- 不记录Config write body、Source body、credential或capability result。

API没有内置认证。浏览器subject只是active user标签；需要可信审计归属时，Ingress或API必须提供可验证身份。

NetworkPolicy应只允许Ingress访问3000，并按实际Repository、Pi provider和capability target限制出站。RabbitMQ/Nacos/Elasticsearch/MySQL/Redis跨不可信网络时必须使用相应安全传输；当前未配置TLS的协议只能位于可信加密网络。

## 日常命令

```bash
kubectl -n issue-pilot get pod,service
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
kubectl -n issue-pilot port-forward service/issue-pilot 3000:3000
kubectl -n issue-pilot delete -f deploy/issue-pilot.yaml
```

删除Deployment不会删除hostPath state。不要手工删除`.issue-pilot`中的数据库、Issue、Git store或Workspace。

## 升级

1. Build/push reviewed image。
2. 在state backup副本dry-run migration。
3. 隔离Ingress流量并等待Agent/Workspace操作结束。
4. 正常停止Pod。
5. 创建一致数据库和完整state backup。
6. 更新manifest image tag/digest。
7. `kubectl apply -f deploy/issue-pilot.yaml`。
8. 等待probes通过。
9. 验证DB、Git/runtime、Attachment、SSE、Source、project tools和capability smoke。

Rollback必须使用matching code image和matching DB/state backup，不能只回退image。

详细备份、恢复和故障处理见[运维手册](RUNBOOK.md)。
