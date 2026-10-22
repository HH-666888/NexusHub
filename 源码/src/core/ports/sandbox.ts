/**
 * 沙箱端口 —— 内核与「代码执行环境」之间的唯一契约
 * ============================================================
 * 两种实现：
 *   local-process  本地开发用，直接在临时目录跑进程，不需要 Docker
 *   docker         部署用，真正的隔离容器（硬化参数见 adapters/sandbox/docker.ts）
 *
 * 安全声明：local-process 仅用于本地开发与自有测试任务，
 *          绝不可用于执行不可信代码。生产环境必须使用 docker 实现。
 */

export interface SandboxSpec {
  /** 沙箱工作目录（宿主机上的绝对路径） */
  workDir: string;
  /** 应用监听端口（沙箱内） */
  appPort: number;
  memoryMb: number;
  cpus: number;
  timeoutSeconds: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 超时被杀时为 true */
  timedOut: boolean;
}

export interface RunningApp {
  /** 宿主机可访问的地址。预览端口不对外裸露，统一由服务端代理转发 */
  url: string;
  /** 应用启动日志（用于失败归因） */
  logs: string;
  stop(): Promise<void>;
}

export interface SandboxPort {
  readonly kind: "local-process" | "docker";
  /** 执行一次性命令：安装依赖、编译、跑测试 */
  run(spec: SandboxSpec, command: string): Promise<CommandResult>;
  /** 启动并保持运行，返回可访问地址 */
  start(spec: SandboxSpec, startCommand: string): Promise<RunningApp>;
  /** 释放该工作目录关联的全部资源 */
  dispose(workDir: string): Promise<void>;
}