# Ant Design Solid集成问题与框架建议

本文整理Issue Pilot使用`@idoly/ant-design-solid`时实际遇到的问题，并区分框架责任、可选框架改进和应用责任。目标是给框架维护者提供可复现、可验收的反馈，不把产品状态管理、业务校验或定制视觉误报为组件库缺陷。

## 基线

- 组件库：`@idoly/ant-design-solid@0.2.4`
- 组件库声明的Solid peer：`solid-js@2.0.0-beta.29`、`@solidjs/web@2.0.0-beta.29`
- Issue Pilot运行时：`solid-js@2.0.0-rc.0`、`@solidjs/web@2.0.0-rc.0`
- 构建工具：Vite 8、TypeScript 7、`vite-plugin-solid@3.0.0-next.27`
- 实际使用组件：ConfigProvider、Layout、Badge、Button、Input、TextArea、Modal、Segmented、Select、Skeleton、Switch、Tag
- 使用规模：16个Select、8个Modal、17个Input/TextArea调用点
- 验证环境：桌面和移动浏览器验收、Vitest/jsdom、TypeScript typecheck、Vite production build

优先级定义：

- P1：会迫使业务代码绕过组件公开API，或使正常安装/升级不可靠。
- P2：不会直接阻断功能，但持续增加类型、防回归或维护成本。
- P3：可选的开发体验改善。

## 应由框架解决

### 1. P1：Solid peer版本与实际生态版本不一致

#### 现象

`0.2.4`的`peerDependencies`精确声明为Solid `2.0.0-beta.29`，Issue Pilot升级到`2.0.0-rc.0`后，npm不能把当前运行时视为受支持版本。项目只能加入package-level override：

```json
{
  "overrides": {
    "@idoly/ant-design-solid": {
      "@solidjs/web": "2.0.0-rc.0",
      "solid-js": "2.0.0-rc.0"
    }
  }
}
```

`npm ls`显示组件库最终被强制复用RC运行时。当前应用测试和构建通过，但这是消费方覆盖上游兼容声明，不是组件库提供的兼容保证。

#### 为什么属于框架

组件库决定其编译基线和peer支持范围。消费方无法可靠判断beta到RC之间是否存在运行时、JSX编译或hydration不兼容，也不应该长期通过override替框架做这个承诺。

#### 建议

1. 在支持Solid RC的组件库版本中，以RC版本重新执行typecheck、unit、SSR/hydration和跨浏览器测试。
2. 更新`peerDependencies`为实际验证过的范围，避免无依据的宽泛`>=2`。
3. 让组件库自身的`solid-js`、`@solidjs/web`、`babel-preset-solid`和`vite-plugin-solid`编译基线一致。
4. 在CHANGELOG中明确每个组件库版本验证过的Solid版本。

#### 验收标准

- 新建项目安装Solid RC和组件库时无需`overrides`或`--legacy-peer-deps`。
- npm只解析出一份`solid-js`和一份`@solidjs/web`。
- CSR、SSR、hydration、portal、controlled input和context测试通过。

### 2. P1：多选Select打开后无法通过选择器空白区域切换关闭

#### 现象

受控的`Select mode="multiple"`打开后，再点击选择器空白区域只会继续请求打开，不会请求关闭。Issue Pilot为了得到常规的toggle交互，必须在Select外层capture原生事件：

```ts
export function bindMultipleSelectBlankToggle(
  element: HTMLDivElement,
  setOpen: (open: boolean) => void,
): void {
  let blankWasOpen = false;
  element.addEventListener("mousedown", (event) => {
    blankWasOpen = event.target instanceof HTMLElement
      && event.target.classList.contains("ads-select-selector")
      && element.querySelector('[role="combobox"]')?.getAttribute("aria-expanded") === "true";
  }, { capture: true });
  element.addEventListener("click", (event) => {
    if (blankWasOpen) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    blankWasOpen = false;
  }, { capture: true });
}
```

这个规避方式依赖内部类名、内部ARIA节点和事件顺序，在组件重构后容易静默失效。

组件库当前根点击逻辑等价于：

```ts
onClick: () => {
  input?.focus();
  setOpen(true);
}
```

因此无论当前状态如何，选择器点击都不会触发`onOpenChange(false)`。

#### 最小复现

```tsx
const [open, setOpen] = createSignal(false);

<Select
  mode="multiple"
  open={open()}
  onOpenChange={setOpen}
  value={[]}
  options={[{ value: "a", label: "A" }]}
/>
```

1. 点击选择器，收到`onOpenChange(true)`。
2. 再点击非tag、非remove、非clear的选择器空白区域。
3. 预期收到`onOpenChange(false)`，实际仍保持打开。

#### 为什么属于框架

打开/关闭、focus、outside click、Escape和选项选择属于Select状态机。应用不应识别内部DOM才能补全基本交互。

#### 建议行为

- 点击箭头或非交互的selector空白区域时切换`!open`。
- 点击搜索输入、tag移除、clear和具体选项时遵循各自动作，不误关闭。
- controlled模式只发出`onOpenChange(next)`，不私自改变可见状态。
- uncontrolled模式同步更新内部状态。
- pointer、keyboard和touch行为一致。

#### 验收标准

覆盖单选/多选、controlled/uncontrolled、`showSearch`、tag remove、allowClear、Escape、outside pointerdown及移动触摸测试。Issue Pilot应能删除`bindMultipleSelectBlankToggle()`及其`.ads-select-selector`依赖。

### 3. P2：Select类型不随模式和选项收窄

#### 现象

`SelectProps.onChange`固定为以下宽联合：

```ts
(value:
  | SelectValue
  | LabeledValue
  | (SelectValue | LabeledValue)[]
  | undefined,
 option: SelectOption | SelectOption[] | undefined,
) => void
```

