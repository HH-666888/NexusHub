import { ThemeToggle } from "@/components/theme-toggle";
import { resolveTheme } from "@/server/theme";

/**
 * 主题开关（服务端包装）
 * 存在的意义只有一个：**省掉逐层传递主题这件事**。
 *
 * 没有它的话，每个用到开关的 header 都得接受一个 theme 属性，
 * 而 header 的上层页面又得自己去解析一次 ——
 * 解析逻辑重复三遍，而且很容易漏掉某一层导致图标显示错。
 *
 * 有了它，任何位置直接写 <ThemeToggleServer /> 即可，
 * 主题解析只发生在这一处。
 */
export async function ThemeToggleServer({
  className,
}: {
  className?: string;
}) {
  const { theme } = await resolveTheme();
  return <ThemeToggle current={theme} className={className} />;
}