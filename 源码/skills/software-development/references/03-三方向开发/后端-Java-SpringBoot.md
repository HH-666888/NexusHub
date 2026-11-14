# Java-SpringBoot 后端主干分支

> 本文件是后端 Java 栈（Spring Boot 生态）的分支规则书，在工序③ 内执行：原型判定通过（`原型开发.md` §五）后按本文做脚手架初始化与代码生成；接口实现以锁定原型推导的接口定义（`接口设计.md`）为输入。
> 通用工程约定（统一返回体结构、错误码分段、分页参数、JWT 协议、日志字段、命名总则、HTTP 状态码语义）的权威定义在
> `references/横切约定/` 下 7 个同名文件；本文件只写本栈实现方式并显式引用其路径，不照抄通用规则全文。
> ORM 具体写法（MyBatis / MyBatis-Plus / Spring Data JPA）不展开，统一指向
> `references/03-三方向开发/数据库-ORM-Java.md`。

## 目录

- 1. 适用范围与默认技术组合
- 2. 官方脚手架初始化（Spring Initializr 模式）
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

- 命中条件：工序② 技术选型中后端选 Java，或需求指定 JVM 体系 / Spring 生态。
- 默认框架：Spring Boot（稳定版，官方当前推荐线；具体版本由执行模型按"稳定版 + 组件适配"约束判定，不在本文件写死）。
- 默认构建：Maven 为主；Gradle 仅在用户明确要求时切换，切换后目录与分层规则不变。
- 默认持久层：MyBatis（`mapper` 包 + XML/注解映射）；JPA（`repository` 包）为备选路径，二者择一，同一工程内保持一套持久层会话。
- 默认数据库：MySQL（见 `references/03-三方向开发/数据库-MySQL.md`）；连接池、驱动依赖在初始化时一并选入。
- 本分支不覆盖：微服务组件（注册中心、配置中心、消息集群）、响应式 Web（WebFlux）、网关层；命中即判定超出规模边界，触发工序② 回流。

## 2. 官方脚手架初始化（Spring Initializr 模式）

一律走 Spring Initializr 官方模式生成工程骨架。

1. **坐标选择**
   - groupId：按用户组织反写域名形式（如 `com.example`），无组织信息时使用占位 `com.example` 并在运行说明中标注需替换。
   - artifactId：工程 kebab-case 名（与目录名一致，命名总则见 `references/横切约定/命名规范/命名规范.md`）。
   - packaging：Jar；Java 版本取稳定 LTS。
   - 基础包名：与 groupId + artifactId 展开路径一致（如 `com.example.demo`），后续全部分层包挂在此根包下。
2. **依赖选择（Initializr 勾选清单）**
   - 必选：Spring Web、Spring Boot DevTools（仅 dev）、Validation、Lombok、Configuration Processor。
   - 数据访问（二选一）：
     - 默认路径：MyBatis Framework（或 MyBatis-Plus 起步依赖，由执行模型按当前生态判断）+ MySQL Driver。
     - 备选路径：Spring Data JPA + MySQL Driver；此时持久层包名使用 `repository`。
   - 可选（命中才选）：Spring Security（若不走手写 JWT 拦截器而用 Security 过滤器链）、Spring Boot Actuator（仅在用户要求健康检查时）。
   - 超范围组件不选入：Cloud 系列 starter、WebSocket 集群、批处理 starter 等。
3. **生成后落盘动作**
   - 将 Initializr 生成的工程解压到工程根目录，根目录出现 `mvnw` / `mvnw.cmd`、`pom.xml`、`src/`。
   - 按第 3 节目录结构补齐 `controller/service/mapper/entity/dto/vo/config/exception/common/utils` 空包。
   - 在 `src/main/resources/` 下补 `application.yml`、`application-dev.yml`、`application-prod.yml`；`.env` 放工程根目录（不入库），见第 6 节。
   - MyBatis 路径在 `src/main/resources/` 下补 `mapper/` 目录存放 XML 映射文件。

## 3. 完整目录结构与各层职责

