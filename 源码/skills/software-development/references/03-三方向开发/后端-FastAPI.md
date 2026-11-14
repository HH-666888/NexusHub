# Python-FastAPI 后端主干分支

> 本文件是后端 Python 栈（FastAPI 生态）的分支规则书，在工序③ 内执行：原型判定通过（`原型开发.md` §五）后按本文做项目初始化与代码生成；接口实现以锁定原型推导的接口定义（`接口设计.md`）为输入。
> 通用工程约定（统一返回体结构、错误码分段、分页参数、JWT 协议、日志字段、命名总则、HTTP 状态码语义）的权威定义在
> `references/横切约定/` 下 7 个同名文件；本文件只写本栈实现方式并显式引用其路径，不照抄通用规则全文。
> ORM 具体写法（SQLAlchemy 模型、会话、查询）不展开，统一指向
> `references/03-三方向开发/数据库-ORM-Python.md`。

## 目录

- 1. 适用范围与默认技术组合
- 2. 项目初始化（FastAPI 无官方生成器，按官方推荐结构手动初始化）
- 3. 完整目录结构与各层职责
- 4. 命名规范（栈内细则）
- 5. 请求/响应与统一返回体
- 6. 配置管理
- 7. 异常处理
- 8. 日志
- 9. 认证鉴权挂载点
- 10. 有序生成顺序
- 11. 验证门具体动作

---

## 1. 适用范围与默认技术组合

- 命中条件：工序② 技术选型中后端选 Python，或需求指定 Python 接口服务。
- 默认框架：FastAPI（稳定版，官方当前推荐线），ASGI 服务器用 Uvicorn；具体版本由执行模型按"稳定版 + 组件适配"约束判定，不在本文件写死。
- 默认数据校验：Pydantic（随 FastAPI 自带的当前主版本）。
- 默认持久层：SQLAlchemy（见 ORM 挂载点文件）；数据库迁移工具选 Alembic（仅在用户要求迁移脚本时引入，非默认）。
- 默认数据库：MySQL（见 `references/03-三方向开发/数据库-MySQL.md`）。
- 本分支不覆盖：Celery/RQ 异步任务集群、WebSocket 大规模推送、第三方微服务编排；命中即判定超出规模边界，触发工序② 回流。

## 2. 项目初始化（FastAPI 无官方生成器，按官方推荐结构手动初始化）

FastAPI 官方无类似 Spring Initializr 的生成器；按官方文档"更大应用结构（Bigger Applications - Multiple Files）"推荐布局手动建工程。

1. **环境准备**
   - 创建工程目录，目录名 kebab-case。
   - 在工程目录内建虚拟环境：`python -m venv .venv`（Windows 用 `.venv\Scripts\activate`）。
   - 激活后安装依赖：`pip install fastapi uvicorn[standard] pydantic-settings sqlalchemy pymysql cryptography python-jose passlib python-multipart`（具体包清单由执行模型按当前生态补全，版本不锁死）。
   - 用 `pip freeze > requirements.txt` 固化依赖清单。
2. **包结构初始化**：按第 3 节树形图建 `app/` 包与各子包，每个子包放空 `__init__.py`。
3. **入口**：`app/main.py` 中创建 `FastAPI()` 实例，挂载路由与异常处理器；此时可先只挂一个 `/health` 探针。
4. **环境文件**：在工程根放 `.env`（不入库）与 `.env.example`（入库，仅列键名）。

## 3. 完整目录结构与各层职责

