/**
 * 站点配置存取端口
 * ============================================================
 * 刻意做成「通用键值」而不是「getAppearance / setAppearance」这类具名方法：
 *   配置项会长出来，每加一项就改一次接口，所有实现都要跟着动。
 *   通用读写 + 内核负责收窄类型，是更耐用的分工。
 */

export interface SettingsStore {
  /** 读不到时返回 null，而不是抛异常 —— 首次运行本来就没有配置 */
  get(key: string): Promise<string | null>;
  set(key: string, value: string, updatedBy: number | null): Promise<void>;
  remove(key: string): Promise<void>;
  /** 全部配置，用于排查与展示「最后更新时间」 */
  list(): Promise<Array<{ key: string; updatedAt: number; updatedBy: number | null }>>;
}