```
<工程名>/
├── pom.xml / build.gradle
├── mvnw / mvnw.cmd
├── .env                        # 环境变量（密钥不入库，加入 .gitignore）
├── .gitignore
└── src/
    ├── main/
    │   ├── java/com/<groupId>/<artifactId>/
    │   │   ├── XxxApplication.java        # 启动类，唯一 @SpringBootApplication
    │   │   ├── controller/                # 控制层：接收请求、参数校验、调用 service、返回统一返回体
    │   │   │   └── UserController.java
    │   │   ├── service/                  # 业务层接口
    │   │   │   ├── UserService.java
    │   │   │   └── impl/                 # 业务层实现
    │   │   │       └── UserServiceImpl.java
    │   │   ├── mapper/                   # 持久层（默认 MyBatis）：Mapper 接口
    │   │   │   └── UserMapper.java
    │   │   ├── repository/                # 持久层（JPA 备选路径）：仅选 JPA 时存在
    │   │   │   └── UserRepository.java
    │   │   ├── entity/                   # 数据库实体（与表一一映射）
    │   │   │   └── User.java
    │   │   ├── dto/                      # 请求入参传输对象（接收前端入参）
    │   │   │   └── UserCreateDTO.java
    │   │   ├── vo/                       # 视图对象（返回前端的出参结构）
    │   │   │   └── UserVO.java
    │   │   ├── config/                   # 配置类：Web/MVC、CORS、拦截器注册、MyBatis、OpenAPI 等
    │   │   │   ├── WebMvcConfig.java
    │   │   │   └── CorsConfig.java
    │   │   ├── exception/                # 全局异常处理与业务异常定义
    │   │   │   ├── BusinessException.java
    │   │   │   └── GlobalExceptionHandler.java
    │   │   ├── common/                   # 公共返回体、错误码常量、分页对象
    │   │   │   ├── Result.java
    │   │   │   ├── ResultCode.java
    │   │   │   └── PageResult.java
    │   │   └── utils/                    # 工具类：JWT、日期、JSON、加密等无状态工具
    │   │       └── JwtUtils.java
    │   └── resources/
    │       ├── application.yml            # 主配置（按 spring.profiles 切换）
    │       ├── application-dev.yml
    │       ├── application-prod.yml
    │       └── mapper/                   # MyBatis XML 映射文件（JPA 路径省略）
    │           └── UserMapper.xml
    └── test/                             # 仅保留启动上下文冒烟测试，不做全量单测
```

各层职责边界：

- **controller**：接收请求、参数校验（`@Validated`）、调用 service、把 service 返回值包成统一返回体。
- **service / service.impl**：业务规则、事务边界（`@Transactional` 标在 impl 方法上）、跨实体编排；接口与实现分离。
- **mapper / repository**：单表数据访问；SQL/ORM 写法见 ORM 挂载点文件。
- **entity**：与表结构一一对应。
- **dto**：入参载体，承载校验注解；**vo**：出参载体，按需取字段。
- **config**：框架级装配（拦截器注册、CORS、序列化、数据源、MyBatis 扫描路径）。
- **exception**：业务异常类 + 全局异常处理器。
- **common**：跨层共享的值对象（统一返回体、错误码枚举、分页结构）。
- **utils**：无状态工具类。

## 4. 命名规范（栈内细则）

通用规则（工程名 kebab-case、URL 前缀 `/api/v1/`、资源名词复数小写、表名/字段名下划线）见
`references/横切约定/命名规范/命名规范.md`，本文件只补 Java 栈内细则：

- 包名全小写，不使用驼峰与下划线；根包 = groupId + artifactId 展开路径。
- 类名 UpperCamelCase：Controller 后缀 `Controller`、Service 接口后缀 `Service`、实现类后缀 `ServiceImpl`、Mapper 接口后缀 `Mapper`、实体用业务名单数（如 `User`）、入参后缀 `DTO`、出参后缀 `VO`、配置类后缀 `Config`、异常类后缀 `Exception`、统一返回体固定名 `Result`。
- 方法名 / 变量名 lowerCamelCase；DTO/VO 字段名 lowerCamelCase，与 JSON 字段一一对应。
- 常量 UPPER_SNAKE_CASE，集中放 `common/ResultCode.java` 或对应常量类。
- MyBatis XML 命名空间 = Mapper 接口全限定名；XML 内 `id` 与 Mapper 方法名一致。

## 5. 请求/响应与统一返回体

统一返回体结构、错误码分段（10001–10005 通用，11000 起业务分段）、分页参数与分页 data 结构的权威定义见
`references/横切约定/接口规范/接口规范.md`。本栈落地代码如下。

**`common/Result.java`**（不可改结构）：

```java
package com.example.demo.common;

import lombok.Data;

@Data
public class Result<T> {
    private Integer code;     // 0 = 成功，非 0 = 业务错误码
    private String message;
    private T data;

    public static <T> Result<T> success(T data) {
        Result<T> r = new Result<>();
        r.setCode(0);
        r.setMessage("success");
        r.setData(data);
        return r;
    }

    public static <T> Result<T> error(Integer code, String message) {
        Result<T> r = new Result<>();
        r.setCode(code);
        r.setMessage(message);
        r.setData(null);
        return r;
    }
}
```