```
<工程名>/
├── requirements.txt
├── .env
├── .env.example
├── .gitignore
└── app/
    ├── __init__.py
    ├── main.py                 # 入口：创建 FastAPI 实例、挂载路由与异常处理器、注册中间件
    ├── core/                   # 配置与安全核心
    │   ├── __init__.py
    │   ├── config.py           # pydantic-settings 读取环境变量
    │   ├── security.py         # JWT 生成/校验、密码哈希
    │   └── logging.py          # 日志格式与 traceId 配置
    ├── models/                 # SQLAlchemy ORM 模型（与表一一映射）
    │   ├── __init__.py
    │   └── user.py
    ├── schemas/               # Pydantic 校验模型（入参/出参）
    │   ├── __init__.py
    │   ├── common.py           # 分页请求、统一返回体 schema
    │   └── user.py
    ├── crud/                   # 数据访问层：纯数据库操作，不写业务
    │   ├── __init__.py
    │   └── user.py
    ├── services/              # 业务逻辑层：编排 crud、事务边界、规则判断
    │   ├── __init__.py
    │   └── user.py
    ├── api/                    # 路由聚合层
    │   ├── __init__.py
    │   └── v1/
    │       ├── __init__.py
    │       ├── router.py       # 汇总 v1 下各业务 router
    │       └── routes/
    │           ├── __init__.py
    │           ├── auth.py
    │           └── users.py
    ├── deps/                   # 依赖注入：数据库会话、当前用户、分页参数
    │   ├── __init__.py
    │   ├── db.py
    │   └── auth.py
    └── utils/                 # 无状态工具函数
        ├── __init__.py
        └── trace.py
```

各层职责边界：

- **api/routes**：协议层。声明路由、解析入参（Pydantic 自动校验）、调用 service、把结果包成统一返回体。
- **services**：业务规则、跨实体编排、事务边界；输入输出使用 schemas。
- **crud**：单表增删改查，接收 SQLAlchemy Session，返回 model 实例；ORM 写法见 ORM 挂载点文件。
- **models**：SQLAlchemy ORM 模型，与表结构一一对应。
- **schemas**：Pydantic 模型——入参 schema 承载校验规则，出参 schema 按需取字段。
- **core**：配置、安全（JWT/哈希）、日志。
- **deps**：FastAPI 依赖注入（`Depends`）提供者：DB 会话工厂、当前登录用户、分页参数解析。
- **utils**：无状态工具函数。

## 4. 命名规范（栈内细则）

通用规则（工程名 kebab-case、URL 前缀 `/api/v1/`、资源名词复数小写、表名/字段名下划线）见
`references/横切约定/命名规范/命名规范.md`，本文件只补 Python 栈内细则：

- 模块/文件名、函数名、变量名 snake_case；类名 UpperCamelCase；常量 UPPER_SNAKE_CASE。
- schemas 内类命名：入参后缀 `Create` / `Update` / `Query`，出参后缀 `Response`（如 `UserCreate`、`UserResponse`）。
- crud / services / models 文件名 = 业务名单数（`user.py`）；路由文件 = 资源复数（`users.py`）。
- 路由前缀统一 `/api/v1/`，由 `api/v1/router.py` 聚合后在 `main.py` 一次性挂载。
- JSON 报文命名遵循接口规范 §2.1：协议字段（信封、分页、令牌）snake_case，业务对象字段 camelCase。落地方式：SQLAlchemy 模型表名与字段名 snake_case；Pydantic 模型内部字段 snake_case（Python 惯例），业务出参 schema 用 `alias` 输出 camelCase（`model_config = ConfigDict(populate_by_name=True)`），协议字段天然 snake_case。

## 5. 请求/响应与统一返回体

统一返回体结构、错误码分段（10001–10005 通用，11000 起业务分段）、分页参数与分页 data 结构的权威定义见
`references/横切约定/接口规范/接口规范.md`。本栈落地代码如下。

**`schemas/common.py`**（统一返回体，不可改结构）：

```python
from typing import Generic, TypeVar, Optional, List
from pydantic import BaseModel

T = TypeVar("T")

class Result(BaseModel, Generic[T]):
    code: int = 0
    message: str = "success"
    data: Optional[T] = None

def ok(data=None) -> dict:
    return {"code": 0, "message": "success", "data": data}

def err(code: int, message: str) -> dict:
    return {"code": code, "message": message, "data": None}
```

错误码常量集中放 `core/config.py` 或 `schemas/common.py`：`PARAM_ERROR=10001`、`UNAUTHORIZED=10002`、`FORBIDDEN=10003`、`NOT_FOUND=10004`、`CONFLICT=10005`；业务模块错误码从 11000 起按模块分段追加。

