/**
 * 产物工作区（全栈模式的落盘位置）。
 *
 * core 不许直接碰文件系统，所以这里只声明"读写一个文件"这两件事，
 * 实现在 adapters/store/workspace.ts。
 *
 * 读也要：后端方向要把建表脚本读回来塞进提示词，前端方向要读后端代码抽路由。
 */

export interface WrittenFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Workspace {
  /** 写一个相对路径的文件；父目录不存在时由实现负责创建 */
  write(runId: string, path: string, content: string): Promise<WrittenFile>;
  /** 读一个文件；不存在时抛错（由调用方决定当作空还是失败） */
  read(runId: string, path: string): Promise<string>;
}