**`common/ResultCode.java`** 错误码常量：`PARAM_ERROR(10001)`、`UNAUTHORIZED(10002)`、`FORBIDDEN(10003)`、`NOT_FOUND(10004)`、`CONFLICT(10005)`；业务模块错误码从 11000 起按模块分段（如用户模块 11001 起），在该枚举内追加。

**`common/PageResult.java`** 分页出参固定字段：`list`、`total`、`page`、`page_size`；请求分页参数接收 `page`（从 1 开始）、`page_size`（默认 10，上限 100，超限收敛到 100）。

**Controller 示例**：

```java
@RestController
@RequestMapping("/api/v1/users")
@Validated
public class UserController {

    @Resource
    private UserService userService;

    @GetMapping("/{id}")
    public Result<UserVO> getById(@PathVariable Long id) {
        return Result.success(userService.getById(id));
    }

    @PostMapping
    public Result<Long> create(@Valid @RequestBody UserCreateDTO dto) {
        return Result.success(userService.create(dto));
    }
}
```

HTTP 状态码语义对齐 400 / 401 / 403 / 404 / 409 / 500；业务错误仍返回对应语义状态码，body 统一为 `Result` 结构。

## 6. 配置管理

多环境、`.env`、密钥不入库的总则见 `references/横切约定/配置管理/配置管理.md`。本栈落地：

- 主配置 `application.yml` 只放共性配置，通过 `spring.profiles.active=${SPRING_PROFILES_ACTIVE:dev}` 切换 dev/prod。
- `application-dev.yml` / `application-prod.yml` 分环境覆盖数据源、端口、日志级别。
- 环境变量通过系统环境变量或 `.env` 注入；`.env` 不提交仓库。数据库 URL、用户名、密码、JWT 密钥一律走环境变量占位，例如：
  ```yaml
  spring:
    datasource:
      url: ${DB_URL}
      username: ${DB_USERNAME}
      password: ${DB_PASSWORD}
  jwt:
    secret: ${JWT_SECRET}
  ```
- 自定义配置项用 `@ConfigurationProperties(prefix = "jwt")` 绑定到 `config/` 下的配置属性类，`@Value` 集中使用。
- Spring Boot 不原生读取 `.env`：本地用启动脚本 / IDE 注入环境变量，或在 `application.yml` 加 `spring.config.import=optional:file:.env[.properties]`，根目录 `.env` 经显式引入后生效。
- 端口默认 8080，由 `SERVER_PORT` 环境变量覆盖。

## 7. 异常处理

全局异常拦截机制与标准异常返回格式见 `references/横切约定/异常处理/异常处理.md`。本栈落地：