分页请求参数固定 `page`（从 1 开始）、`page_size`（默认 10，上限 100）；分页 data 固定 `{"list":[],"total":0,"page":1,"page_size":10}`，由 `deps/` 解析后传入 service。

**路由示例**：

```python
# api/v1/routes/users.py
from fastapi import APIRouter, Depends
from schemas.common import Result, ok
from schemas.user import UserResponse
from services.user import UserService
from deps.auth import get_current_user

router = APIRouter(prefix="/users", tags=["users"])

@router.get("/{id}", response_model=Result[UserResponse])
def get_user(id: int, _user=Depends(get_current_user)):
    return ok(UserResponse.model_validate(UserService.get(id)))
```

HTTP 状态码语义对齐 400 / 401 / 403 / 404 / 409 / 500；业务错误抛出自定义异常由异常处理器收口（见第 7 节）。

## 6. 配置管理

多环境、`.env`、密钥不入库的总则见 `references/横切约定/配置管理/配置管理.md`。本栈落地：

- 使用 `pydantic-settings`：`core/config.py` 中声明 `Settings(BaseSettings)`，字段与环境变量同名大写映射：
  ```python
  from pydantic_settings import BaseSettings

  class Settings(BaseSettings):
      env: str = "dev"                # DEV / PROD
      database_url: str
      jwt_secret: str
      jwt_algorithm: str = "HS256"
      access_token_expire_minutes: int = 120   # 与认证鉴权默认一致（JWT_EXPIRE_MINUTES=120）
      server_port: int = 8000

      class Config:
          env_file = ".env"

  settings = Settings()
  ```
- 环境切换通过 `ENV` 环境变量；`.env` 不入库，`.env.example` 只列键名。
- 数据库 URL、JWT 密钥等敏感配置走环境变量。
- 全工程统一从 `core.config.settings` 读配置，`os.getenv` 集中在配置模块。

## 7. 异常处理

全局异常拦截机制与标准异常返回格式见 `references/横切约定/异常处理/异常处理.md`。本栈落地：

- 自定义业务异常 `class BusinessException(Exception)`，携带 `code` 与 `message`。
- 在 `main.py` 中用 `@app.exception_handler` 注册处理器，把异常转成 `JSONResponse`，HTTP 状态码按错误码映射（10001→400、10002→401、10003→403、10004→404、10005→409）：

```python
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

@app.exception_handler(BusinessException)
async def handle_business(_: Request, exc: BusinessException):
    status = {10001:400, 10002:401, 10003:403, 10004:404, 10005:409}.get(exc.code, 400)
    return JSONResponse(status_code=status, content=err(exc.code, exc.message))

@app.exception_handler(RequestValidationError)
async def handle_validation(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=400, content=err(10001, "参数校验失败"))

@app.exception_handler(Exception)
async def handle_unexpected(_: Request, exc: Exception):
    return JSONResponse(status_code=500, content=err(50000, "系统繁忙，请稍后重试"))
```

- 业务错误抛 `BusinessException`，统一返回体由异常处理器组装，路由内不手写 `JSONResponse`。
- 未捕获系统异常（兜底 `Exception` 处理器）统一返回 `code=50000` 与模糊提示；异常详情只记服务端日志，返回体不暴露内部信息（堆栈、SQL、内部路径等）。

## 8. 日志

日志级别、统一字段（时间|级别|traceId|类或模块|消息）、生产默认 INFO、敏感字段脱敏的总则见
`references/横切约定/日志规范/日志规范.md`。本栈落地：

- 在 `core/logging.py` 配置标准 `logging`，format 字符串对齐统一字段，traceId 从 `contextvars` 取：
  ```
  "%(asctime)s|%(levelname)s|%(trace_id)s|%(name)s|%(message)s"
  ```
- traceId 由 `main.py` 中自定义中间件在请求入口生成（uuid4）写入 contextvar，响应头回写 `X-Trace-Id`。
- 生产默认 `level=INFO`，dev 可 `DEBUG`。
- 入参日志只打 schema 类名与关键字段；密码、token、完整身份证/银行卡等敏感字段脱敏后输出。

