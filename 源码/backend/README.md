# backend

FastAPI + MySQL 后端。目录与依赖方向见 [`docs/04-目录结构.md`](../docs/04-目录结构.md)，接口与数据层见
[`docs/03-前后端分离契约书.md`](../docs/03-前后端分离契约书.md) 与
[`docs/05-数据库契约.md`](../docs/05-数据库契约.md)。

当前状态：**骨架**。健康检查、错误信封、分页游标、领域模型已落地并有测试；
认证、运行、工序、RAG 随迁移逐刀补齐（顺序见契约书附录 A）。

## 本地起服

```bash
# 0) 建库与专用账号（只需一次；root 密码按你本机实际的来）
mysql -u root -p -e "
  CREATE DATABASE IF NOT EXISTS nexus DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  CREATE DATABASE IF NOT EXISTS nexus_test DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  CREATE USER IF NOT EXISTS 'nexus'@'127.0.0.1' IDENTIFIED BY 'nexus';
  GRANT ALL PRIVILEGES ON nexus.* TO 'nexus'@'127.0.0.1';
  GRANT ALL PRIVILEGES ON nexus_test.* TO 'nexus'@'127.0.0.1';"

# 1) 依赖（建议虚拟环境）
python -m venv .venv
.venv/Scripts/activate          # Windows；Linux/macOS 用 source .venv/bin/activate
pip install -e ".[dev]"

# 2) 配置
cp .env.example .env            # 填 DATABASE_URL 与 DEEPSEEK_API_KEY

# 3) 建表
alembic upgrade head

# 4) 跑起来
uvicorn app.main:app --reload --port 8000
```

打开 <http://127.0.0.1:8000/api/v1/docs> 看接口文档，<http://127.0.0.1:8000/api/v1/health> 看健康状态
（`db` 为 `"ok"` 才算真的连上库）。

> `nexus_test` 只给集成测试用：测试会清空它的表，**别把它指到开发库上**。

## 验证

```bash
pytest -m "not integration"   # 不需要数据库：领域模型、事件、共享内核、认证业务规则
pytest -m integration         # 需要 MySQL：走真实 repo 与 HTTP 端点
ruff check . && ruff format --check .
lint-imports                  # 依赖方向 D1–D5（见目录契约 §4）
```

## 目录速查

| 目录 | 放什么 |
|---|---|
| `app/domain/` | 对外契约（Pydantic），不 import 项目内任何模块 |
| `app/shared/` | 错误信封、SSE、ID、时间、分页、上限、健康检查 |
| `app/features/` | 一次请求做完一件事：auth / runs / gate / stream / artifacts / settings |
| `app/pipeline/` | 一次运行的内部时序：六道工序、状态机、事件、续跑 |
| `app/ai/` | 能力：模型、RAG、Agent 工具、成本 |
| `content/playbook/` | RAG 语料（markdown） |
| `migrations/` | Alembic；`0001` 直接执行 `database/schema/001_init.sql` |

## 约定（容易踩的）

- **JSON 一律 camelCase**：Python 侧 snake_case，靠 `ApiModel` 的 alias 生成器输出。
- **时间只有一种表示**：epoch 毫秒整数。
- **只有 `features/*/repo.py` 与 `db/` 能碰 SQLAlchemy**。
- **`pass` 是 Python 关键字**：`CheckResult` 用 `pass_` + 显式 alias 输出成 `pass`。