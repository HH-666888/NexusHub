# NexusHub Vue 前端

已迁移：设置、登录、注册、项目页。其余页面仍由 `源码/web` 原样提供。

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

- `settings/index.html`、`login/index.html`、`register/index.html`、`projects/index.html`
- `vue-assets/*.js`
- `vue-assets/*.css`

FastAPI 在 `源码/backend/app/main.py` 中按页挂载：

- `/vue-assets` → `web/vue-dist/vue-assets`
- `/settings`、`/login`、`/register`、`/projects` → 各自的 `index.html`

构建产物不存在时自动退回 `源码/web` 原页面。

## 约束

- 视觉与交互以 `源码/web-baseline-20261114` 为基线；不借迁移改样式。
- 页面只使用真实接口；没有数据就显示 `— / 暂无 / 加载中…`。
- 继续迁移记忆、辅助列表、欢迎、辅助工作台、工作台时，按同样方式增加多页入口和静态挂载，不改成 SPA。
- 每页迁移后先截图对比，通过后才进入下一页。