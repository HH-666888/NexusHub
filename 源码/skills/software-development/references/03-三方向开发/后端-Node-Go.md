# Node-Go 后端扩展分支

> 本文件是后端扩展分支，覆盖 Node.js（Express / NestJS）与 Go（Gin / Echo）两种形态。
> **执行时机**：原型判定通过（`原型开发.md` §五）后，在工序③ 内执行；接口实现以锁定原型推导的接口定义（`接口设计.md`）为输入。
> **主干参照**：跨栈通用工程约定（统一返回体结构、错误码分段、分页参数、JWT 协议、日志字段、命名总则、HTTP 状态码语义）的权威定义在
> `references/横切约定/` 下 7 个同名文件；本文件只写 Node/Go 栈的初始化方式、分层结构与挂载点差异，不展开到主干规模。
> Java / Python 主干的分层思想（路由→业务→数据访问）在本分支同构复用，具体代码写法以本文件为准。

## 目录

- 1. 适用范围与选型差异
- 2. Node.js 形态（Express / NestJS）
- 3. Go 形态（Gin / Echo）
- 4. 与横切约定的衔接
- 5. 验证门差异

---

## 1. 适用范围与选型差异

- 命中条件：工序② 技术选型中后端选 Node.js 或 Go。
- 与主干（Java Spring Boot / Python FastAPI）的关系：分层思路同构（路由层 / 业务层 / 数据访问层 / 配置 / 异常 / 日志 / 鉴权），但工程骨架、包管理、启动命令、ORM 生态不同。
- 选型差异：
  - **Node.js**：适合与前端同语言栈、I/O 密集型接口；Express 轻量、无强制结构；NestJS 模块化 + 依赖注入，结构接近 Spring Boot，适合稍大工程。
  - **Go**：适合高并发、单二进制部署、启动快的接口服务；Gin 主流、Echo 为备选；无运行时 ORM 生态，数据访问一般用 `database/sql` + sqlx，或 GORM。
- 默认数据库仍为 MySQL；ORM 挂载点文件以 Java 侧 / Python 侧为准，本分支不展开 ORM 细节，只规定包位置。

## 2. Node.js 形态（Express / NestJS）

### 2.1 初始化

- **Express**：`npm init -y` → 安装 `express cors helmet express-rate-limit jsonwebtoken bcryptjs zod`（版本由执行模型按稳定版约束判定）。无官方生成器，按下方目录手动建工程。
- **NestJS**：用官方 CLI `npx @nestjs/cli new <工程名>` 生成骨架；CLI 生成的 `src/` 即官方结构，工程目录以此为准。

### 2.2 目录结构

Express 手动结构：

```
<工程名>/
├── package.json
├── .env / .env.example
└── src/
    ├── index.js              # 入口：创建 express app、挂中间件、监听端口
    ├── config/               # 读 .env（用 dotenv）
    ├── common/               # Result 统一返回体、错误码常量、分页结构
    ├── middleware/           # 鉴权中间件、错误处理中间件、traceId 中间件
    ├── routes/               # 路由层（/api/v1/...）
    ├── services/             # 业务层
    ├── models/               # ORM 模型 / 表结构映射
    ├── schemas/              # zod 校验 schema（等价 Pydantic）
    └── utils/                # jwt、日志等工具
```

NestJS 用 CLI 生成结构：`src/` 下 `main.ts`（入口）、`app.module.ts`、`common/`（过滤器、拦截器、守卫）、`modules/<resource>/`（controller / service / module / dto / entity）；分层语义与 Express 一致，路由 = controller，业务 = service。

### 2.3 与主干的差异点

- **统一返回体**：在 `common/` 写 `ok(data)` / `err(code, message)` 工具函数，输出与主干完全一致的 `{"code":0,"message":"success","data":{}}`；NestJS 用全局拦截器统一包装。
- **入参校验**：Express 用 zod schema 在路由内手动 `.parse()`；NestJS 用 class-validator 装饰 DTO。校验失败抛业务错误码 10001。
- **异常处理**：Express 用集中错误中间件 `(err, req, res, next) => {...}` 收口；NestJS 用全局 `ExceptionFilter`。HTTP 状态码映射规则同主干（10001→400、10002→401、10003→403、10004→404、10005→409）。
- **认证挂载点**：Express 用中间件 `authMiddleware` 挂在 `/api/**` 路由上，白名单路径数组排除登录与公开接口；NestJS 用 `AuthGuard` + `@Public()` 装饰器。JWT 校验逻辑放 `utils/jwt` 或 `common/security`。
- **日志**：用 pino / winston，format 对齐主干统一字段（时间|级别|traceId|模块|消息）；traceId 由 Express 中间件生成并写入响应头。
- **配置**：`dotenv` 读 `.env`，多环境按 `NODE_ENV` 切 dev/prod，密钥不入库。
- **有序生成顺序**：config → models → schemas → services → routes(controller) → middleware(auth/exception) → common；与 FastAPI 主干顺序同构。

