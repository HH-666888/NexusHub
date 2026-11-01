/**
 * 表结构定义（Drizzle ORM），数据类与字段的唯一真相来源。
 * 类型由 Drizzle 推导，不手写第二份；放在 adapters 层，core 不应依赖它。
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Session, User } from "@/core/domain/user";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 登录标识，统一小写并加唯一约束 */
  username: text("username").notNull().unique(),
  /** 展示用昵称，注册时默认等于用户名 */
  displayName: text("display_name").notNull(),
  /**
   * 密码哈希，格式自描述：scrypt$N$r$p$盐$哈希，日后提高强度参数时旧密码仍可验证。
   */
  passwordHash: text("password_hash").notNull(),
  /** Unix 毫秒时间戳；SQLite 无原生日期类型，用整数最省 */
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // 不再为 username 建普通索引：unique() 生成的唯一索引已同时承担唯一约束与按名查询。
  // 再加普通索引只会拖慢写入、白占空间。
});

// 服务端会话表而非 JWT：后者过期前无法主动失效，退出登录与改密踢设备都做不到。
// 服务端会话可以随时删除，语义清晰。
export const sessions = sqliteTable(
  "sessions",
  {
    /** 会话令牌作为主键，密码学随机，不可预测 */
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      // 用户删除时级联删除会话，不留孤儿数据
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    // 过期会话需要定期清理，加索引让清理查询走索引而不是全表扫
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

// 主键用随机串而非自增整数：后者暴露系统使用总量且可被遍历，随机串对外不可枚举。
// 未来做分布式时，随机串也天然可合并。
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** 用户输入的那一句话，全流程的起点 */
    prompt: text("prompt").notNull(),
    /** 当前阶段，对应 StageId */
    stage: text("stage").notNull(),
    /** running | paused | done | failed | cancelled */
    status: text("status").notNull(),
    /**
     * 工作流版本：阶段定义或产物契约变更时递增，用于判断旧产物与新代码是否兼容。
     */
    workflowVersion: text("workflow_version").notNull(),

    // 成本与用量拆成独立列而非一个 JSON，便于在库层直接求和与排序。
    // 这类查询很频繁，例如按月汇总花费。
    totalCostCny: real("total_cost_cny").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** 思考 token：计费，也是思考可视化的数据来源 */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheHitTokens: integer("cache_hit_tokens").notNull().default(0),
    cacheMissTokens: integer("cache_miss_tokens").notNull().default(0),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // 列表固定按用户 + 时间倒序，复合索引正好覆盖
    index("idx_runs_user_created").on(table.userId, table.createdAt),
  ],
);

// 单独记流水而非只存累计值：累计值回答不了钱花在哪个阶段、哪次调用、哪个模型与档位。
// 后者才是成本优化的依据。
// priceTier 必须记：高峰与空闲价差一倍，不记会让事后复盘误判为模型变贵。
export const costRecords = sqliteTable(
  "cost_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 归属运行；探测脚本这类独立调用没有运行，允许为空 */
    runId: text("run_id"),
    /** 归属阶段与节点，用于按阶段统计 */
    stage: text("stage"),
    nodeId: text("node_id"),

    /** decide | execute | mechanical */
    tier: text("tier").notNull(),
    model: text("model").notNull(),
    /** 这次调用的用途，人可读 */
    purpose: text("purpose").notNull(),

    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    cacheHitTokens: integer("cache_hit_tokens").notNull(),
    cacheMissTokens: integer("cache_miss_tokens").notNull(),

    costCny: real("cost_cny").notNull(),
    /** peak | offPeak，价格差一倍，必须记下才能正确复盘 */
    priceTier: text("price_tier").notNull(),
    latencyMs: integer("latency_ms").notNull(),

    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_cost_run").on(table.runId),
    index("idx_cost_created").on(table.createdAt),
  ],
);

// 记 sha256 而非只记路径：内容寻址让"产物未被改过"可验证，是断点续跑的前提。
// 判断能否复用依据哈希，而不是"上次好像跑过了"这种印象。
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** html | json | text，用文本而非枚举，方便以后加新类型 */
    kind: text("kind").notNull(),
    /** 相对工作区根目录的路径，例如 "<runId>/index.html" */
    path: text("path").notNull(),
    bytes: integer("bytes").notNull(),
    /** 内容哈希，用于幂等判断与去重 */
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_artifacts_run").on(table.runId, table.createdAt)],
);

// 键值对而非每项配置开一列：配置项持续增加，开列会让迁移堆积，加配置只改代码。
// 值统一存 JSON 文本，读写两侧无需再映射一遍。
// updatedBy 不加外键：站点级配置不该因某个用户被删而跟着消失。
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON 文本，读取时由内核收窄成合法结构 */
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** 最后修改者的用户 id，无外键 */
  updatedBy: integer("updated_by"),
});

// 事件落库而非只走 SSE：刷新后或事后复盘都要能回放，全程可见不限于实时。
// SSE 推给浏览器之后就没了，用户刷新或复盘都拿不回来。
// payload 存 JSON 文本，与 settings 同一取舍：表结构不随事件类型增长。
// seq 单独记：id 跨运行混用，回放需要本次运行内的稳定序号。
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** 本次运行内的序号，从 0 开始且连续 */
    seq: integer("seq").notNull(),
    /** 事件发生时刻（Unix 毫秒），相对偏移由界面计算 */
    at: integer("at").notNull(),
    /** phase | text | reasoning | usage | check | artifact | error */
    kind: text("kind").notNull(),
    /** 事件内容（JSON），具体结构由内核按 kind 收窄 */
    payload: text("payload").notNull(),
  },
  (table) => [
    // 回放固定按运行 + 序号正序，复合索引正好覆盖
    index("idx_events_run_seq").on(table.runId, table.seq),
  ],
);

// 编译期断言：表结构推导出的类型必须满足领域模型，任一侧改动未同步会编译失败。
// 断言不产生运行时开销，_assert 变量用完即弃。
type SchemaUser = typeof users.$inferSelect;
type SchemaSession = typeof sessions.$inferSelect;

const _assertUserShape: User = {} as SchemaUser;
const _assertSessionShape: Session = {} as SchemaSession;
void _assertUserShape;
void _assertSessionShape;
