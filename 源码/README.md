# 源码

```
源码/
├─ docs/        契约与设计文档（接口 / 目录 / 数据库）
├─ frontend/    Next.js 16 + React 19（当前可运行版本）
├─ backend/     FastAPI + MySQL 8（迁移中，现为骨架）
└─ database/    MySQL 建表脚本
```

## 现在是什么状态

**前端是能跑的完整版本**：说一句需求 → 六道工序 → 可下载的单文件网页。
**后端是骨架**：健康检查、统一错误信封、分页游标、领域模型与测试已就位；
认证、运行、工序、RAG 按契约书附录 A 的六刀顺序逐步搬过去。

两份契约先于代码存在，就是为了让这个替换过程不返工：

| 文档 | 管什么 |
|---|---|
| [`docs/03-前后端分离契约书.md`](docs/03-前后端分离契约书.md) | 接口：请求/响应/错误码/SSE 帧/事件字段 |
| [`docs/04-目录结构.md`](docs/04-目录结构.md) | 位置：文件放哪、谁能 import 谁 |
| [`docs/05-数据库契约.md`](docs/05-数据库契约.md) | 存储：表结构、什么进库什么不进库 |

文档总索引见 [`docs/README.md`](docs/README.md)。

## 跑起来

### 前端（当前功能都在这里）

```bash
cd frontend
npm install
cp .env.example .env.local     # 填 DEEPSEEK_API_KEY；不填也能打开界面
npm run dev                    # http://localhost:3000
```

### 后端（骨架）

```bash
cd backend
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head           # 需要 MySQL 8
uvicorn app.main:app --reload  # http://127.0.0.1:8000/api/v1/health
```

### 三个进程一起（MySQL + 后端 + 前端）

```bash
docker compose up -d
docker compose exec backend alembic upgrade head
# 前端 http://localhost:3000 · 后端 http://localhost:8000/api/v1/health
```

## 验证

```bash
cd frontend && npm run verify   # typecheck + lint + test + build
cd frontend && npm run e2e:auth # 端到端（需要 dev 已启动）
cd backend  && pytest           # 骨架期的契约与共享内核测试
```

## 目录之外的两件事

- **e2e 脚本暂时放在 `frontend/src/scripts/`**：它们要 import 前端的 fixtures 直接造数据。
  等后端切换完成、它们变成纯黑盒（只走 HTTP）之后，再移到仓库根 `scripts/`。
- **`frontend/drizzle/`** 是迁移前 SQLite 的迁移历史，仍在被当前版本使用；
  MySQL 的建表脚本在 `database/schema/`，两套不是一回事，别混。