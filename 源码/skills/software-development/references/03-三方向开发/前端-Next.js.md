# Next.js（App Router）前端工程约定

> 本文件为形态 A（前后端分离，前端独立工程）与形态 C（Next.js 全栈）共用的主干前端分支。形态 C 下后端能力收口在本工程的 Route Handlers 中，不再产生独立后端工程。通用工程规则（命名、接口、配置、异常、日志、认证、接口示例测试）以 `references/横切约定/` 下对应同名文件为准，本文件只写 Next.js 栈内的落地方式，不照抄通用规则全文。

## 目录

- [1. 脚手架初始化](#1-脚手架初始化)
- [2. 完整目录结构与各层职责](#2-完整目录结构与各层职责)
- [3. 命名规范（栈内细则）](#3-命名规范栈内细则)
- [4. 路由、Layout 与文件约定](#4-路由layout-与文件约定)
- [5. 服务端组件与客户端组件边界](#5-服务端组件与客户端组件边界)
- [6. Route Handlers（形态 C 后端收口）](#6-route-handlers形态-c-后端收口)
- [7. 请求/响应与统一返回体的前端处理](#7-请求响应与统一返回体的前端处理)
- [8. 配置管理（多环境变量与前缀）](#8-配置管理多环境变量与前缀)
- [9. 异常处理](#9-异常处理)
- [10. 日志](#10-日志)
- [11. 认证鉴权挂载点](#11-认证鉴权挂载点)
- [12. 有序生成顺序](#12-有序生成顺序)
- [13. 验证门具体动作](#13-验证门具体动作)

---

## 1. 脚手架初始化

一律使用官方脚手架 `create-next-app` 初始化，工程结构由脚手架生成。

- 执行命令：`npx create-next-app@latest <工程名>`（工程名 kebab-case）。
- 必选交互选项（按官方当前推荐实践固定选择）：
  - **App Router：必选开启**。本分支只覆盖 App Router，不接受 Pages Router。
  - TypeScript：开启。
  - ESLint：开启。
  - Tailwind CSS：按需求决定；未指定时默认开启。
  - `src/` 目录：按需求决定；未指定时默认不开启，保持 `app/` 位于工程根。
  - 导入别名 `@/*`：开启。
  - Turbopack（开发模式）：按官方当前推荐开启。
- 初始化完成后进入工程目录，按本文件第 2 节补齐 `components/`、`lib/` 两个目录（脚手架默认不生成，需手工新建，目录名固定）。
- 形态 C 下若选择 Prisma 作为持久层，按 `references/03-三方向开发/数据库-ORM-Prisma.md` 挂载；本文件不展开 ORM 细节。

## 2. 完整目录结构与各层职责

```
<工程名>/
├── app/                        # 路由段、布局、页面、API 路由（App Router 根）
│   ├── layout.tsx              # 根布局（HTML/body、全局 Provider）
│   ├── page.tsx                # 首页
│   ├── globals.css             # 全局样式
│   ├── (group)/                # 路由分组（不进 URL）
│   │   └── <route-segment>/
│   │       ├── page.tsx        # 页面组件
│   │       ├── layout.tsx      # 段级布局
│   │       ├── loading.tsx     # 段级加载态
│   │       ├── error.tsx       # 段级错误边界
│   │       ├── not-found.tsx   # 404 兜底
│   │       └── route.ts        # Route Handler（形态 C 收口后端接口）
│   └── api/                    # 形态 C 的 API 路由统一入口
│       └── <resource>/
│           └── route.ts
├── components/                 # 通用组件与业务组件
│   ├── ui/                     # 基础组件（按钮、输入框、表格壳）
│   └── <feature>/              # 业务组件，按功能域聚合
├── lib/                        # 请求封装、鉴权、工具函数、常量
│   ├── request.ts              # fetch 封装与统一返回体处理
│   ├── auth.ts                 # token 读写、请求头注入
│   ├── env.ts                  # 环境变量读取与校验
│   └── utils.ts                # 纯工具函数
├── public/                     # 静态资源（图片、图标、无构建处理的文件）
├── .env.development            # 开发环境变量
├── .env.production             # 生产环境变量
├── .env.local                  # 本地覆盖（不入库）
├── next.config.ts              # Next.js 配置
├── tsconfig.json               # 路径别名等
└── package.json
```

各层职责：

- `app/`：只放与路由一一对应的页面、布局、加载/错误边界与 Route Handler；不放业务工具函数。
- `components/`：纯展示与交互组件；按功能域聚合，跨页面复用的基础组件下沉到 `ui/`。
- `lib/`：无 UI 副作用的逻辑层；所有跨组件共享的请求、鉴权、工具、常量集中在此，组件内不散落复制。
- `public/`：运行时直接以 `/xxx` 引用的静态资源；需构建处理的资源（如带 hash 的字体）不放此处。

## 3. 命名规范（栈内细则）

通用命名规则（工程/目录 kebab-case、常量 UPPER_SNAKE_CASE、接口 URL 前缀 `/api/v1/` 等）见 `references/横切约定/命名规范/命名规范.md`，本节仅补 Next.js 栈内细则：

- 组件文件：PascalCase，如 `UserTable.tsx`、`LoginForm.tsx`。
- App Router 路由段目录：kebab-case，如 `user-center/`、`order-list/`；动态段用方括号，如 `[orderId]/`。
- 保留文件名（`page.tsx`、`layout.tsx`、`loading.tsx`、`error.tsx`、`not-found.tsx`、`route.ts`）一律小写，文件名固定。
- 函数与变量：camelCase；Hook 以 `use` 开头，如 `useAuth.ts`。
- 工具函数文件：kebab-case（如 `auth-utils.ts`、`request-client.ts`），与命名规范 §四 一致。
- 环境变量：客户端可见变量加官方公开前缀，服务端变量不加；详见第 8 节。

## 4. 路由、Layout 与文件约定

- 每个 URL 段对应 `app/` 下一个目录；目录名即路由段（kebab-case）。
- 特殊文件约定（文件名固定，不新增同义文件）：
  - `layout.tsx`：段级布局，可嵌套；根 `app/layout.tsx` 必须输出 `<html>` 与 `<body>`。
  - `page.tsx`：该段的页面入口；缺少则该段不可访问。
  - `loading.tsx`：段级 Suspense 加载态，自动包裹该段 UI。
  - `error.tsx`：段级客户端错误边界（必须是客户端组件），用于捕获渲染期异常。
  - `not-found.tsx`：命中未匹配路由或主动调用 `notFound()` 时的兜底页面。
  - `route.ts`：Route Handler，见第 6 节。
- 路由分组 `(group)`：用于组织布局而不改变 URL，如 `(auth)/login/page.tsx` 实际路径为 `/login`。
- 动态路由：`[id]/page.tsx` 通过 props 接收参数；可选动态段用 `[[...slug]]`。
- 导航：客户端跳转使用 `next/link` 与 `useRouter()`。

## 5. 服务端组件与客户端组件边界

- 默认所有组件为服务端组件（Server Component）；仅在需要浏览器 API、状态、事件监听时才在文件顶部加 `"use client"`。
- `"use client"` 是文件级指令，写在文件第一行；由该文件 import 的组件默认仍是客户端组件。
- 边界规则：
  - 服务端组件可直接读数据库、读环境变量、做鉴权；不包含 `useState`、`useEffect` 与浏览器 API。
  - 客户端组件不直接导入敏感服务端环境变量；需要的数据由服务端组件作为 props 传入。
  - 表单交互、按钮点击、富交互表格、图表组件一律放客户端组件。
- 边界穿透方式：服务端组件把数据与回调（如服务端 Action）作为 props 传给客户端组件；复杂交互优先使用 Server Actions，避免不必要的客户端数据获取。

## 6. Route Handlers（形态 C 后端收口）

- 形态 C 下，后端能力统一收口在 `app/api/**/route.ts`，不另起独立后端工程。
- 每个 `route.ts` 按 HTTP 方法导出同名函数：`GET`、`POST`、`PUT`、`PATCH`、`DELETE`。
- 路径约定：与横切接口规范一致，统一 `/api/v1/<resource>/...`，资源名词复数、小写；Route Handler 文件位置须与路径一一对应，如 `app/api/v1/users/route.ts` 对应 `/api/v1/users`。
- 统一返回体在 Route Handler 出口处组装：`{"code":0,"message":"success","data":{}}`；业务错误按横切异常处理约定抛出，由统一包装函数转成非 0 code 与对应 HTTP 状态码。
- 鉴权：在 Route Handler 入口统一从请求头解析 Bearer token，校验逻辑集中在 `lib/auth.ts`，各 handler 复用。
- 持久层：形态 C 下使用 Prisma 时，按 `references/03-三方向开发/数据库-ORM-Prisma.md` 挂载；本文件不展开。
- 形态 A 下 Route Handlers 不使用，`app/api/` 目录不创建。

## 7. 请求/响应与统一返回体的前端处理

统一返回体与错误码语义以 `references/横切约定/接口规范/接口规范.md` 为准，本节只写前端封装落点。

- 所有 HTTP 调用经 `lib/request.ts` 统一封装，组件内不直接 `fetch`。
- 封装要点：
  - 自动注入 `Authorization: Bearer <token>`（取自 `lib/auth.ts`）。
  - 自动拼接 baseURL（来自环境变量，见第 8 节）与 `/api/v1/` 前缀。
  - 统一解析返回体：`code === 0` 时返回 `data`；非 0 时按错误码分发（10001 参数错误、10002 未认证、10003 无权限、10004 资源不存在、10005 冲突，业务模块从 11000 起分段）。
  - HTTP 状态码对齐 400/401/403/404/409/500；401 触发登出并跳转登录页，其余统一弹错或写入段级错误边界。
- 分页请求：请求参数 `page`（从 1 开始）、`page_size`（默认 10、上限 100）；分页响应对 `data.list / data.total / data.page / data.page_size` 结构。
- 服务端组件内取数：直接 `await` 调用封装函数或 Prisma；客户端组件取数：在事件处理或 `useEffect` 中调用封装函数，不自建一层 fetch 去打自有 Route Handler。
- 错误抛出：业务错误统一抛出自定义 `ApiError(code, message)`，由 `error.tsx` 或全局 Toast 捕获展示。

## 8. 配置管理（多环境变量与前缀）

通用配置规则见 `references/横切约定/配置管理/配置管理.md`。本节为 Next.js 栈内落地：

- 多环境文件：`.env.development`（开发）、`.env.production`（生产）、`.env.local`（本地覆盖，不入库）。
- 变量前缀硬约束：
  - 浏览器端可见变量必须加官方公开前缀 `NEXT_PUBLIC_`，如 `NEXT_PUBLIC_API_BASE_URL`。
  - 仅服务端可读的变量不加前缀，如 `DATABASE_URL`、`JWT_SECRET`；`NEXT_PUBLIC_` 前缀会把变量暴露到浏览器，密钥类变量不使用此前缀。
- 读取入口统一收敛到 `lib/env.ts`：在启动时一次性读取并做类型与非空校验，缺失即抛错；组件与 Route Handler 不散落 `process.env.XXX`。
- 密钥不入库、不进前端 bundle；`.env.local` 加入 `.gitignore`。

## 9. 异常处理

通用异常规则见 `references/横切约定/异常处理/异常处理.md`。本节为前端落点：

- 渲染期异常：由段级 `error.tsx`（客户端组件）捕获，展示友好重试 UI；根级 `app/error.tsx` 作为最后兜底。
- 请求失败：在 `lib/request.ts` 内统一分类——网络错误、非 0 业务 code、HTTP 5xx；分别走重试提示、业务 Toast、段级错误边界。
- 401 未认证：清空本地 token，跳转登录页；避免重复跳转死循环。
- 403 无权限：展示无权限页，不再自动重试。
- 未捕获异常：根布局挂载全局 `window.onerror` / `unhandledrejection` 上报钩子，仅记录不打扰用户。

## 10. 日志

通用日志规则见 `references/横切约定/日志规范/日志规范.md`。本节为前端落点：

- 日志级别：ERROR/WARN/INFO/DEBUG；生产默认 INFO，开发可开 DEBUG。
- 统一字段：`时间 | 级别 | traceId | 模块 | 消息`；traceId 在请求发起时生成并随请求头传给后端，便于前后端串联。
- token、密码、身份证、手机号等敏感字段打印前在 `lib/request.ts` 统一脱敏。
- 前端不写日志文件；生产环境通过上报钩子把 ERROR 级日志发往监控端点，INFO 级仅控制台。

## 11. 认证鉴权挂载点

通用认证规则见 `references/横切约定/认证鉴权/认证鉴权.md`。本节为 Next.js 落点：

- 协议：JWT，请求头 `Authorization: Bearer <token>`。
- token 存储：
  - 客户端组件内使用 `lib/auth.ts` 提供的读写函数，底层存于安全的浏览器存储（按需求选定 httpOnly Cookie 或受限本地存储；敏感场景优先 httpOnly Cookie，由 Route Handler 读写）。
  - 服务端组件与 Route Handler 直接从请求头或 Cookie 读取，不读本地存储。
- 请求头注入：在 `lib/request.ts` 出口统一加 Bearer 头；登录与公开接口走白名单，不注入。
- 路由守卫：
  - 受保护页面在服务端组件顶部调用 `lib/auth.ts` 的校验函数，未登录直接重定向到登录页。
  - 客户端路由跳转用 `next/link` 包裹的守卫组件拦截，未登录跳转登录页并携带回跳地址。
- 白名单：登录、注册、公开首页、健康检查；其余路由默认受保护。

## 12. 有序生成顺序

**UI 规范子产物（页面生成的前置契约）**：进入原型开发前，必须先产出 UI 规范子产物——页面结构清单（每个页面对应的路由段、页面内区块划分）与组件集清单（`components/ui/` 基础组件、`components/<feature>/` 业务组件及其职责）；页面与组件按该清单生成，设计变更回流清单后重做。该子产物作为前端构建的 UI 契约，供验证门与需求闭环验收核对。

按依赖关系自上而下生成，前一步未闭合不进入下一步：

1. 工程初始化：`create-next-app` 跑完，补齐 `components/`、`lib/` 目录。
2. 配置层：`.env.*` 文件、`lib/env.ts`、`next.config.ts`、路径别名。
3. 基础设施层：`lib/request.ts`、`lib/auth.ts`、错误/日志工具（先出骨架，数据接真在步骤 7 完成）。
4. 原型开发：按页面结构清单逐页制作成品级页面——视觉完整、交互状态齐全、占位数据明确标注（规则见 `原型开发.md` §四）；拼接页面跳转后过原型判定门（`原型开发.md` §五），通过后原型锁定为权威依据。
5. 形态 C 数据层：Prisma schema、迁移、client 单例（细节见 Prisma 分支文件）。
6. 形态 C 接口层：`app/api/v1/**/route.ts`，与接口定义 1:1（接口定义以锁定原型为输入，见 `接口设计.md`）。
7. 前端接真实数据：把原型中的占位数据替换为 `lib/request.ts` 调用与真实取数（服务端组件直接取数），原型代码直接演化不重写；同步补齐根/段级 `layout.tsx`、`loading.tsx`、`error.tsx`、`not-found.tsx`。
8. 静态资源：`public/` 下图片、图标。
9. 端到端联调与接口示例测试（与 `references/05-自动化测试/接口示例测试.md` 对齐）。

## 13. 验证门具体动作

对应 SKILL.md §4.2 前端层合格线，执行以下确定性命令，全部通过才算过：

0. 环境预检：`node -v`、`npm -v` 可执行，版本满足所选 Next.js 的官方约束；缺 Node 或版本过低时直接报告，不得跳过。
1. 安装依赖：`npm install`（或 pnpm/yarn，按工程实际包管理器保持一致），无致命错误。
2. 类型与 lint：`npm run lint` 通过，无 error 级告警。
3. 生产构建：`npm run build` 零报错通过（构建顺带做类型检查）；出现类型错误、未安装依赖、环境变量缺失均视为不通过，按 §2.4 判定回流。
4. 本地启动自检：`npm run start`（生产模式）或 `npm run dev`（开发模式）后，首页与至少一条受保护路由可访问；形态 C 下至少一个 `/api/v1/` 示例接口按接口定义返回统一返回体。
5. 形态 C 全栈联调：一条经 Route Handler → Prisma → 数据库的端到端链路返回 `code: 0`；401/403 行为与认证挂载点一致。

任一命令失败即按 SKILL.md §2.4 回流到工序③ 对应步骤，修复后重过本门；同一道门连续 3 次不通过按 SKILL.md §2.5 止损。