## 9. 认证鉴权挂载点

JWT 协议（`Authorization: Bearer <token>`）、登录与公开接口白名单的总则见
`references/横切约定/认证鉴权/认证鉴权.md`。本栈挂载点：

- 工具：`core/security.py` 提供 `create_access_token(subject)` 与 `decode_token(token)`，用 `python-jose` 实现。
- 依赖：`deps/auth.py` 中 `oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")`，并写 `get_current_user` 依赖——解析 Bearer token、校验、返回当前用户；失败抛 `BusinessException(10002)`。
- 白名单：在路由层通过"受保护路由显式声明 `Depends(get_current_user)`"实现；登录与公开路由不挂该依赖。
  ```python
  # 受保护路由
  @router.get("/me", response_model=Result[UserResponse])
  def me(current=Depends(get_current_user)):
      return ok(current)
  ```
- 权限粒度（角色校验）写在 service 层，拒绝时抛 `BusinessException(10003)`。

## 10. 有序生成顺序

本文按以下落码顺序逐层产出，前一层闭合后才进入下一层：

1. **core**：先写 `config.py`（Settings）、`security.py`（JWT/哈希）、`logging.py`（日志配置），并在 `main.py` 中把日志与异常处理器骨架挂上。
2. **models**：按表结构写 SQLAlchemy 模型；ORM 写法见 `references/03-三方向开发/数据库-ORM-Python.md`。
3. **schemas**：写 Pydantic 入参/出参模型与 `schemas/common.py` 统一返回体。
4. **crud**：写数据访问函数，签名与后续 service 调用对齐。
5. **services**：写业务函数，编排 crud 与规则。
6. **api/routes**：按资源写各业务 router（`auth.py`、`users.py` …），在 `api/v1/router.py` 汇总，在 `main.py` 以 `/api/v1` 前缀挂载。
7. **deps**：补全 `deps/db.py`（会话工厂）、`deps/auth.py`（get_current_user）、分页参数依赖，并把 routes 中用到的依赖接好。

> 说明：`main.py` 与 `requirements.txt` 在项目初始化时已生成骨架；本节在业务层生成完成后回到 `main.py` 做最终路由挂载与中间件装配校验。

## 11. 验证门具体动作

验证门合格线见 SKILL.md §4.2；本栈具体命令与判定标准如下。

0. **环境预检**：`python --version`（3.10+）、`pip --version` 可执行，MySQL 可连。缺 Python / 包管理器 / 数据库时直接报告缺什么、怎么装，不得跳过。
1. **依赖安装**
   - 命令：`python -m venv .venv` → 激活 → `pip install -r requirements.txt`。
   - 判定：退出码 0，无 `ERROR: Could not find a version` / `ResolutionImpossible`；出现冲突按报错包名调整版本约束后重跑。
2. **服务启动**
   - 命令：`uvicorn app.main:app --reload --port 8000`（生产形态 `--host 0.0.0.0 --port 8000` 不带 `--reload`）。
   - 判定：日志出现 `Application startup complete` 且无 traceback；访问 `http://localhost:8000/docs` 能打开 Swagger UI；数据库连接成功。
3. **接口连通**（直接执行 `references/05-自动化测试/接口示例测试.md` 中的标准示例）
   - 白名单连通：`curl -i -X POST http://localhost:8000/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"...","password":"..."}'`，期望 200，body 含 `"code":0` 与 token。
   - 受保护接口连通：`curl -i http://localhost:8000/api/v1/users/1 -H "Authorization: Bearer <token>"`，期望 200，body 为统一返回体且 `data` 结构与 `UserResponse` 一致。
   - 负例：不带 token 访问受保护接口，期望 HTTP 401 且 body `code=10002`。
   - 参数校验负例：入参缺字段，期望 HTTP 400 且 body `code=10001`。
4. **回流定位**：任一动作失败，按 SKILL.md §2.4 判定回流表定位到工序③ 对应步骤（脚手架/目录或具体文件），携带完整报错重过本门；同一道门连续 3 次不通过按 SKILL.md §2.5 止损。
