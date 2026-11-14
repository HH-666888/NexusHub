# Flask-Django 后端扩展分支

> 本文件是后端 Python 栈的扩展分支，覆盖 Flask 与 Django 两种形态。
> **执行时机**：原型判定通过（`原型开发.md` §五）后，在工序③ 内执行；接口实现以锁定原型推导的接口定义（`接口设计.md`）为输入。
> **主干参照**：Python 栈的统一工程约定（统一返回体结构、错误码分段、分页参数、JWT 协议、日志字段、命名总则、HTTP 状态码语义、有序生成思路）以
> `references/03-三方向开发/后端-FastAPI.md` 为准；本文件只写与 FastAPI 主干的差异点与本栈特有挂载方式，不重复主干全文。
> 横切通用规则的权威定义仍在 `references/横切约定/` 下 7 个同名文件。

## 目录

- 1. 适用范围与选型差异
- 2. Flask 形态
- 3. Django 形态
- 4. 与横切约定的衔接
- 5. 验证门差异

---

## 1. 适用范围与选型差异

- 命中条件：工序② 技术选型中后端选 Flask 或 Django。
- 与 FastAPI 主干的关系：二者均为 Python 后端，但**不具备 FastAPI 的自动 OpenAPI、Pydantic 自动校验、原生 async**；以下能力需用扩展生态补齐。
- 选型差异：
  - **Flask**：微内核 + 扩展生态（Blueprint 做路由分组），适合接口服务、小中型 API、对灵活性要求高的项目。
  - **Django**：自带 ORM、Admin、认证、中间件、表单，MTV 结构，适合后台管理系统、内容型系统、强后台表单场景。
- 默认数据库仍为 MySQL；ORM 写法差异见第 2、3 节，SQLAlchemy 部分仍指向 `references/03-三方向开发/数据库-ORM-Python.md`。

## 2. Flask 形态

### 2.1 初始化与目录结构

- 初始化：`pip install flask flask-sqlalchemy flask-migrate flask-jwt-extended pydantic`，`pip freeze > requirements.txt`。
- 采用 **应用工厂模式（app factory）** + **Blueprint** 做路由分组，路由按 Blueprint 分组到各模块。

```
<工程名>/
├── requirements.txt
├── .env / .env.example
└── app/
    ├── __init__.py           # create_app() 应用工厂
    ├── config.py             # 读环境变量（同 FastAPI 主干 settings 思路）
    ├── extensions.py         # db = SQLAlchemy()、jwt = JWTManager() 扩展实例
    ├── models/               # SQLAlchemy 模型（同主干 ORM 挂载点）
    ├── schemas/              # Pydantic 模型（Flask 无自动校验，需在视图中手动 .model_validate）
    ├── services/             # 业务层（同主干分层）
    ├── crud/                 # 数据访问层（同主干分层）
    └── api/
        ├── __init__.py       # api = Blueprint("api", __name__, url_prefix="/api/v1")
        ├── auth.py
        └── users.py
```

### 2.2 与 FastAPI 主干的差异点

- **路由挂载**：用 `Blueprint` 分组，在 `create_app()` 中 `app.register_blueprint(api)`；URL 前缀统一 `/api/v1/`，与主干一致。
- **入参校验**：Flask 不自动校验；在视图函数内手动 `data = UserCreate.model_validate(request.get_json())`，校验失败抛 `BusinessException(10001)`。
- **统一返回体**：手写 `jsonify(Result.ok(data))`；`Result` 结构与主干 `schemas/common.py` 完全一致（`{"code":0,"message":"success","data":{}}`）。
- **认证挂载点**：用 `flask-jwt-extended` 的 `@jwt_required()` 装饰器挂在视图函数上；白名单 = 未加该装饰器的视图；当前用户用 `get_jwt_identity()` 取。
- **异常处理**：用 `@app.errorhandler(BusinessException)` 注册全局处理器，HTTP 状态码按错误码映射，规则同主干第 7 节。
- **日志**：用 `app.logger`，format 对齐主干第 8 节统一字段（时间|级别|traceId|模块|消息）；traceId 用 `before_request` 钩子写入 `g`。
- **无自动 OpenAPI**：不生成 `/docs`；接口文档职能由 `references/05-自动化测试/接口示例测试.md` 中的示例承担。

### 2.3 有序生成顺序

参照 FastAPI 主干第 10 节，把 "api/routes" 一步替换为 "Blueprint 注册"，其余 core → models → schemas → crud → services → api(blueprint) → deps 的落码顺序保持不变。

