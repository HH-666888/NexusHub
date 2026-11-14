# PostgreSQL / SQLite（扩展）

本文件是「数据库」分支的**扩展**，不独立成主干。默认主库为 MySQL（见 `references/03-三方向开发/数据库-MySQL.md`），本文件只说明在「技术选型」阶段判定回流或切到 PostgreSQL / SQLite 时，与 MySQL 主干的**差异**与**参照关系**。执行时机与主干一致：原型判定通过（`原型开发.md` §五）后，按 `数据建模.md` 产出的表结构清单建表。命名、配置、返回体、分页等通用规则仍以横切约定与 MySQL 主干为准，本文件不重复。

## 目录

- [1. PostgreSQL 与 MySQL 的差异](#1-postgresql-与-mysql-的差异)
- [2. SQLite 与 MySQL 的差异及适用边界](#2-sqlite-与-mysql-的差异及适用边界)
- [3. ORM 切换时的配对注意点](#3-orm-切换时的配对注意点)

---

## 1. PostgreSQL 与 MySQL 的差异

版本约束、目录约定、命名前缀（`idx_` / `uk_` / `fk_`）、审计字段语义均沿用 MySQL 主干，下列项替换：

| 维度 | MySQL 主干约定 | PostgreSQL 对应做法 |
| --- | --- | --- |
| 自增主键 | `BIGINT UNSIGNED AUTO_INCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY`（或 `BIGSERIAL`）；无 `UNSIGNED` 概念 |
| 字符集 / 排序规则 | `utf8mb4` + collation 声明到表 | 数据库初始化时指定 `ENCODING 'UTF8'`、`COLLATE`；逐列排序规则按需，不写表级 `CHARSET` |
| 时间戳默认值 | `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)` | `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP`；`ON UPDATE` 无内置列，需用触发器或由 ORM / 应用维护 `updated_at` |
| 软删除唯一键 | 唯一键并入 `deleted_at` 列 | 可直接用**部分唯一索引**（`WHERE deleted_at IS NULL`），比 MySQL 更干净，优先用之 |
| 分页语法 | `LIMIT n OFFSET m` | 同为 `LIMIT n OFFSET m`，兼容；但 OFFSET 深分页性能注意点相同 |
| 连接配置 | `DB_HOST/PORT/NAME/USER/PASSWORD` + 字符集参数 | 环境变量同名，去掉字符集连接参数；驱动默认 UTF8 |
| 外键 | `CONSTRAINT fk_... FOREIGN KEY` | 语法一致，约束名同 `fk_` 前缀 |

- 校验命令换成 PostgreSQL：`\dt` 看表、`\d+ <表>` 看列 / 索引、`SELECT version();` 核对版本。
- 验证门动作（空库跑基线、幂等 / 顺序、连接自检 `SELECT 1;`）与 MySQL 主干第 11 节一致。

## 2. SQLite 与 MySQL 的差异及适用边界

适用边界：SQLite 为**文件型嵌入式数据库**，无独立服务端。用于**原型验证、本地脚手架演示、单机轻量工具**；多实例、高并发、需要外键强一致或并发写的主业务库选用 MySQL / PostgreSQL。一旦进入多用户 / 多实例部署，判定回流到 MySQL 或 PostgreSQL。

| 维度 | MySQL 主干约定 | SQLite 对应做法 |
| --- | --- | --- |
| 连接配置 | 网络 `host/port/user/password` | 单文件路径，环境变量如 `DB_PATH=./data/app.db`，无账号密码 |
| 自增主键 | `BIGINT UNSIGNED AUTO_INCREMENT` | `INTEGER PRIMARY KEY`（rowid 别名即自增）；无 `UNSIGNED`、无 `BIGINT` 原生区分 |
| 类型系统 | 强类型 | 类型亲和（type affinity）；`DATETIME` 存为文本 / 数值，`DECIMAL` 退化为亲和存储，金额精度由 ORM / 应用层兜底 |
| 外键 | 默认 InnoDB 外键生效 | 默认**关闭**，须连接后执行 `PRAGMA foreign_keys = ON;` 才生效 |
| 字符集 | `utf8mb4` | 内部即 UTF-8，无需声明 collation |
| 分页语法 | `LIMIT n OFFSET m` | 同为 `LIMIT n OFFSET m`，兼容 |
| 并发 | 行锁、多连接池 | 库级写锁，写并发极低，连接池设为小 |

- 验证门：文件库可反复删除 `.db` 文件后从零回放基线脚本；连接自检 `SELECT 1;`。

## 3. ORM 切换时的配对注意点

- **方言声明**：三个 ORM 挂载点的代码均以 MySQL 方言为默认；切 PostgreSQL 时把连接串与方言换成 PostgreSQL 方言，SQL 里的反引号、`LIMIT/OFFSET`、`ON UPDATE` 列行为需复查。
- **自增主键**：ORM 主键策略要与目标库一致——MySQL 用自增列，PostgreSQL 用 identity / serial，SQLite 用 rowid 别名；ORM 的 `autoincrement` / `identity` 注解须随方言调整。
- **`updated_at` 自动维护**：MySQL 靠列 `ON UPDATE`，PostgreSQL / SQLite 无此列行为，需改为 ORM 层事件钩子或触发器维护，挂载点代码中相应替换。
- **软删除唯一键**：切 PostgreSQL 优先改部分唯一索引；SQLite 也支持部分索引，可同法。
- 配对仍遵循：Java（MyBatis/JPA）、Python（SQLAlchemy 2.x）、前端（Prisma）各自的数据访问层，只换连接串与方言，**不改业务代码结构**。
