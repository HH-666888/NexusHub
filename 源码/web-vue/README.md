# NexusHub Vue 前端

已完成 9 个用户页面的 Vue 3 迁移：

| 页面 | 路由 | 实现 |
|---|---|---|
| 设置 | `/settings/` | Vue 状态组件 |
| 登录 | `/login/` | Vue 状态组件 |
| 注册 | `/register/` | Vue 状态组件 |
| 项目 | `/projects/` | Vue 状态组件 |
| 记忆 | `/memory/` | Vue 状态组件 |
| 辅助项目列表 | `/assist/` | Vue 状态组件 |
| 欢迎 | `/welcome/` | Vue 静态结构 + 原滚动叙事脚本 |
| 辅助工作台 | `/assist/workspace/` | Vue 结构壳 + 原工作台控制器 |
| 工作台 | `/workbench/` | Vue 结构壳 + 原树布局/SSE 控制器 |

复杂交互页采用“Vue 接管结构、原控制器挂在 Vue DOM 上”的渐进迁移方式，没有把旧页面塞进 iframe，也没有用假 DOM 壳。

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
- 入口脚本和三个复杂页壳组件为 TypeScript
- 六个业务组件与三个原控制器仍为 JavaScript；这是增量 TS 的边界，没有伪装成全量类型化
- 当前 `vue-tsc --noEmit` 零错误

## 迁移验收

- 9 个页面 × 1440/1920/390，共 27 张截图与 `pre-vue-migration` 基线字节级一致
- 所有页面控制台零异常、无 404/500
- 证据：`源码/docs/screenshots/vue-migration/stage6-full-diff.txt`
- 基线：`源码/web-baseline-20261114`（本机对比副本，已 gitignore）
- Git 标签：`pre-vue-migration`

## 约束与已知边界

- 不借迁移改视觉、文案和布局。
- 只使用真实接口；空态只用 `— / 暂无 / 加载中…`。
- 复杂页控制器仍是命令式 JS，下一轮可继续拆成组合式函数/状态组件。
- 不改成 SPA；保持现有 URL 和多页静态托管。
- 工作台的 CSS 交给 Vite 原样输出（关闭 lightningcss 压缩），避免动画 CSS 压缩报错。