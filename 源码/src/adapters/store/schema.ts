/**
 * 表结构定义（Drizzle ORM）
 * ============================================================
 * 这里是「数据类和字段」的唯一真相来源。
 * 类型由 Drizzle 自动推导，不手写第二遍 —— 表结构变了，类型立刻跟着变。
 *
 * 放在 adapters/ 层：它依赖 drizzle-orm，属于「外部工具」，
 * 内核（core/）不应该认识它。
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Session, User } from "@/core/domain/user";

/* ============================================================
   users —— 用户表
   ============================================================ */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 登录标识。统一小写存储，并加唯一约束 */
  username: text("username").notNull().unique(),
  /** 展示用昵称。注册时默认等于用户名，以后可以单独改 */
  displayName: text("display_name").notNull(),
  /**
   * 密码哈希，格式自描述：scrypt$N$r$p$盐$哈希
   * 自描述的好处：以后想提高强度参数，老密码依然能验证通过，
   * 用户下次登录时再静默升级。
   */
  passwordHash: text("password_hash").notNull(),
  /** Unix 毫秒时间戳。SQLite 没有原生日期类型，用整数最省事也最快 */
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // 注意：不再额外为 username 建普通索引。
  // .unique() 已经生成了唯一索引，它同时承担「唯一性约束」和「按用户名查询加速」
  // 两个职责；再加一个普通索引是纯冗余，只会拖慢写入、白占空间。
});

/* ============================================================
   sessions —— 登录态表
   ------------------------------------------------------------
   为什么不用 JWT：JWT 签发后在过期前无法主动失效，
   「退出登录」「改密码后踢掉所有设备」都做不到。
   服务端会话表可以随时删除，语义清晰，答辩也讲得明白。
   ============================================================ */
export const sessions = sqliteTable(
  "sessions",
  {
    /** 会话令牌本身作为主键。密码学随机，不可预测 */
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      // 用户被删除时，其会话级联删除，不留孤儿数据
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

/* ============================================================
   runs —— 每一次「构建」的记录
   ------------------------------------------------------------
   一个用户可以有多次构建。这条记录是整套流程的主线：
   它记录「你要做什么」以及「现在进行到哪一步」。

   为什么主键用随机串而不是自增整数：
   自增整数会暴露「系统一共被用了多少次」，也容易被遍历；
   随机串对外不可枚举，而且在未来分布式场景下天然可合并。
   ============================================================ */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** 用户输入的那一句话 —— 全流程的起点 */
    prompt: text("prompt").notNull(),
    /** 当前阶段，对应 StageId */
    stage: text("stage").notNull(),
    /** running | paused | done | failed | cancelled */
    status: text("status").notNull(),
    /**
     * 工作流版本。
     * 这是「跨阶段失效归因」能成立的判据：
     * 阶段定义或产物契约变更时递增，用来判断旧产物与新代码是否兼容。
     */
    workflowVersion: text("workflow_version").notNull(),

    /* ---------- 成本与用量 ----------
       拆成独立列而不是塞一个 JSON，是为了能在数据库层直接求和与排序 ——
       「我这个月一共花了多少」这类查询会非常频繁。 */
    totalCostCny: real("total_cost_cny").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** 思考 token：计费，同时也是「AI 思考可视化」的数据来源 */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheHitTokens: integer("cache_hit_tokens").notNull().default(0),
    cacheMissTokens: integer("cache_miss_tokens").notNull().default(0),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // 列表查询固定是「某用户的记录，按时间倒序」，这个复合索引正好覆盖
    index("idx_runs_user_created").on(table.userId, table.createdAt),
  ],
);

/* ============================================================
   cost_records —— 每一次模型调用的成本流水
   ------------------------------------------------------------
   为什么不让 runs 表的累计值代替它：
     累计值只能回答「一共花了多少」，回答不了
     「钱花在哪个阶段、哪一次调用、哪个模型、哪个档位」。
     而后者才是成本优化的依据 —— 没有流水就只能拍脑袋。

   为什么单独记 priceTier：
     高峰与空闲时段价格差一倍。不记下来，事后复盘时
     会以为「同样的活儿这次怎么贵了一倍」是模型变笨了。
   ============================================================ */
export const costRecords = sqliteTable(
  "cost_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 归属的运行。探测脚本这类独立调用没有运行，允许为空 */
    runId: text("run_id"),
    /** 归属的阶段与节点，用于「哪个阶段最贵」的统计 */
    stage: text("stage"),
    nodeId: text("node_id"),

    /** decide | execute | mechanical */
    tier: text("tier").notNull(),
    model: text("model").notNull(),
    /** 这次调用是干什么的，人可读 */
    purpose: text("purpose").notNull(),

    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    cacheHitTokens: integer("cache_hit_tokens").notNull(),
    cacheMissTokens: integer("cache_miss_tokens").notNull(),

    costCny: real("cost_cny").notNull(),
    /** peak | offPeak。价格差一倍，必须记下来才能正确复盘 */
    priceTier: text("price_tier").notNull(),
    latencyMs: integer("latency_ms").notNull(),

    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_cost_run").on(table.runId),
    index("idx_cost_created").on(table.createdAt),
  ],
);

/* ============================================================
   artifacts —— 每个阶段产出的文件
   ------------------------------------------------------------
   为什么记 sha256 而不是只记路径：
     它是「内容寻址」的基础。同样的输入重复跑，若产物哈希相同，
     说明这一步是幂等的，可以安全复用而不必重跑。
     这是后面「断点续跑」能成立的前提 —— 靠哈希判断能否复用，
     而不是靠「上次好像跑过了」这种模糊印象。
   ============================================================ */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** 产物类型：html | json | text。用文本而不是枚举，方便以后加新类型 */
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

/* ============================================================
   settings —— 站点级配置（外观、模型接入等）
   ------------------------------------------------------------
   为什么用「键值对」而不是给每项配置开一列：
     配置项会不断长出来（今天加背景，明天加圆角），
     每加一项就改一次表结构，迁移文件会迅速堆积成噪音。
     键值对把「表结构」和「配置项」解耦：加配置只改代码，不动库。

   值统一存 JSON 文本：配置天然是结构化的，
   拆成列反而要在读写两侧做一遍映射，得不偿失。

   为什么 updatedBy 不加外键：
     配置是站点级的，不该因为某个用户被删而跟着消失或被置空。
     它只用于「谁最后改的」这类追溯，不是归属关系。
   ============================================================ */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON 文本。读取时由内核负责收窄成合法结构 */
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** 最后修改者的用户 id。无外键，见上面的说明 */
  updatedBy: integer("updated_by"),
});

/* ============================================================
   类型一致性断言
   ------------------------------------------------------------
   编译期检查：表结构推导出的类型，必须满足领域模型的要求。
   如果有人改表结构却忘了改领域模型（或反之），这里会直接编译失败。
   ============================================================ */
type SchemaUser = typeof users.$inferSelect;
type SchemaSession = typeof sessions.$inferSelect;

const _assertUserShape: User = {} as SchemaUser;
const _assertSessionShape: Session = {} as SchemaSession;
void _assertUserShape;
void _assertSessionShape;