# Vue（扩展）前端工程约定

> 本文件为前端扩展分支，仅写与主干 `references/03-三方向开发/前端-Next.js.md` 的差异要点和参照关系；通用工程规则一律以 `references/横切约定/` 下对应同名文件为准。未在本文件列出的事项（统一返回体、错误码、分页参数、JWT 协议、日志字段、命名通用规则等），直接参照 Next.js 主干执行，不在此重复。

## 目录

- [1. 定位与适用场景](#1-定位与适用场景)
- [2. 脚手架初始化（create-vue）](#2-脚手架初始化create-vue)
- [3. 目录结构与主干差异](#3-目录结构与主干差异)
- [4. SFC 与组件约定](#4-sfc-与组件约定)
- [5. 路由与状态管理挂载点](#5-路由与状态管理挂载点)
- [6. 请求/鉴权/配置/日志/异常的差异](#6-请求鉴权配置日志异常的差异)
- [7. 有序生成顺序与验证门](#7-有序生成顺序与验证门)

---

## 1. 定位与适用场景

- 仅当用户明确选择 Vue 体系时启用；形态 A 前后端分离下的独立前端工程。
- 不覆盖形态 C 全栈；形态 C 仍走 Next.js 主干。
- 默认组合：Vue 3 官方当前推荐的构建链 + Vite 构建 + Vue Router + Pinia；具体版本由执行模型按稳定版、官方当前推荐实践判定，本文件不锁版本号。

## 2. 脚手架初始化（create-vue）

- 一律使用官方脚手架 `create-vue` 初始化：
  - 执行命令：`npm create vue@latest <工程名>`（工程名 kebab-case）。
  - 必选/默认开启：TypeScript、Vue Router、Pinia、ESLint；未指定时按官方当前推荐选择。
  - 初始化完成后按本文件第 3 节补齐 `src/lib/` 目录。

## 3. 目录结构与主干差异

与 Next.js 主干的最大差异：**无 App Router 文件约定**，路由由 Vue Router 显式配置；**无服务端/客户端组件之分**，全部为浏览器端渲染（SSR 非默认，不展开）。

```
<工程名>/
├── src/
│   ├── main.ts                 # 应用入口
│   ├── App.vue                 # 根组件
│   ├── pages/ 或 views/        # 路由级页面组件
│   ├── components/             # 通用与业务组件（SFC）
│   ├── router/                 # Vue Router 路由表与守卫
│   ├── stores/                 # Pinia store
│   ├── lib/                    # request.ts、auth.ts、env.ts、utils.ts（与 Next.js lib/ 职责一致）
│   ├── assets/                 # 经构建处理的样式与图片
│   └── styles/                 # 全局样式
├── public/                     # 不经构建的静态资源
├── .env.development
├── .env.production
├── vite.config.ts
└── tsconfig.json
```

- 与 Next.js 主干的对应关系：
  - `src/lib/` ≈ Next.js 的 `lib/`，职责与文件清单一致（请求封装、鉴权、环境变量、工具）。
  - `src/components/` ≈ Next.js 的 `components/`，命名规则一致。
  - `public/` 与 Next.js 同名同义。
  - 不再有 `app/` 路由段目录；路由由 `src/router/` 内集中声明。

## 4. SFC 与组件约定

- 组件一律使用单文件组件（SFC，`.vue`）：`<script setup>` + `<template>` + `<style scoped>`。
- 组件文件：PascalCase，如 `UserTable.vue`；页面组件放 `pages/` 或 `views/`，命名 kebab-case 或 PascalCase 与工程内现有风格统一。
- 样式默认 `scoped`；全局样式放 `src/styles/`，在 `main.ts` 一次性引入。
- Props 使用 TypeScript 类型定义；emit 用 `defineEmits` 显式声明。

## 5. 路由与状态管理挂载点

- 路由表集中在 `src/router/index.ts`；路由元信息 `meta.requiresAuth` 标记受保护页面。
- 全局前置守卫 `router.beforeEach` 内调用 `src/lib/auth.ts` 的校验函数，未登录跳转登录页并携带回跳地址；白名单（登录、注册、公开页）在守卫内显式放行。
- 状态管理使用 Pinia：`src/stores/user.ts` 存当前用户与 token 读取入口；token 本身的底层存储仍由 `lib/auth.ts` 统一封装，store 只做业务态。

## 6. 请求/鉴权/配置/日志/异常的差异

以下事项与 Next.js 主干的**行为约定完全一致**，仅落点文件名相同、目录不同：

- 请求封装：`src/lib/request.ts`，统一返回体 `{"code":0,"message":"success","data":{}}`、错误码分段、分页参数与结构、Bearer 头注入——规则照 Next.js 主干第 7、11 节。
- 认证：JWT，`Authorization: Bearer <token>`，白名单与路由守卫落点在 `src/router/`——规则照 Next.js 主干第 11 节。
- 配置：`.env.development` / `.env.production`，客户端可见变量加 Vite 公开前缀 `VITE_`，密钥不加前缀且不入库——规则照 Next.js 主干第 8 节，仅前缀名按构建工具替换。
- 异常：组件层用 Vue 的 `app.config.errorHandler` 做全局未捕获异常兜底；请求层错误分类与 Next.js 主干第 9 节一致。
- 日志：字段、级别、脱敏规则照横切日志规范；前端无 Node 侧日志文件，落点与 Next.js 主干第 10 节一致。

## 7. 有序生成顺序与验证门

- 生成顺序参照 Next.js 主干第 12 节：初始化 → 配置层 → `src/lib/` 基础设施 → **原型开发（成品级页面 + 占位数据 → 原型判定门 → 锁定，见 `原型开发.md`）** → Pinia store → 路由表与守卫 → **接真实数据（占位数据替换为接口调用）** → 静态资源 → 联调。
- 验证门具体动作（对应 SKILL.md §4.2 前端层）：
  1. 安装依赖：`npm install` 无致命错误。
  2. 类型与 lint：`npm run lint` 通过。
  3. 生产构建：`npm run build` 零报错通过。
  4. 本地启动：`npm run dev` 后首页与至少一条受保护路由可访问，控制台无致命错误。
  5. 至少一条端到端接口按接口定义返回统一返回体，401/403 行为与认证挂载点一致。

任一失败即按 SKILL.md §2.4 判定回流。