- 自定义业务异常 `BusinessException extends RuntimeException`，携带错误码与消息。
- `exception/GlobalExceptionHandler.java` 使用 `@RestControllerAdvice` 统一拦截，返回 `Result.error(...)`，并按异常类型映射 HTTP 状态码：

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<Result<Void>> handleBusiness(BusinessException e) {
        int httpStatus = mapToHttpStatus(e.getCode()); // 10001->400, 10002->401, 10003->403, 10004->404, 10005->409
        return ResponseEntity.status(httpStatus).body(Result.error(e.getCode(), e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Result<Void>> handleValid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldError().getDefaultMessage();
        return ResponseEntity.status(400).body(Result.error(10001, msg));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> handleOther(Exception e) {
        return ResponseEntity.status(500).body(Result.error(50000, "系统繁忙，请稍后重试"));
    }
}
```

- controller/service 不吞异常；业务错误抛 `BusinessException`，由全局处理器统一收口。

## 8. 日志

日志级别、统一字段（时间|级别|traceId|类或模块|消息）、生产默认 INFO、敏感字段脱敏的总则见
`references/横切约定/日志规范/日志规范.md`。本栈落地：

- 使用默认 SLF4J + Logback，不引入其他日志门面。
- `application.yml` 配置 pattern 必须包含 traceId：
  ```yaml
  logging:
    pattern:
      console: "%d{yyyy-MM-dd HH:mm:ss.SSS}|%level|%X{traceId:-}|%logger{36}|%msg%n"
    level:
      root: INFO
  ```
- traceId 由鉴权拦截器或 MDC 过滤器在请求入口写入 `MDC.put("traceId", ...)`，请求结束 `MDC.clear()`。
- 业务代码统一 `private static final Logger log = LoggerFactory.getLogger(Xxx.class);`（或 Lombok `@Slf4j`）。
- 入参日志只打 DTO 类名与关键字段；密码、token、完整身份证/银行卡等敏感字段脱敏后输出。

## 9. 认证鉴权挂载点

JWT 协议（`Authorization: Bearer <token>`）、登录与公开接口白名单的总则见
`references/横切约定/认证鉴权/认证鉴权.md`。本栈挂载点：

- 工具：`utils/JwtUtils.java` 负责生成与校验 token。
- 拦截器：新建 `config/AuthInterceptor.java implements HandlerInterceptor`，在 `preHandle` 中解析 Bearer token、校验有效期、把用户 id 放入请求属性；校验失败直接抛 `BusinessException(10002)`。
- 注册：在 `config/WebMvcConfig.java implements WebMvcConfigurer` 的 `addInterceptors` 中挂载，并声明白名单：
  ```java
  @Override
  public void addInterceptors(InterceptorRegistry registry) {
      registry.addInterceptor(authInterceptor)
              .addPathPatterns("/api/**")
              .excludePathPatterns(
                  "/api/v1/auth/login",
                  "/api/v1/auth/register",
                  "/api/v1/public/**"
              );
  }
  ```
- 登录接口位于 `/api/v1/auth/login`，在白名单内；受保护资源走 `/api/v1/**` 默认拦截。
- 权限粒度（角色校验）在拦截器之后的 service 层判断，拒绝时抛 `BusinessException(10003)`。

## 10. 有序生成顺序

本文按以下落码顺序逐层产出，前一层闭合后才进入下一层；每层产出后立即保证引用关系闭合：

1. **controller**：先建各业务 controller 骨架，声明路由与方法签名（此时 service 方法可暂为空实现）。
2. **service**：写 service 接口，再写 `service/impl` 实现，先空方法体返回占位，与 controller 调用对齐签名。
3. **mapper**：写 mapper 接口（或 JPA 的 repository 接口），方法签名与 service.impl 中调用对齐；MyBatis XML 同步在 `resources/mapper/` 补全。ORM 具体写法见 `references/03-三方向开发/数据库-ORM-Java.md`。
4. **entity**：按表结构写 entity，被 mapper/repository 引用。
5. **dto / vo**：补全 controller 入参 DTO（含校验注解）与出参 VO，替换 controller 中的占位类型。
6. **config**：补全 WebMvcConfig（拦截器注册、CORS）、数据源、MyBatis 扫描、OpenAPI（如需要）。
7. **exception**：补全 `BusinessException` 与 `GlobalExceptionHandler`，把 controller/service 中残留的手写错误返回替换为抛异常。

> 说明：启动类与 `application.yml` 骨架在工程初始化（脚手架）时已生成，本节只补业务层与装配层；业务代码生成完成后统一回到 config 层做最终装配校验。

## 11. 验证门具体动作

验证门合格线见 SKILL.md §4.2；本栈具体命令与判定标准如下。

0. **环境预检**：`java -version` 与 `./mvnw -v`（Windows `mvnw.cmd -v`）可执行；MySQL 可连。缺 JDK / Maven / 数据库时直接报告缺什么、怎么装，不得跳过。
1. **依赖安装**
   - 命令：`./mvnw -q -DskipTests dependency:resolve`（Windows 用 `mvnw.cmd`）。
   - 判定：退出码 0，BUILD SUCCESS；出现下载失败时按报错的具体坐标修正 pom 后重跑。
2. **服务启动**
   - 命令：`./mvnw spring-boot:run`（或先 `./mvnw -DskipTests package` 再 `java -jar target/<artifactId>.jar`）。
   - 判定：日志出现 Started XxxApplication 且无 ERROR 堆栈；端口（默认 8080）正常监听；数据源连接成功。
3. **接口连通**（直接执行 `references/05-自动化测试/接口示例测试.md` 中的标准示例）
   - 白名单连通：`curl -i -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"...","password":"..."}'`，期望 200，body 含 `"code":0` 与 token。
   - 受保护接口连通：`curl -i http://localhost:8080/api/v1/users/1 -H "Authorization: Bearer <token>"`，期望 200，body 为统一返回体且 `data` 结构与 VO 一致。
   - 负例：不带 token 访问受保护接口，期望 HTTP 401 且 body `code=10002`。
4. **回流定位**：任一动作失败，按 SKILL.md §2.4 判定回流表定位到工序③ 对应步骤（脚手架/目录或具体文件），携带完整报错重过本门；同一道门连续 3 次不通过按 SKILL.md §2.5 止损。