## 3. Go 形态（Gin / Echo）

### 3.1 初始化

- `go mod init <module>`（模块名 kebab-case 或组织路径形式）。
- 安装框架：`go get github.com/gin-gonic/gin`（默认）；Echo 为备选，结构相同。
- 数据访问层用 `database/sql` + sqlx 或 GORM，由执行模型按场景判定；本分支只规定包位置，ORM 写法不展开。

### 3.2 目录结构

```
<工程名>/
├── go.mod / go.sum
├── .env / .env.example
├── cmd/
│   └── server/
│       └── main.go          # 入口：装配路由、中间件、启动 HTTP 服务
└── internal/
    ├── config/              # 读环境变量（用 caarlos0/env 或 viper）
    ├── common/              # Result 统一返回体、错误码常量、分页结构
    ├── middleware/           # 鉴权、日志、traceId、recover 中间件
    ├── handler/             # 路由处理函数（等价 controller）
    ├── service/             # 业务层
    ├── repository/          # 数据访问层
    ├── model/               # ORM 模型 / 表结构映射
    └── pkg/                 # jwt、日志等工具包
```

### 3.3 与主干的差异点

- **统一返回体**：在 `internal/common/` 写 `OK(c, data)` / `Fail(c, code, msg)`，序列化为与主干一致的 JSON；handler 中统一返回体经 `common` 输出，不手写 `c.JSON`。
- **入参校验**：Gin 用结构体 `binding:"required"` 标签；Echo 用 validator；校验失败返回 10001。
- **异常处理**：Go 无全局异常机制，用 **统一错误返回约定**——handler/service 返回 `(data, error)`，在 `middleware/recover` 与 handler 末尾集中把 error 转成统一返回体；业务错误用带 code 的自定义 error 类型。
- **认证挂载点**：用 Gin/Echo 中间件链挂在 `/api/**` 路由组上，白名单路径在路由组装配时显式排除登录与公开接口；JWT 校验放 `pkg/jwt`。
- **日志**：用 `log/slog`（标准库当前推荐）或 zap，输出字段对齐主干统一格式；traceId 由中间件放入 context 并在日志行中带出。
- **配置**：环境变量读取，多环境按 `GO_ENV` 切 dev/prod；端口默认 8080，由 `SERVER_PORT` 覆盖。
- **有序生成顺序**：config → model → repository → service → handler → middleware(auth/exception/log) → cmd/server/main.go 装配。

## 4. 与横切约定的衔接

以下内容与主干 **完全一致，直接复用横切约定文件**，本分支不另立变体：

- 统一返回体 JSON 结构、错误码分段、分页参数与 data 结构 → `references/横切约定/接口规范/接口规范.md`
- 命名（工程 kebab-case、URL `/api/v1/` 资源复数、Go 包名小写、Node 文件名 kebab-case 或 PascalCase 按框架约定）→ `references/横切约定/命名规范/命名规范.md`
- `.env`、多环境、密钥不入库 → `references/横切约定/配置管理/配置管理.md`
- 异常返回格式与 HTTP 状态码映射 → `references/横切约定/异常处理/异常处理.md`
- 日志级别、统一字段、生产 INFO、脱敏 → `references/横切约定/日志规范/日志规范.md`
- JWT、Bearer 头、白名单 → `references/横切约定/认证鉴权/认证鉴权.md`

## 5. 验证门差异

验证门合格线仍按 SKILL.md §4.2，仅依赖安装与启动命令差异：

- **环境预检**：Node 形态 `node -v` / `npm -v`；Go 形态 `go version`。缺工具链直接报告，不得跳过。
- **Node（Express）**：`npm install` → `node src/index.js`（或 `npm run dev` 用 nodemon）。
- **Node（NestJS）**：`npm install` → `npm run start:dev`（生产 `npm run build && npm run start:prod`）。
- **Go**：`go mod download` → `go run ./cmd/server`（生产 `go build -o server ./cmd/server && ./server`）。
- **判定标准**：依赖安装无致命错误；服务启动无 panic/exception 且端口监听；示例接口（白名单登录 200 / 受保护带 token 200 / 无 token 401）按 `references/05-自动化测试/接口示例测试.md` 连通并返回统一返回体。失败按 SKILL.md §2.4 判定回流到工序③ 对应步骤。