即使调用点明确满足以下条件，回调仍然得到完整联合：

- `mode`未设置；
- `labelInValue`未设置或为false；
- `options`全部是字符串value；
- `value`是明确的字符串字面量联合。

Issue Pilot因此在多数Select调用点重复使用`selectedChoice()`；多选还要使用`selectedStrings()`重新过滤数组。16个Select中，业务代码反复做`typeof value === "string"`、数组判断和允许值查找。

#### 为什么属于框架

由`mode`、`labelInValue`和option value类型决定的返回shape是组件公开合同。框架类型不表达这个合同，会把本可在编译期完成的检查推给每个消费方。

应用仍应校验“该值是否属于当前业务允许集合”，但不应重复判断单值、数组和`LabeledValue`三种互斥shape。

#### 建议

将Props设计为泛型和可判别联合，至少区分：

```ts
// default
onChange?: (value: Value | undefined, option: Option | undefined) => void;

// mode="multiple"
onChange?: (value: Value[], option: Option[]) => void;

// labelInValue
onChange?: (value: LabeledValue<Value> | undefined, option: Option | undefined) => void;

// mode="multiple" + labelInValue
onChange?: (value: LabeledValue<Value>[], option: Option[]) => void;
```

`options`、`value/defaultValue`、`onSelect/onDeselect`和`labelRender`应共享同一个`Value`/`Option`泛型，避免只收窄`onChange`。

#### 验收标准

- 字符串字面量options能推导回调value类型。
- 单选回调不包含数组，普通模式不包含`LabeledValue`。
- 多选回调不包含单值或`undefined`。
- `labelInValue`组合有类型测试。
- 现有非泛型调用保持源码兼容或有明确迁移说明。

### 4. P2：发布包README链接到未发布文件

#### 现象

npm包内README要求查看：

```md
[COVERAGE.md](./COVERAGE.md)
[COMPATIBILITY.md](./COMPATIBILITY.md)
```

但`package.json.files`只发布`dist`和`CHANGELOG.md`；实际安装目录只有README、CHANGELOG、LICENSE、package.json和dist，两份目标文档不存在。

#### 为什么属于框架

这是发布物完整性问题。消费方从npm安装后无法读取README声明的兼容差异和能力覆盖，而这两份文档恰好是评估迁移风险所需的信息。

#### 建议及验收

- 将`COVERAGE.md`和`COMPATIBILITY.md`加入npm发布文件，或把README链接改成带版本/commit的仓库URL。
- 在`npm pack --dry-run`或`check:package`中验证README所有相对链接存在。
- 从实际`.tgz`解包后执行链接完整性测试，而不是只检查源码工作树。

## 可以由框架改善，但不是当前缺陷

### 5. P3：提供可选聚合样式入口

当前组件库要求消费方显式导入`base.css`和每个组件样式。Issue Pilot入口有13条样式import；组件增删后容易留下无用样式或漏掉新增组件的样式依赖。

组件级CSS有明确的按需加载收益，因此不建议取消。可以额外提供：

```ts
import "@idoly/ant-design-solid/styles.css";
```

它适合内部工具、原型和对包体不敏感的应用。组件级入口继续作为推荐的生产优化方式。聚合入口应由构建生成，不能手工维护第二份组件清单。

这属于开发体验改进，不是功能缺陷，因为当前行为已经在README中明确说明，组件样式也包含其传递依赖。

## 不应归给框架的问题

### 长Modal固定header/footer

Issue Pilot对新建工单和服务配置Modal增加了`max-height`、body滚动及固定footer。组件库默认Modal root本身可纵向滚动，操作按钮仍可通过页面滚动到达，因此当前没有证据证明默认Modal不可用。

“容器不移动、只滚body”是本产品的密集表单体验选择。Modal已经提供`classNames`和`styles`语义槽，应用应优先改用：

```tsx
<Modal
  classNames={{ container: "service-modal", body: "service-modal-body" }}
/>
```

而不是继续用`:has(.service-form)`和`.ads-modal-*`内部选择器。只有在默认Modal的小屏footer确实不可达、focus trap越界或scroll lock错误时，才应另报框架bug。

### 业务主题和响应式尺寸

Header中的Segmented配色、Workbench暗色Button/Tag、Select宽度、长用户标签截断和移动端用户选择器都属于Issue Pilot视觉与布局。框架已经提供theme token、`classNames`、`styles`、`labelRender`和`popupMatchSelectWidth`，不需要为单个产品内置这些规则。

### 配置表单输入焦点和draft所有权

配置页为了避免父级数组更新重建行、丢失输入焦点，为每行维护局部signal并向父级发snapshot。这个问题涉及应用的列表identity、Solid store proxy和更新粒度，不是Input组件缺陷。Input在稳定挂载时能保持DOM节点、焦点和受控值。

### Solid store不能直接structuredClone

Solid store是Proxy，`structuredClone(store)`抛出异常。项目改用Solid 2的`snapshot(store)`。这属于Solid状态容器合同，与Ant Design Solid无关。

### Domain value校验

即使Select类型按模式收窄，应用仍必须确认环境、状态、模型等value属于当前服务端catalog。类型改进可以删除shape防御，但不能替代业务授权和动态集合校验。

## 推荐处理顺序

1. 修复多选Select selector toggle，并加入浏览器行为测试。
2. 发布与Solid RC一致的组件库版本，移除消费方peer override。
3. 重构Select泛型/可判别类型，并增加类型测试。
4. 修正npm发布包内README死链接。
5. 评估是否增加可选聚合样式入口。

Issue Pilot侧在框架修复后应删除多选DOM补丁和peer override，并逐步把针对`.ads-modal-*`、`.ads-select-*`内部节点的定制迁移到公开semantic slots。
