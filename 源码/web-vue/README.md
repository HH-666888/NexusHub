# NexusHub Vue 前端

已完成 9 个用户页面的 Vue 3 迁移：

| 页面 | 路由 | 实现 |
|---|---|---|
| 设置 | `/settings/` | Vue 状态组件（TS） |
| 登录 | `/login/` | Vue 状态组件（TS） |
| 注册 | `/register/` | Vue 状态组件（TS） |
| 项目 | `/projects/` | Vue 状态组件（TS） |
| 记忆 | `/memory/` | Vue 状态组件（TS） |
| 辅助项目列表 | `/assist/` | Vue 状态组件（TS） |
| 欢迎 | `/welcome/` | Vue 结构 + welcome-long.ts 滚动叙事 |
| 辅助工作台 | `/assist/workspace/` | Vue 状态组件 + useWorkspace 组合式函数（TS） |
| 工作台 | `/workbench/` | Vue 组件 + useWorkbenchStore/Tree/Run（TS） |

辅助工作台已经去掉命令式控制器，拆成 StageRail、PlanStage、CodeStage、CodeEditor、TestsPanel、DeliverPanel、FindingsPanel、CoachPanel，状态集中在 `useWorkspace`。

工作台拆成 TaskPanel、TaskDetail、CanvasPanel、CodePane、StatusBar、GateModal；任务、阶段、进度、文件、代码、树节点/SVG、门禁、参考依据、预览/验收都由 Vue 组件渲染，状态集中在 `useWorkbenchStore`。

树布局是 `useWorkbenchTree` 的纯函数，SSE/run 数据层是 `useWorkbenchRun`，任务/文件模型是 `workbenchModel`。`engine/tree.js` 已删除，`window.__wb` 全局边界也已移除。树内容在画布可用区域内垂直居中，根节点中心对齐画布中心。

点击根节点“主控 Agent”会打开新建任务对话框：填写开发需求、可选上传文本/代码文档，提交后把需求与文档正文合并成 prompt，调用真实 `POST /api/runs` 创建新运行。运行一旦已有 prompt，再点主控只会展示当前需求和已提交文档，不能再修改。

文档支持一次多选或拖拽，逐份展示文件名、字符数，可展开查看正文；合并时保留 `===== 文档：文件名 =====` 边界。单个文件最大 512KB，需求与文档合计最多 12 万字符。

## 开发

```bash
pnpm install
pnpm dev
```

开发服务器只用于调试已迁移页面；接口仍指向上游 FastAPI。

## 构建

```bash
pnpm build
```

构建输出到 `源码/web/vue-dist`：

- 各页面 `index.html`
- `vue-assets/*.js`
- `vue-assets/*.css`

FastAPI 在 `源码/backend/app/main.py` 中挂载：

- `/vue-assets` → `web/vue-dist/vue-assets`
- `/settings`、`/login`、`/register`、`/projects`、`/memory`、`/welcome`、`/workbench` → 各自目录
- `/assist/` → 辅助项目列表；`/assist/workspace` → 辅助工作台

构建产物不存在时自动退回 `源码/web` 原页面。

## 类型检查

```bash
pnpm typecheck
```

- `tsconfig.json`：`strict: true`
- `allowJs: true`、`checkJs: false`
- 入口脚本、六个业务组件、欢迎页壳、`useWorkspace`、`useWorkbenchStore/Tree/Run` 为 TypeScript
- `engine/tree.js` 是任务/文件模型与少量 appbar 辅助，仍是 JavaScript；欢迎页滚动脚本也是 JavaScript
- 这是增量 TS 的真实边界，没有把 JS 改后缀冒充全量类型化
- 当前 `vue-tsc --noEmit` 零错误

## 迁移验收

- 9 个页面 × 1440/1920/390，共 27 张截图；26/27 与 `pre-vue-migration` 基线字节级一致
- 唯一差异：欢迎页 1920 的卡片动画帧，差异区域仅卡片内容，无布局位移；其余 26 张字节相同
- 所有页面控制台零异常、无 404/500
- 证据：`源码/docs/screenshots/vue-migration/stage6-full-diff.txt`
- 基线：`源码/web-baseline-20261114`（本机对比副本已删除）
- Git 标签：`pre-vue-migration`

## 约束与已知边界

- 主控对话框目前只读取纯文本/代码文档；PDF、Word 等二进制文档还没有解析，会明确提示不支持。

- 不借迁移改视觉、文案和布局。
- 只使用真实接口；空态只用 `— / 暂无 / 加载中…`。
- 工作台模型、SSE、树布局、任务、代码、门禁、依据、页签都由 TypeScript 状态层驱动。
- 不改成 SPA；保持现有 URL 和多页静态托管。
- 工作台的 CSS 交给 Vite 原样输出（关闭 lightningcss 压缩），避免动画 CSS 压缩报错。