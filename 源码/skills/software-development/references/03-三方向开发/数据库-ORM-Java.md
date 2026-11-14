# Java 侧 ORM 挂载点（MyBatis / MyBatis-Plus 与 JPA）

本文件定义 Java 后端如何把 ORM 挂载到 MySQL 分支（主干见 `references/03-三方向开发/数据库-MySQL.md`）。**执行时机**：原型判定通过（`原型开发.md` §五）、`数据建模.md` 产出表结构清单后挂载。横切的数据源、事务、异常、日志规则以 `references/横切约定/` 下同名文件为准，本文件只给依赖坐标、配置、代码骨架与挂载位置。

## 目录

- [1. 二选一总览](#1-二选一总览)
- [2. 公共前提：数据源配置](#2-公共前提数据源配置)
- [3. 路径 A：MyBatis / MyBatis-Plus](#3-路径-amybatis--mybatis-plus)
- [4. 路径 B：Spring Data JPA](#4-路径-bspring-data-jpa)
- [5. 与 Service 层的挂载关系](#5-与-service-层的挂载关系)
- [6. 验证门](#6-验证门)

---

## 1. 二选一总览

- **MyBatis / MyBatis-Plus（路径 A）**：SQL 可控、复杂查询灵活，适合业务 SQL 较多的项目。MyBatis-Plus 在原生 MyBatis 上提供通用 CRUD，二者同属一条路径，二选一。
- **Spring Data JPA（路径 B）**：面向对象建模、约定优先，适合 CRUD 为主、领域模型清晰的项目。
- 一个项目**只选一条路径**，不要在同一工程混用两套 ORM。与 MySQL 分支直接配对；切 PostgreSQL / SQLite 时只换方言与连接串（见 `references/03-三方向开发/数据库-PG-SQLite.md`）。
- 具体依赖版本由执行模型按「稳定版 + 与所选 Spring / 驱动适配」判定，本文件不写死版本号。

## 2. 公共前提：数据源配置

- 数据库连接项全部走环境变量，写入 `.env`（`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` 等），多环境 `dev` / `prod`，配置管理权威见 `references/横切约定/配置管理/配置管理.md`。
- 数据源配置骨架（`application.yml`，值从环境变量注入）：

```yaml
spring:
  datasource:
    url: jdbc:mysql://${DB_HOST}:${DB_PORT}/${DB_NAME}?useUnicode=true&characterEncoding=utf8mb4&serverTimezone=Asia/Shanghai
    username: ${DB_USER}
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: ${DB_POOL_SIZE:10}
```

- 启用事务管理，Service 层写库方法纳入事务边界。

## 3. 路径 A：MyBatis / MyBatis-Plus

依赖坐标（构建工具按 Maven / Gradle 对应写法，版本按适配判定）：

- 基础：`spring-boot-starter-jdbc` + MyBatis 官方 Spring Boot 起步依赖（`mybatis-spring-boot-starter`）。
- 若选 MyBatis-Plus：替换为 `mybatis-plus-spring-boot3-starter`（与所选 Spring Boot 大版本适配）。
- 驱动：MySQL 官方 JDBC 驱动，版本与服务端大版本适配。

映射扫描配置：在启动类或配置类上声明 Mapper 扫描包：

```java
@MapperScan("com.example.project.**.mapper")
@SpringBootApplication
public class Application { public static void main(String[] args) { SpringApplication.run(Application.class, args); } }
```

实体骨架（表 `sys_user`，字段遵循 snake_case ↔ 驼峰映射，`deleted_at` 软删除）：

```java
@TableName("sys_user")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String username;
    private String email;
    private Integer status;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    @TableLogic
    private LocalDateTime deletedAt;   // 逻辑删除：null=未删除
}
```

> `@TableLogic` 默认按 0/1 处理，`LocalDateTime` 字段必须显式配置：`mybatis-plus.global-config.db-config.logic-delete-value: now()`、`logic-not-delete-value: null`，否则会写入数字导致类型错误。

Mapper 骨架：

```java
public interface UserMapper extends BaseMapper<User> {
    // 简单 CRUD 由 MyBatis-Plus 提供；复杂 SQL 写 XML 或 @Select
    @Select("SELECT id, username, status FROM sys_user WHERE id = #{id} AND deleted_at IS NULL")
    User selectActiveById(Long id);
}
```

## 4. 路径 B：Spring Data JPA

依赖坐标：`spring-boot-starter-data-jpa` + MySQL JDBC 驱动（版本适配）。

数据源与上方公共配置一致；补充 JPA 配置：

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate        # 生产/开发均只校验，不自动建表；表结构一律走迁移脚本
    open-in-view: false
    properties:
      hibernate:
        dialect: org.hibernate.dialect.MySQLDialect
```

实体骨架：

```java
@Entity
@Table(name = "sys_user")
@SQLRestriction("deleted_at IS NULL")          // 软删除过滤
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String username;
    private String email;
    private Integer status;
    @Column(name = "created_at", insertable = false, updatable = false)
    private LocalDateTime createdAt;
    @Column(name = "updated_at", insertable = false)
    private LocalDateTime updatedAt;
    private LocalDateTime deletedAt;
}
```

Repository 骨架：

```java
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByUsername(String username);   // 命名约定自动生成
}
```

## 5. 与 Service 层的挂载关系

- 分层固定：`Controller → Service(接口/实现) → Mapper(MyBatis) / Repository(JPA) → DB`。
- Service 是唯一编排业务与事务的位置：写库方法加事务注解；Controller 不直接调用 Mapper / Repository。
- 返回值由 Service 组装为统一返回体 `{"code":0,"message":"success","data":{}}`，分页 data 为 `{"list":[],"total":0,"page":1,"page_size":10}`（接口规范权威见 `references/横切约定/接口规范/接口规范.md`，本文件不重复）。
- 挂载点示例（Service 注入 Mapper / Repository）：

```java
@Service
@RequiredArgsConstructor
public class UserService {
    private final UserMapper userMapper;   // 路径 B 换成 UserRepository
    // 业务方法：校验 → 调用 mapper/repository → 组装统一返回体
}
```

## 6. 验证门

1. 启动应用，数据源按 `.env` 环境变量成功建连（Hikari 池建立，无连接报错）。
2. JPA 路径确认 `ddl-auto=validate` 通过（说明实体与 `baseline/` DDL 一致）；MyBatis 路径确认 Mapper 扫描到且注入成功。
3. 执行一次读写：插入一条 → 查询返回，`created_at` / `updated_at` 由数据库列默认值正确写入。
4. 软删除验证：逻辑删除后查询按 `deleted_at IS NULL` 过滤。
5. 失败即判定回流，检查数据源方言、实体字段映射与 MySQL 主干 DDL 是否一致。
