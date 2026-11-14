# Python 侧 ORM 挂载点（SQLAlchemy 2.x）

本文件定义 Python（FastAPI）后端如何把 SQLAlchemy 挂载到 MySQL 分支（主干见 `references/03-三方向开发/数据库-MySQL.md`）。**执行时机**：原型判定通过（`原型开发.md` §五）、`数据建模.md` 产出表结构清单后挂载。采用 SQLAlchemy **2.x 风格**（声明式 `DeclarativeBase`、`select()`、`session.execute()`）。横切规则以 `references/横切约定/` 下同名文件为准，本文件只给依赖、配置、模型 / CRUD 骨架与 FastAPI 会话注入挂载点。

## 目录

- [1. 依赖](#1-依赖)
- [2. engine / session 配置](#2-engine--session-配置)
- [3. models 声明](#3-models-声明)
- [4. CRUD 调用骨架](#4-crud-调用骨架)
- [5. FastAPI deps 会话注入挂载点](#5-fastapi-deps-会话注入挂载点)
- [6. 验证门](#6-验证门)

---

## 1. 依赖

- `sqlalchemy`（2.x 主线稳定版）+ 对应 MySQL 数据库驱动（如 PyMySQL / mysqlclient，版本与服务端适配）。
- FastAPI 项目另装 `fastapi`、`uvicorn`；会话注入依赖 FastAPI 的依赖注入。
- 具体版本由执行模型按「稳定版 + 相互适配」判定，本文件不写死版本号。
- 环境变量读取用 `pydantic-settings`（或等价库），配置管理权威见 `references/横切约定/配置管理/配置管理.md`。

## 2. engine / session 配置

连接项全部走环境变量（`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`），多环境 `dev` / `prod`，密钥不入库。

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"

engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,   # 剔除失效连接
    echo=False,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass
```

- 表结构由 `references/03-三方向开发/` 下迁移脚本管理；`Base.metadata.create_all()` 仅用于本地原型，不管理生产表。

## 3. models 声明

```python
from datetime import datetime
from sqlalchemy import String, SmallInteger, DateTime, BigInteger, func
from sqlalchemy.orm import Mapped, mapped_column

class User(Base):
    __tablename__ = "sys_user"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64))   # 唯一性由 DDL 的 active_username 生成列保证
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[int] = mapped_column(SmallInteger, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(fsp=3), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(fsp=3), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(fsp=3), nullable=True)
```

- 字段名 snake_case 与表列一致；`deleted_at` 为空即未删除（软删除约定见 MySQL 主干第 6 节）。

## 4. CRUD 调用骨架

```python
from sqlalchemy import select
from sqlalchemy.orm import Session

def get_user(db: Session, user_id: int):
    return db.scalar(select(User).where(User.id == user_id, User.deleted_at.is_(None)))

def create_user(db: Session, username: str, email: str | None):
    user = User(username=username, email=email)
    db.add(user)
    db.commit()          # 提交由 service 层控制；此处仅示意
    db.refresh(user)
    return user
```

- 查询统一走 `select()` + `db.scalar()` / `db.scalars()`（2.x 风格），不再使用遗留 `Query` 接口。
- 分页：`page` 从 1 开始、`page_size` 默认 10 上限 100；用 `limit(page_size).offset((page-1)*page_size)`，返回 `{"list":[...],"total":0,"page":1,"page_size":10}`（接口规范权威见 `references/横切约定/接口规范/接口规范.md`）。

## 5. FastAPI deps 会话注入挂载点

把 Session 生命周期绑到请求：请求开始建会话、结束关闭，路由 / 服务通过依赖注入拿到会话。

```python
from fastapi import Depends
from typing import Generator

def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 路由挂载：
# @router.get("/users/{id}")
# def read_user(id: int, db: Session = Depends(get_db)):
#     user = get_user(db, id)
#     ... 组装统一返回体 {"code":0,"message":"success","data":{}}
```

- 挂载关系：`路由 → 服务函数(注入 db) → CRUD → MySQL`。Service 层是业务与事务边界，路由不直接裸写 SQL。

## 6. 验证门

1. 用 `.env` 环境变量建 engine 成功，执行 `db.scalar(select(1))` 返回 1。
2. 模型表名 / 列名与 MySQL 主干 `baseline/` DDL 一致（抽查 `sys_user` 表）。
3. 一次完整写读：`create_user` 提交后 `get_user` 能查到，`created_at` / `updated_at` 由数据库默认值写入。
4. 软删除：`deleted_at` 非空后查询被过滤。
5. 切 PostgreSQL / SQLite 时只改 `DATABASE_URL` 与驱动方言（见扩展文件），失败即回流检查方言与自增主键策略。
