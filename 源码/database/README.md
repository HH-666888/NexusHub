# database

MySQL 的建表脚本。**表结构的唯一事实来源是 `docs/05-数据库契约.md`**，这里的 SQL 是它的可执行版本，两者必须一致。

```
database/
├─ admin.sql             # 管理员种子（admin / 123456，可重复执行）
└─ schema/
   ├─ 001_init.sql       # 10 张表的完整 DDL（幂等，可重复执行）
   ├─ 002_provisioner.sql # 建库用的供给账号（只有 CREATE/DROP DATABASE）
   └─ 003_runtime.sql    # 运行时记录表（run_databases / run_runtimes）
```

## 怎么用

首次部署（手工方式）：

```bash
mysql -h127.0.0.1 -u root -p -e "CREATE DATABASE IF NOT EXISTS nexus \
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
mysql -h127.0.0.1 -u nexus -p nexus < database/schema/001_init.sql
```

走应用侧迁移（推荐，Alembic）：

```bash
cd backend
alembic upgrade head     # 0001 初始迁移直接执行这份 SQL
```

## 约定

| 项 | 规定 |
|---|---|
| 字符集 | `utf8mb4` / `utf8mb4_0900_ai_ci`（含连接字符集） |
| 时间 | epoch 毫秒 `BIGINT`，不用 `DATETIME` |
| id | 小写十六进制串，列用 `CHARACTER SET ascii COLLATE ascii_bin` |
| 引擎 | InnoDB（唯一） |
| 写脚本的方式 | 只增不删；改字段先改契约文档，再改这里，再写新迁移文件 |

## 与 `frontend/drizzle/` 的关系

`frontend/drizzle/*.sql` 是**迁移前的 SQLite 迁移历史**（当前可运行版本用的仍然是它），
与这里的 MySQL 结构不是同一套东西。后端切换完成后，那份历史归档保留、不再演进。

## 下一步

- `002_seed.sql`：演示账号与默认配置的种子数据（也可以由 `python -m app.seed` 完成，二者选一，不要都写）
- 新增表或字段时，文件名按 `00N_<动词>_<对象>.sql`，例如 `002_add_run_events_index.sql`
## 全栈运行时：供给账号（一次性）

产物的数据库要能建库建表，但不能碰 `nexus` 主库。所以单独一个账号，
权限只够"建库、建用户、给那个库授权"：

```bash
# 1. 把 002_provisioner.sql 里的 __PASSWORD__ 换成随机密码
# 2. 用 root 执行
mysql -u root -p < database/schema/002_provisioner.sql
# 3. 把这个密码写进 backend/.env 的 MYSQL_PROVISIONER_URL
```

`002_runtime.sql` 是运行时自己的两张表（`run_databases` / `run_runtimes`），
由 `alembic upgrade head` 建，不要手工执行。
