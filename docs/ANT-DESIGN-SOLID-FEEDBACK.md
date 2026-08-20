# Ant Design Solid集成反馈

本文记录Issue Pilot升级`@idoly/ant-design-solid`后的源码核对、应用迁移和仍需上游处理的问题。它只讨论组件库边界，不复制项目架构或业务状态合同。

## 当前基线

- 组件库：`@idoly/ant-design-solid@0.3.0-rc.0`
- Solid：`solid-js@2.0.0-rc.0`、`@solidjs/web@2.0.0-rc.0`
- 构建：Vite 8、TypeScript 7、`vite-plugin-solid@3.0.0-next.27`
- Monaco VS Code：`36.1.1`
- 使用组件：ConfigProvider、Layout、Badge、Button、Input、TextArea、Modal、Segmented、Select、Skeleton、Switch、Tag
- 使用规模：18个Select、8个Modal、43个Input/TextArea调用点
- 验证：Vitest/jsdom、TypeScript、production build、桌面和移动浏览器

## 升级结论

### 已解决：Solid peer一致

`0.3.0-rc.0`精确声明并使用Solid `2.0.0-rc.0`。Issue Pilot已删除针对组件库的package-level Solid override，`npm ls`只解析一份`solid-js`和`@solidjs/web`。

`@solidjs/testing-library@1.0.0-beta.2`仍声明`>=2.0.0`；semver不把RC视为稳定版范围成员，因此测试库override暂时保留。这不再是Ant Design Solid的问题。

### 已解决：多选Select toggle

受控多选Select现在会在选择器空白区域和箭头上切换展开状态。Issue Pilot已删除依赖`.ads-select-selector`、combobox ARIA节点和capture事件顺序的`bindMultipleSelectBlankToggle()`补丁，并让Select自行管理popup状态。

### 已解决：Select类型收窄

Select现在根据options、`mode`和`labelInValue`推断value及callback：

- 单选不再返回数组。
- `mode="multiple"`回调直接得到类型化数组。
- option字面量能收窄value union。
- labels和tags组合有独立类型。

Issue Pilot已删除`selectedStrings(unknown, current)`。统计周期改为`"7d" | "30d" | "90d"`并由options贯穿到`onChange`。动态服务端catalog仍使用`selectedChoice()`验证业务允许集合；这是授权校验，不是Select shape兼容代码。

### 已解决：聚合样式

`0.3.0-rc.0`发布正式的`./styles.css`导出，包含base reset、tokens、StyleX资产和全部组件样式。Issue Pilot已用：

```ts
import "@idoly/ant-design-solid/styles.css";
```

替换`base.css`和13个组件样式import。组件级`<component>/style.css`仍适合需要CSS拆分的应用。

### 已解决：npm发布文档

实际`0.3.0-rc.0` tarball包含`CHANGELOG.md`、`COMPATIBILITY.md`和`COVERAGE.md`，README相对链接可解析。

## 当前上游问题

### P2：`autoInsertSpaceInButton`声明未接入运行时

`ConfigProviderProps`公开：

```ts
autoInsertSpaceInButton?: boolean;
```

但发布包`ConfigProvider`运行时构造context时没有读取这个prop。Button的默认值来自：

```ts
componentDefaults("button")
```

因此下面的公开API不会关闭双汉字按钮间距：

```tsx
<ConfigProvider autoInsertSpaceInButton={false}>
  <Button>保存</Button>
</ConfigProvider>
```

Issue Pilot只能使用组件默认配置：

```tsx
<ConfigProvider button={{ autoInsertSpace: false }}>
  <Button>保存</Button>
</ConfigProvider>
```

这个替代方案基于公开API且可工作，但顶层prop的声明与实现不一致。

#### 建议修复

将Button默认值计算为显式组件配置优先、顶层兼容prop次之、内层provider/default最后，例如：

```ts
componentDefaults("button").autoInsertSpace
  ?? props.autoInsertSpaceInButton
  ?? parentDefaults.autoInsertSpace
```

需要覆盖嵌套ConfigProvider、显式Button prop、CSR、SSR/hydration和双汉字可访问名称测试。

#### 验收标准

- `autoInsertSpaceInButton={false}`同时影响视觉文本和accessible name。
- Button自身`autoInsertSpace`优先于provider。
- 嵌套provider按最近值覆盖。
- 声明、README示例和运行时行为一致。

## 应用责任

以下行为继续由Issue Pilot维护：

- 动态environment/service/model值必须重新对照服务端catalog。
- 密集Modal的body滚动和固定操作区属于产品布局。
- Header、Workbench、长标签和移动端宽度属于产品视觉。
- 配置表单draft identity和输入焦点属于Solid状态所有权。
- `snapshot(store)`替代`structuredClone(proxy)`属于Solid合同。

应用定制优先使用`classNames`、`styles`、theme token和组件defaults，不新增对内部StyleX类名的依赖。

## 后续升级检查

1. 核对组件库peer与项目Solid编译/runtime版本。
2. 解包npm tarball检查exports、README链接和聚合CSS。
3. 对比实际使用组件的`.d.ts`和浏览器实现。
4. 运行typecheck，让Select等泛型变化形成迁移清单。
5. 运行Web测试和production build。
6. 浏览器验收Select、Modal、Switch、Button、移动布局和Workbench。
7. 运行`npm ls`与production audit，拒绝重复Solid runtime和高危依赖。
