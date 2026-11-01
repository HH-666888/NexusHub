# migrations

Alembic 迁移。表结构的**事实来源**是 `docs/05-数据库契约.md`，可执行版本是 `database/schema/*.sql`。

## 规矩

1. 一版一件事。MySQL 的 DDL 不是事务性的，一次改十张表，失败时很难说清改到哪了。
2. 迁移必须可重复执行（`IF NOT EXISTS` / 先查后建），因为演示环境可能重装。
3. 不在迁移里修业务数据 —— 那是脚本的事，脚本可以回滚，迁移不行。

## 常用命令

```bash
alembic upgrade head                 # 建表
alembic downgrade -1                 # 回退一版
alembic revision -m "add xxx index"  # 新建空迁移，手写 DDL
```

`0001_initial.py` 直接执行 `database/schema/001_init.sql`，不重复抄 DDL。