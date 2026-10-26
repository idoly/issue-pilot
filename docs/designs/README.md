# 历史设计资料

[文档导航](../README.md) · [当前使用指南](../USAGE.md) · [当前界面](../images/README.md)

本目录保存阶段原型和当时的验收截图。原型可能使用自己的演示数据与浏览器存储，界面和事务保证不代表现版实现；不要用原型保存状态判断生产配置是否已生效。

| 资料 | 历史用途 |
| --- | --- |
| [配置改造方案](configuration-management.md) | 页面配置落地时的字段与事务设计，部分交互已被后续版本替换 |
| [可点击配置原型](configuration-prototype.html) | 早期交互评审，不连接真实 API |
| [配置原型截图](configuration-preview/index.html) | 原型阶段的桌面／手机截图 |
| [前端美化前后对照](frontend-polish-preview/index.html) | 某次界面改造前后对比，保留原截图作为证据 |

现版配置为“用户 → 仓库 → 服务 → 端点”；环境能力收起显示标签，展开原位切换为 MySQL／DMS／SLS 复选框。现版截图统一在 `docs/images/` 更新，本目录不覆盖旧截图。
