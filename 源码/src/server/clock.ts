import "server-only";

/**
 * 服务端的当前时间：服务端组件每次请求只渲染一次，时间属于请求上下文而非渲染副作用。
 * 单独包一层让这个区别在代码上可见，而不是用 eslint-disable 压掉告警。
 */
export function serverNow(): number {
  return Date.now();
}