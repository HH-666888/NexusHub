# NexusHub Vue 前端

当前只迁移了设置页，作为 Vue 3 + Vite 的试点；其余页面仍由 `源码/web` 原样提供。

## 开发

```bash
pnpm install
pnpm dev
```

开发服务器只用于调试设置页；接口仍指向上游 FastAPI。

## 构建

```bash
pnpm build
```

构建输出到 `源码/web/settings-dist/settings`：

- `settings/index.html`
- `settings/assets/*.js`
- `settings/assets/*.css`

FastAPI 在 `源码/backend/app/main.py` 中把 `/settings` 优先指向该目录；目录不存在时自动退回原来的 `web/settings`。

## 约束

- 视觉与交互以 `源码/web-baseline-20261114` 为基线；不借迁移改样式。
- 页面只使用真实接口；没有数据就显示 `— / 暂无 / 加载中…`。
- 下一阶段迁移登录、注册、项目页时，按同样方式增加多页入口和静态挂载，不改成 SPA。