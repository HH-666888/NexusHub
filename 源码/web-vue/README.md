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
| 欢迎 | `/welcome/` | Vue 静态结构 + 原滚动叙事脚本 |
| 辅助工作台 | `/assist/workspace/` | Vue 状态组件 + useWorkspace 组合式函数（TS） |
| 工作台 | `/workbench/` | Vue 布局组件 + 独立树/SSE 引擎 |

辅助工作台已经去掉命令式控制器，拆成 StageRail、PlanStage、CodeStage、CodeEditor、TestsPanel、DeliverPanel、FindingsPanel、CoachPanel，状态集中在 `useWorkspace`。

工作台拆成 TaskPanel、TaskDetail、CanvasPanel、CodePane、StatusBar；树布局与 SSE 被隔离在 `workbench/engine`，通过 `window.__wb` 的类型声明与页面层衔接。这是图形渲染引擎的正常边界，但它还没有变成完全状态驱动的 Vue 组件树，属于下一步边界。

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
- 入口脚本、六个业务组件、欢迎/工作台页壳、`useWorkspace` 为 TypeScript
- 工作台树/SSE 引擎与欢迎页滚动脚本仍为 JavaScript；这是增量 TS 的边界，没有伪装成全量类型化
- 当前 `vue-tsc --noEmit` 零错误

## 迁移验收

- 9 个页面 × 1440/1920/390，共 27 张截图；25/27 与 `pre-vue-migration` 基线字节级一致
- 剩余 2 张：欢迎页 1920 的卡片动画帧差异、辅助工作台 390 的顶栏文字抗锯齿差异，均为亚像素/动画状态，无布局位移
- 所有页面控制台零异常、无 404/500
- 证据：`源码/docs/screenshots/vue-migration/stage6-full-diff.txt`
- 基线：`源码/web-baseline-20261114`（本机对比副本已删除）
- Git 标签：`pre-vue-migration`

## 约束与已知边界

- 不借迁移改视觉、文案和布局。
- 只使用真实接口；空态只用 `— / 暂无 / 加载中…`。
- 工作台树/SSE 引擎仍是命令式 JS，下一步可继续拆成组合式函数/状态组件。
- 不改成 SPA；保持现有 URL 和多页静态托管。
- 工作台的 CSS 交给 Vite 原样输出（关闭 lightningcss 压缩），避免动画 CSS 压缩报错。