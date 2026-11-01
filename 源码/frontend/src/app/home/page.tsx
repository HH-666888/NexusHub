import { redirect } from "next/navigation";

/**
 * /home 到根路径的重定向：首页已迁到 /，保留它以免旧链接与脚本断言拿到 404。
 * 用 redirect 而非 rewrite，地址栏需要跟着变。
 */
export default function HomeRedirect() {
  redirect("/");
}
