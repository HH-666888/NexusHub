# 原生 HTML/CSS/JS 前端工程约定

> 本文件为形态 A（前后端分离下的轻量前端工程）、形态 D（纯静态站点）与形态 B（后端模板渲染所引用的静态资源层）共用的主干前端分支。无官方脚手架，使用本文件规定的标准化目录模板初始化。通用工程规则（命名、接口、配置、异常、日志、认证、接口示例测试）以 `references/横切约定/` 下对应同名文件为准，本文件只写原生 HTML 栈内的落地方式，不照抄通用规则全文。

## 目录

- [1. 初始化方式（标准化目录模板）](#1-初始化方式标准化目录模板)
- [2. 完整目录结构与各层职责](#2-完整目录结构与各层职责)
- [3. 命名规范（栈内细则）](#3-命名规范栈内细则)
- [4. 请求/响应与统一返回体的前端处理](#4-请求响应与统一返回体的前端处理)
- [5. 配置管理（多环境变量与前缀）](#5-配置管理多环境变量与前缀)
- [6. 异常处理](#6-异常处理)
- [7. 日志](#7-日志)
- [8. 认证鉴权挂载点](#8-认证鉴权挂载点)
- [9. 有序生成顺序](#9-有序生成顺序)
- [10. 验证门具体动作](#10-验证门具体动作)

---

## 1. 初始化方式（标准化目录模板）

- 原生 HTML 无官方脚手架；按本文件第 2 节目录手工初始化，目录结构固定。
- 工程初始化动作：
  1. 新建工程根目录（kebab-case）。
  2. 依次新建 `pages/`、`assets/css/`、`assets/js/`、`assets/img/`、`assets/lib/`。
  3. 新建 `index.html` 作为站点入口（位于工程根，同时作为 `pages/` 的首页别名）。
  4. 新建 `assets/js/config.js`、`assets/js/request.js`、`assets/js/auth.js`、`assets/js/common.js` 四个基础文件。
  5. 新建 `.env.development`、`.env.production`（如使用构建工具注入变量；纯静态直开场景则在 `config.js` 内集中写死环境切换开关）。
- 不强制引入打包工具；如需求明确要求模块化与构建，可引入官方当前推荐的轻量构建方案，但目录结构仍以本文件为准。
- 形态 B 下，本工程不独立存在，其静态资源目录作为后端工程的 `static/`（Spring Boot）或 `static/`（FastAPI）子目录被后端托管；模板渲染入口见 `references/03-三方向开发/前端-模板页.md`。

## 2. 完整目录结构与各层职责

```
<工程名>/
├── index.html                  # 站点入口（首页）
├── pages/                      # 内页 HTML
│   ├── login.html
│   ├── dashboard.html
│   └── <feature>.html
├── assets/
│   ├── css/
│   │   ├── base.css            # 重置、变量、通用排版
│   │   ├── common.css          # 通用组件样式（按钮、表格壳、弹窗壳）
│   │   └── <page>.css          # 页面级样式，与 pages/ 同名
│   ├── js/
│   │   ├── config.js           # 环境配置与常量
│   │   ├── request.js          # fetch 封装与统一返回体处理
│   │   ├── auth.js             # token 读写、请求头注入、登录守卫
│   │   ├── common.js           # 工具函数、DOM 公共方法
│   │   └── <page>.js           # 页面级脚本，与 pages/ 同名
│   ├── img/                    # 图片、图标
│   └── lib/                    # 第三方库本地副本（无 CDN 时使用）
├── .env.development            # 开发环境变量（如启用构建注入）
├── .env.production             # 生产环境变量
└── .gitignore
```

各层职责：

- `pages/`：每个 HTML 对应一个功能页面；页面之间不互相内嵌片段，公共片段（导航、页脚）在每页内一致重复，或由 `common.js` 在 DOM 加载后注入。
- `assets/css/`：样式按 base → common → page 三层叠加；页面级样式只放本页独有规则。
- `assets/js/`：按 config → request → auth → common → page 的依赖顺序加载；页面脚本不反向修改基础层。
- `assets/img/`：所有页面图片放此，引用路径统一以 `/assets/img/...` 或相对路径 `../assets/img/...`。
- `assets/lib/`：仅在不能使用 CDN 时存放第三方库本地副本。

## 3. 命名规范（栈内细则）

通用命名规则见 `references/横切约定/命名规范/命名规范.md`，本节补原生 HTML 栈内细则：

- 工程根目录 kebab-case；HTML 文件 kebab-case，如 `order-list.html`。
- CSS 类名：统一使用 kebab-case，如 `.user-card`、`.btn-primary`。
- JS 函数与变量：camelCase；常量 UPPER_SNAKE_CASE；事件处理函数以 `on` 开头，如 `onSubmit`。
- JS 文件：kebab-case（如 `request.js`、`auth.js`、`common.js`），全工程统一。
- 接口 URL：与横切接口规范一致，前缀 `/api/v1/`，资源名词复数、小写。
- 环境变量：见第 5 节。

## 4. 请求/响应与统一返回体的前端处理

统一返回体与错误码语义以 `references/横切约定/接口规范/接口规范.md` 为准，本节只写原生 HTML 栈内封装落点。

- 所有 HTTP 调用经 `assets/js/request.js` 统一封装，页面脚本不直接 `fetch` / `XMLHttpRequest`。
- 封装要点：
  - 自动注入 `Authorization: Bearer <token>`（取自 `assets/js/auth.js`）。
  - 自动拼接 baseURL（来自 `config.js`）与 `/api/v1/` 前缀。
  - 统一解析返回体：`code === 0` 时把 `data` 交给调用方；非 0 时按错误码分发（10001 参数错误、10002 未认证、10003 无权限、10004 资源不存在、10005 冲突，业务模块从 11000 起分段）。
  - HTTP 状态码对齐 400/401/403/404/409/500；401 触发登出并跳转登录页，其余统一弹窗或页面级错误提示。
- 分页请求：请求参数 `page`（从 1 开始）、`page_size`（默认 10、上限 100）；分页响应对 `data.list / data.total / data.page / data.page_size` 结构，前端渲染表格壳与分页器。
- 表单提交：
  - 表单 `submit` 事件拦截默认行为，序列化为 JSON 后调用 `request.js` 的 `post` / `put` 方法。
  - 提交中按钮置灰防重复；成功后按业务跳列表或提示，失败按错误码展示字段级或全局提示。
- 文件上传：使用 `FormData` 走 `request.js` 的上传方法，请求头不手动设 `Content-Type`，由浏览器自动带 boundary。

## 5. 配置管理（多环境变量与前缀）

通用配置规则见 `references/横切约定/配置管理/配置管理.md`。本节为原生 HTML 落点：

- 纯静态直开场景：环境切换开关集中在 `assets/js/config.js`，导出一个全局 `APP_CONFIG` 对象，包含 `API_BASE_URL`、`ENV`、`ENABLE_DEBUG` 等键；切换环境只改这一处。
- 启用构建注入场景：使用 `.env.development` / `.env.production`，变量前缀按所选构建工具约定（如 Vite 的 `VITE_`）；在 `config.js` 内一次性读取并暴露给业务代码，业务脚本不直接读 `import.meta.env`。
- 密钥不入库、不写入前端代码；前端只持有 baseURL 与非敏感开关。

## 6. 异常处理

通用异常规则见 `references/横切约定/异常处理/异常处理.md`。本节为前端落点：

- 请求失败分类：网络错误、非 0 业务 code、HTTP 5xx；分别走重试提示、业务弹窗、页面级错误条。
- 401：清空 token，跳转 `pages/login.html` 并携带回跳地址。
- 403：展示无权限提示，不自动重试。
- 未捕获异常：在 `common.js` 内挂 `window.onerror` 与 `unhandledrejection` 监听，统一记录并弹友好提示，不向用户暴露堆栈。
- DOM 渲染错误：关键区域（表格、列表）渲染失败时在容器内插入兜底空态 HTML，页面保持可见。

## 7. 日志

通用日志规则见 `references/横切约定/日志规范/日志规范.md`。本节为前端落点：

- 日志级别：ERROR/WARN/INFO/DEBUG；生产默认 INFO，开发可开 DEBUG。
- 统一字段：`时间 | 级别 | traceId | 模块 | 消息`；traceId 在 `request.js` 发起请求时生成并随请求头传给后端。
- token、密码、身份证、手机号等敏感字段打印前在 `request.js` 统一脱敏。
- 输出：开发环境控制台；生产环境 ERROR 级通过上报钩子发往监控端点，INFO 级不打控制台。

## 8. 认证鉴权挂载点

通用认证规则见 `references/横切约定/认证鉴权/认证鉴权.md`。本节为原生 HTML 落点：

- 协议：JWT，请求头 `Authorization: Bearer <token>`。
- token 存储：由 `assets/js/auth.js` 统一封装读写，底层使用受限本地存储；敏感场景优先与后端配合改 httpOnly Cookie，避免前端 JS 直接持有。
- 请求头注入：在 `request.js` 出口统一加 Bearer 头；登录与公开接口走白名单，不注入。
- 路由守卫：每个受保护页面在 `<body>` 底部先加载 `auth.js` 的 `requireAuth()`，未登录直接 `location.href = 'pages/login.html?redirect=' + encodeURIComponent(location.pathname)`。
- 白名单：`index.html`、`pages/login.html`、注册页、健康检查页；其余页面默认受保护。

## 9. 有序生成顺序

**UI 规范子产物（页面生成的前置契约）**：进入原型开发前，必须先产出 UI 规范子产物——页面结构清单（每个 HTML 页面对应的功能、页面内区块划分）与样式/脚本组织清单（`assets/css/<page>.css`、`assets/js/<page>.js` 与页面一一对应）；页面与样式按该清单生成，设计变更回流清单后重做。该子产物作为前端构建的 UI 契约，供验证门与需求闭环验收核对。

按依赖关系自上而下生成，前一步未闭合不进入下一步：

1. 工程初始化：建目录、建 `index.html` 与 `pages/` 骨架。
2. 配置层：`assets/js/config.js`、`.env.*`（如启用）。
3. 基础设施层：`assets/js/auth.js`、`assets/js/request.js`、`assets/js/common.js`、`assets/css/base.css`、`assets/css/common.css`（先出骨架，数据接真在步骤 5 完成）。
4. 原型开发：按页面结构清单逐页制作成品级页面——视觉完整、交互状态齐全、占位数据明确标注（规则见 `原型开发.md` §四）；拼接页面跳转后过原型判定门（`原型开发.md` §五），通过后原型锁定为权威依据。
5. 前端接真实数据：把原型中的占位数据替换为 `assets/js/<page>.js` 内调用 `request.js`（接口定义以锁定原型为输入，见 `接口设计.md`），页面代码直接演化不重写。
6. 静态资源：`assets/img/` 下图片、图标。
7. 端到端联调与接口示例测试（与 `references/05-自动化测试/接口示例测试.md` 对齐）。

## 10. 验证门具体动作

对应 SKILL.md §4.2 前端层合格线，原生 HTML 无构建步骤，验证门以"页面可直接打开、资源引用有效、接口连通"为准：

0. 环境预检：无需构建工具链；用浏览器或 `python -m http.server` 起静态服务验证。只检查文件存在不算通过。
1. 目录自检：`pages/`、`assets/css/`、`assets/js/`、`assets/img/` 齐全；`index.html` 存在。
2. 页面可打开：用浏览器直接打开 `index.html` 与至少一个内页（如 `pages/dashboard.html`），控制台无致命错误、无资源 404。
3. 资源引用有效：所有 `<link>`、`<script>`、`<img src>` 路径均可解析；CSS/JS 文件之间无断裂引用。
4. 接口连通：在已登录态下，触发至少一条业务请求，按接口定义返回统一返回体，`code === 0`；401/403 行为与认证挂载点一致。
5. 表单提交：至少一条表单提交走通，成功与失败分支均按错误码展示。

任一项失败即按 SKILL.md §2.4 判定回流到工序③ 对应步骤，修复后重过本门；同一道门连续 3 次不通过按 SKILL.md §2.5 止损。
