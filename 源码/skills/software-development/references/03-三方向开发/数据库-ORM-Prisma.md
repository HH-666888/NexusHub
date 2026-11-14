# 前端侧 ORM 挂载点（Prisma）

本文件定义前端 / 全栈 Node 侧（Next.js）如何用 Prisma 对接 MySQL 分支（主干见 `references/03-三方向开发/数据库-MySQL.md`）。**执行时机**：原型判定通过（`原型开发.md` §五）、`数据建模.md` 产出表结构清单后挂载。横切规则以 `references/横切约定/` 下同名文件为准，本文件只给 `schema.prisma` 结构、迁移命令约定、Client 单例与 Next.js 挂载位置，以及形态 C 下的使用方式。

## 目录

- [1. 依赖](#1-依赖)
- [2. schema.prisma 结构（datasource 与 generator）](#2-schemaprisma-结构datasource-与-generator)
- [3. 迁移命令约定](#3-迁移命令约定)
- [4. Client 单例与 Next.js 挂载位置](#4-client-单例与-nextjs-挂载位置)
- [5. 形态 C 下的使用方式](#5-形态-c-下的使用方式)
- [6. 验证门](#6-验证门)

---

## 1. 依赖

- 依赖 `prisma`（开发期 CLI）与 `@prisma/client`（运行时），版本由执行模型按「稳定版 + 与所选 Node / Next.js 适配」判定，本文件不写死版本号。
- 数据库连接走环境变量 `DATABASE_URL`，写入 `.env`，多环境 `dev` / `prod`，密钥不入库（配置管理权威见 `references/横切约定/配置管理/配置管理.md`）。

## 2. schema.prisma 结构（datasource 与 generator）

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model User {
  id         BigInt    @id @default(autoincrement())
  username   String
  email      String?
  status     Int       @default(1)
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  deletedAt  DateTime? @map("deleted_at")

  @@map("sys_user")
}
```

- 模型字段用驼峰、`@map` / `@@map` 映射到 snake_case 表列（与 MySQL 主干命名约定一致）。
- 软删除下的唯一性由 DDL 的生成列 `active_username` + 唯一键保证（见 MySQL 分支第 7 节）。Prisma 的 `@@unique([username, deletedAt])` 在 MySQL 上**无效**（NULL 互不相等），不要声明；也不要在 `username` 上加 `@unique`，否则会与「删除后可重名」冲突。
- `provider = "mysql"` 与主干配对；切 PostgreSQL / SQLite 时改 `provider` 与 `DATABASE_URL`（差异见 `references/03-三方向开发/数据库-PG-SQLite.md`）。

## 3. 迁移命令约定

- 迁移由 Prisma Migrate 管理：开发期用 `prisma migrate dev --name <语义名>` 生成增量迁移；这些迁移文件落在 `prisma/migrations/`，与 MySQL 主干第 3 节目录约定对齐（递增、向前、不重排）。
- 生产 / CI 用 `prisma migrate deploy` **只应用不生成**；`migrate dev` 限定在开发环境使用。
- `prisma generate` 在改完 schema 后重新生成 Client。
- 验证门前可跑 `prisma migrate status` 确认库结构与迁移历史一致。

## 4. Client 单例与 Next.js 挂载位置

Next.js 开发期热重载会重复实例化，须用单例避免连接耗尽：

```typescript
// lib/prisma.ts（若启用 src/ 目录则为 src/lib/prisma.ts）
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

- 挂载位置：服务端代码（Route Handler / Server Action / API 路由）从 `lib/prisma.ts`（启用 `src/` 时为 `src/lib/prisma.ts`）导入同一个 `prisma` 实例使用；**不**在客户端组件里直接实例化。

## 5. 形态 C 下的使用方式

- 形态 C 指前端 / 全栈工程**直连数据库**（不经过独立后端服务）的形态：在 Next.js 服务端（Server Component、Route Handler、Server Action）直接调用 `prisma`。
- 调用后在服务端组装统一返回体 `{"code":0,"message":"success","data":{}}`；分页 data 结构 `{"list":[],"total":0,"page":1,"page_size":10}`（`page` 从 1 开始，接口规范权威见 `references/横切约定/接口规范/接口规范.md`）。
- `BigInt` 主键不能直接 `JSON.stringify`（会抛 `TypeError`）：出参前 `id.toString()`，接口定义中该字段按 string 声明。
- 认证中间件（JWT，`Authorization: Bearer <token>`）先于数据访问执行，公开接口走白名单（认证鉴权权威见 `references/横切约定/认证鉴权/认证鉴权.md`）。
- 若项目另有独立后端（Java / Python），则前端不直连，Prisma 退化为该后端侧数据访问，形态 C 不适用。

```typescript
// 示例：Route Handler
// export async function GET(req: Request) {
//   const users = await prisma.user.findMany({ where: { deletedAt: null } });
//   return Response.json({ code: 0, message: "success", data: users });
// }
```

## 6. 验证门

1. `.env` 中 `DATABASE_URL` 指向 MySQL；`prisma migrate status` 无待应用 / 无漂移。
2. `prisma generate` 成功，Client 类型包含 `User` 模型。
3. 服务端发起一次读写：`prisma.user.create` → `prisma.user.findMany`，软删除过滤 `deletedAt: null` 生效。
4. 确认 Client 走单例、未在浏览器端打包 prisma。
5. 失败即回流：检查 `provider` 与 `DATABASE_URL` 方言、`@@map` 列映射是否与 MySQL 主干 DDL 一致。