## 3. Django 形态

### 3.1 初始化与目录结构

- 初始化：在虚拟环境中 `pip install django django-environ djangorestframework drf-spectacular`；`django-admin startproject <project> .` 创建工程根。
- 用 DRF（Django REST Framework）做接口层；Django 自带 ORM 替代 SQLAlchemy。

```
<工程名>/
├── manage.py
├── requirements.txt
├── .env / .env.example
├── <project>/               # 工程配置包
│   ├── settings.py          # 多环境配置（dev/prod 按 DJANGO_ENV 切换）
│   ├── urls.py             # 总路由，统一挂 /api/v1/
│   └── wsgi.py
└── apps/
    ├── common/              # 统一返回体、错误码、分页（与主干 Result/PageResult 对齐）
    └── users/               # 一个业务域 = 一个 Django app
        ├── models.py        # Django ORM 模型
        ├── serializers.py   # DRF Serializer（等价 FastAPI schemas）
        ├── views.py         # 视图（等价 controller）
        ├── services.py      # 业务层（建议手动建，Django 不强制）
        ├── urls.py          # 子路由
        └── admin.py         # 后台注册
```

### 3.2 与 FastAPI 主干的差异点

- **MTV 结构**：Model（models.py）→ Template（本分支不渲染模板，由 DRF 返回 JSON）→ View（views.py）。业务层 services.py 为建议分层，不是 Django 强制；与主干"路由→service→crud"的映射为：views → api/routes，serializers → schemas，models → ORM 模型。
- **ORM**：使用 Django 自带 ORM（`models.Model`、`Manager`、QuerySet），不再使用 SQLAlchemy；建表用 `python manage.py makemigrations && migrate`。
- **Admin**：Django 自带后台，注册 `admin.py` 即可获得管理界面；这是相对 FastAPI/Flask 的显著增量能力，后台管理系统类项目优先选 Django。
- **统一返回体**：在 `apps/common/` 写自定义 DRF `Renderer`，把所有响应包成 `{"code":0,"message":"success","data":{}}`；错误码分段与分页结构对齐主干。
- **认证挂载点**：用 DRF 的 `DEFAULT_AUTHENTICATION_CLASSES` 配 JWT（如 `rest_framework_simplejwt`），视图集通过 `permission_classes` 声明；白名单在 `settings.py` 的 `DEFAULT_PERMISSION_CLASSES` 与具体视图 `permission_classes = [AllowAny]` 中控制。
- **异常处理**：在 `settings.py` 配 `EXCEPTION_HANDLER` 指向自定义 handler，把 `BusinessException` 映射到统一返回体与 HTTP 状态码。
- **日志**：在 `settings.py` 的 `LOGGING` 字典配置 format，对齐主干统一字段。

### 3.3 有序生成顺序

Django 的落码顺序调整为：`settings/urls 骨架 → models（含 migrations）→ serializers → services → views → urls 子路由 → common(renderer/exception handler/auth) → admin 注册`。ORM 具体写法按 Django 官方 ORM 约定，不在本分支展开。

## 4. 与横切约定的衔接

无论 Flask 还是 Django，以下内容与主干 **完全一致，直接复用横切约定文件**：

- 统一返回体 JSON 结构、错误码分段、分页参数与 data 结构 → `references/横切约定/接口规范/接口规范.md`
- 命名（模块 snake_case、类 UpperCamelCase、URL `/api/v1/` 资源复数）→ `references/横切约定/命名规范/命名规范.md`
- `.env`、多环境、密钥不入库 → `references/横切约定/配置管理/配置管理.md`
- 业务异常 + 全局拦截 + HTTP 状态码映射 → `references/横切约定/异常处理/异常处理.md`
- 日志级别与统一字段、生产 INFO、脱敏 → `references/横切约定/日志规范/日志规范.md`
- JWT、Bearer 头、白名单 → `references/横切约定/认证鉴权/认证鉴权.md`

## 5. 验证门差异

验证门合格线仍按 SKILL.md §4.2，仅启动命令差异：

- Flask：`flask run --port 5000`（生产 `gunicorn "app:create_app()" -w 2 -b 0.0.0.0:5000`）；判定：启动无 traceback，示例接口连通并返回统一返回体。
- Django：`python manage.py migrate && python manage.py runserver 8000`；判定：迁移无报错、启动无 traceback、`/api/v1/` 下示例接口连通、`/admin/` 可打开登录页。
- 接口连通的标准示例与负例同 FastAPI 主干第 11 节（白名单 200 / 受保护 200 / 无 token 401）。
