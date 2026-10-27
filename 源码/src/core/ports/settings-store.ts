/**
 * 站点配置存取端口。刻意做成通用键值而不是 getAppearance 这类具名方法：
 * 配置项会长出来，每加一项就要改一次接口，所有实现都得跟着动。
 */

export interface SettingsStore {
  /** 读不到返回 null，不抛：首次运行本来就没有配置 */
  get(key: string): Promise<string | null>;
  set(key: string, value: string, updatedBy: number | null): Promise<void>;
  remove(key: string): Promise<void>;
  /** 全部配置，排查与展示最后更新时间用 */
  list(): Promise<Array<{ key: string; updatedAt: number; updatedBy: number | null }>>;
}
