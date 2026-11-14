# MySQL 数据层分支

本文件是「数据库」分支的主干，定义 MySQL 作为主数据库时，建表、迁移、命名、配置与验证门的可直接执行规则。**执行时机**：原型判定通过（`原型开发.md` §五）后，按 `数据建模.md`（以锁定原型为输入）产出的表结构清单建表。ORM 如何挂载到本分支见 `references/03-三方向开发/` 下三个同名文件；PostgreSQL / SQLite 的差异见 `references/03-三方向开发/数据库-PG-SQLite.md`。

通用横切规则不在本文件重复，出现以下主题时一律以权威定义为准：命名规范、接口规范、配置管理、异常处理、日志规范、认证鉴权、接口示例测试（路径见 `references/横切约定/` 下 7 个同名文件）。本文件只写数据层落地。

## 目录

- [1. 适用范围与技术选型定位](#1-适用范围与技术选型定位)
- [2. 版本约束](#2-版本约束)
- [3. 建表脚本与迁移脚本的目录约定](#3-建表脚本与迁移脚本的目录约定)
- [4. 引擎、字符集、排序规则统一要求](#4-引擎字符集排序规则统一要求)
- [5. 表与字段命名约定](#5-表与字段命名约定)
- [6. 通用字段约定](#6-通用字段约定)
- [7. 索引 / 唯一键 / 外键命名规则](#7-索引--唯一键--外键命名规则)
- [8. 完整建表 DDL 示例](#8-完整建表-ddl-示例)
- [9. 配置管理与连接参数](#9-配置管理与连接参数)
- [10. 迁移脚本书写与可重复执行要求](#10-迁移脚本书写与可重复执行要求)
- [11. 验证门具体动作](#11-验证门具体动作)
- [12. 与 ORM 挂载点的配对关系](#12-与-orm-挂载点的配对关系)

---

## 1. 适用范围与技术选型定位

- 本分支用于流程编排中「技术选型」阶段判定为 **MySQL** 作为主业务库的项目。
- MySQL 是关系型主库默认选项，承载业务事务数据；缓存、搜索、消息队列等非本分支职责。
- 进入本分支后，按渐进披露顺序执行：先定版本约束 → 目录约定 → DDL → 配置 → 验证门。任一步不满足即判定回流到技术选型阶段重选。

## 2. 版本约束

- 只选用 MySQL **稳定长期支持大版本**（官方当前推荐的 GA 主线），不使用预发布、RC、已停止官方维护的版本。
- 具体大版本号由执行模型在脚手架生成时按「官方当前推荐 + 组件适配」原则判定，本文件不写死。
- 约束：必须支持 `utf8mb4` 与 `utf8mb4_0900_ai_ci` 类排序规则；必须支持外键约束、二级索引、事务。
- 驱动 / 客户端版本与所选大版本做适配校验，与服务端主版本对齐。

## 3. 建表脚本与迁移脚本的目录约定

按通用迁移工具布局，不绑定某一品牌锁死版本。在仓库根下建立统一目录：

```
数据库迁移/
├── baseline/                # 基线：从零建库建表的全套 DDL（可一次初始化空库）
│   └── 001_init_core.sql
├── migrations/              # 增量迁移：按时间顺序的向前变更脚本
│   ├── 002_add_user_index.sql
│   └── 003_add_order_table.sql
├── rollback/                # 回滚脚本（与增量一一对应，可选但建议）
└── README 不放本目录（本分支不生成多余说明文件）
```

规则：

- 文件名使用**递增前缀序号 + 语义名**；序号提交后固定顺序，新脚本追加在末尾。
- `baseline/` 描述「当前最新全量结构」，用于新环境一次性初始化；`migrations/` 描述「从历史结构演进到当前」的增量。
- 每个脚本单事务优先（DDL 在 MySQL 中多为隐式提交，故脚本须做到**自身幂等或明确初始化顺序**，见第 10 节）。
- 生产表结构变更走迁移脚本并经验证门；应用运行时 ORM 不自动 `drop` / 重建生产表。

## 4. 引擎、字符集、排序规则统一要求

- 存储引擎统一 `InnoDB`（事务、外键、行锁）。
- 库与表字符集统一 `utf8mb4`，排序规则统一 `utf8mb4_0900_ai_ci`（若所选大版本不提供该 collation，则选用该版本官方默认的 `utf8mb4` 系列大小写不敏感排序规则）。
- 每张建表 DDL 显式声明 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=...`，不依赖服务端默认值。
- 连接串与排序规则一致，避免「库表 utf8mb4、连接 latin1」导致的乱码。

## 5. 表与字段命名约定

- 库名、表名、字段名一律**全小写 snake_case**；单词间用单个下划线。
- 表名用**单数业务名词**（如 `sys_user`、`biz_order`、`biz_order_item`）。
- 表名不与 SQL 保留字冲突；如业务词恰好是保留字（`order`、`group`、`user` 等），加业务前缀规避，不要靠反引号绕过。
- 字段名见名知义：外键字段取业务实体名 + `_id`（业务前缀不计），如 `user_id`、`order_id`。
- 布尔语义字段用 `is_` / `has_` 前缀；时间字段用 `_at` / `_time` 后缀；金额字段单位与精度在 DDL 注释中写明。

## 6. 通用字段约定

每张业务表必须包含以下审计字段，类型固定：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | 主键，统一无符号自增 |
| `created_at` | `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` | 创建时间，毫秒精度 |
| `updated_at` | `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` | 更新时间 |
| `deleted_at` | `DATETIME(3) NULL DEFAULT NULL` | 软删除标记；`NULL` 表示未删除，非 `NULL` 表示已删除 |

规则：

- 主键统一用 `id`，业务唯一编号（如订单号）另立字段并加唯一键，不暴露自增 ID 给外部。
- 软删除用「时间戳为空」语义，而非布尔标记，便于保留删除时点；唯一键需与软删除策略兼容（见第 7 节）。
- 金额用 `DECIMAL(18,4)` 或业务约定精度。
- 状态类字段用 `TINYINT` 或小长度 `VARCHAR`，取值集合在表注释中枚举说明。

## 7. 索引 / 唯一键 / 外键命名规则

- 普通二级索引前缀 `idx_`：`idx_<表名简称>_<字段列>`，如 `idx_biz_order_user_id`。
- 唯一键前缀 `uk_`：`uk_<表名简称>_<字段列>`，如 `uk_sys_user_active_username`。
- 外键约束名前缀 `fk_`：`fk_<本表>_<引用表>`，如 `fk_biz_order_sys_user`。
- 联合索引按最左前缀顺序写字段，命名中体现主要字段即可；避免单表索引数量失控。
- 软删除与唯一键共存：MySQL 中 `UNIQUE(username, deleted_at)` **不能**保证未删除行唯一（NULL 互不相等）。必须用生成列把「未删除时的值」抽出来再建唯一键（示例 `active_username`），或使用非 NULL 哨兵值；PostgreSQL 可直接用部分唯一索引（`WHERE deleted_at IS NULL`）。
- 外键默认 `ON DELETE` 取受限或按业务明确设定；级联删除在表注释中显式说明。

## 8. 完整建表 DDL 示例

```sql
CREATE TABLE IF NOT EXISTS `sys_user` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `username`    VARCHAR(64)     NOT NULL COMMENT '登录名，业务唯一',
  `email`       VARCHAR(255)    DEFAULT NULL COMMENT '邮箱',
  `status`      TINYINT         NOT NULL DEFAULT 1 COMMENT '状态：1启用 2禁用',
  `created_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  `deleted_at`  DATETIME(3)     DEFAULT NULL COMMENT '软删除时间，NULL 表示未删除',
  `active_username` VARCHAR(64) GENERATED ALWAYS AS (IF(`deleted_at` IS NULL, `username`, NULL)) STORED COMMENT '未删除时的登录名，用于唯一约束',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sys_user_active_username` (`active_username`),
  KEY `idx_sys_user_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户表';

CREATE TABLE IF NOT EXISTS `biz_order` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `order_no`    VARCHAR(32)     NOT NULL COMMENT '对外订单号，业务唯一',
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '下单用户',
  `amount`      DECIMAL(18,4)   NOT NULL DEFAULT 0.0000 COMMENT '订单金额，单位元',
  `status`      TINYINT         NOT NULL DEFAULT 0 COMMENT '状态：0待支付 1已支付 2已取消',
  `created_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `updated_at`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  `deleted_at`  DATETIME(3)     DEFAULT NULL COMMENT '软删除时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_biz_order_order_no` (`order_no`),
  KEY `idx_biz_order_user_id` (`user_id`),
  CONSTRAINT `fk_biz_order_sys_user` FOREIGN KEY (`user_id`) REFERENCES `sys_user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订单表';
```

登录相关的技术表（如 `auth_refresh_token`）按同一节约定创建，字段定义见 `references/横切约定/认证鉴权/认证鉴权.md` §6.4；该表的失效语义用 `revoked_at` 而非 `deleted_at`。

## 9. 配置管理与连接参数

- 数据库连接项全部走环境变量，写入 `.env`（密钥不入库、不进版本库），多环境 `dev` / `prod` 分离。配置管理权威见 `references/横切约定/配置管理/配置管理.md`。
- 必备连接变量：
  - `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`
  - `DB_POOL_SIZE`、`DB_POOL_MAX_OVERFLOW`（或对应驱动的池参数）
  - 可选 `DB_SSL_MODE`、`DB_TIMEZONE`
- 连接串示例（占位，不写死驱动细节）：`jdbc:mysql://${DB_HOST}:${DB_PORT}/${DB_NAME}?...` 或对应语言驱动 URL。
- 连接串统一带字符集与时区参数，保证 `utf8mb4` 与服务端时区一致。
- 生产环境启用连接池上限与空闲回收；每个请求复用连接池连接。

## 10. 迁移脚本书写与可重复执行要求

- 增量脚本只做**向前变更**（`ALTER`、新增表 / 列 / 索引），不在脚本里改历史脚本。
- 脚本须满足二选一：**可重复执行**（幂等，如 `CREATE TABLE IF NOT EXISTS`、`ADD COLUMN` 前做存在性判断），或**明确初始化顺序**（脚本编号即执行顺序，由迁移工具记录已执行版本，绝不重复跑）。
- 破坏性变更（删列、改类型）分两步执行：先兼容发布双写，再在下一窗口下线旧列。
- 大表变更须评估锁表影响，必要时采用在线变更策略；脚本中注释说明预估影响。

## 11. 验证门具体动作

进入阶段关卡前，必须执行并通过以下验证门：

0. **环境预检**：`mysql --version` 能输出客户端版本；用第 9 节连接参数执行 `SELECT VERSION();` 能返回服务端版本；目标库存在且当前账号有建表权限。缺客户端或连不上时直接报告，不得跳过。
1. **从头完整执行**：在空库上跑通 `baseline/` 全套 DDL（或迁移工具从空库回放全部 `migrations/`），无报错。
2. **可重复 / 顺序校验**：按第 10 节规则，确认脚本要么幂等可重跑、要么由迁移工具保证只执行一次且顺序正确。幂等脚本必须**连续执行两次**均成功；非幂等脚本必须提供迁移工具的执行记录（版本表）作为证据。
3. **表结构核验命令**：
   - `SHOW TABLES;` 核对表清单与预期一致。
   - `SHOW CREATE TABLE <表名>;` 核对引擎、字符集、排序规则、主键、外键、索引与 DDL 示例一致。
   - 抽样 `SHOW INDEX FROM <表名>;` 核对 `idx_` / `uk_` 命名。
4. **连接自检**：用第 9 节环境变量从应用侧建连成功，执行一次 `SELECT 1;`。
5. 任一失败即判定回流，修复后重跑整条验证门。

## 12. 与 ORM 挂载点的配对关系

- Java 侧：MyBatis / MyBatis-Plus 或 JPA，二选一，均对接本 MySQL 分支 → 见 `references/03-三方向开发/数据库-ORM-Java.md`。
- Python 侧：SQLAlchemy 2.x → 见 `references/03-三方向开发/数据库-ORM-Python.md`。
- 前端侧：Prisma → 见 `references/03-三方向开发/数据库-ORM-Prisma.md`。
- 切换到 PostgreSQL / SQLite 时的字段类型与分页语法差异 → 见 `references/03-三方向开发/数据库-PG-SQLite.md`。
