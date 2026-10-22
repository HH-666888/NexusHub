/**
 * 生成任务的提示词与产物检查
 * ============================================================
 * 这一层是纯逻辑 —— 不碰数据库、不碰网络，因此可以被单元测试完整覆盖。
 *
 * 为什么要从探测脚本里提炼到这里：
 *   探测脚本是一次性的实验代码，网页要用的是长期维护的正式代码。
 *   两者共用同一份提示词与检查规则，才能保证
 *   「脚本里测出来的效果」和「网页上跑出来的效果」是一回事。
 */

import type { CheckResult } from "../domain/check";

/**
 * 系统提示词
 * ------------------------------------------------------------
 * 要求「单个自包含文件」不是偷懒，是刻意的第一步：
 *   · 没有依赖安装、没有构建步骤 → 排除了整类环境故障
 *   · 能直接放进 iframe 预览、能直接下载成单文件
 *   · 先证明「模型能写对」，再上「多文件并行装配」的复杂度
 *
 * 关于「不要解释、只输出 HTML」这条：
 *   实测发现模型很爱在代码块前后加一段说明，那些文字会污染产物提取。
 *   与其事后用正则去猜，不如在提示词里就要求干净输出。
 */
export const SYSTEM_PROMPT = `你是一名资深前端工程师。用户会用一句话描述他要的软件，你直接产出可运行的成品。

硬性要求：
1. 只输出**一个** HTML 文件，CSS 和 JavaScript 全部内联，不得引用任何外部资源（不允许 CDN、不允许外链字体或图片）。
2. 界面文字全部使用简体中文。
3. 必须是**能真正操作**的成品，不是示意图：按钮点了有反应，数据能存下来。
4. 数据持久化用 localStorage，刷新页面后数据要还在。
5. 视觉上要干净现代：深色或浅色主题选一个做到底，留白充足，不要花哨动画。
6. 不要写任何解释文字，只输出 HTML 代码。

输出格式：用 \`\`\`html 代码块包住完整的 HTML。`;

/**
 * 从模型输出里提取 HTML。
 *
 * 三层兜底，因为模型的输出格式并不总是听话：
 *   ① 标准的 ```html 代码块
 *   ② 没有围栏，但从 <!DOCTYPE html> 或 <html> 开始
 *   ③ 什么都没匹配上，原样返回（让后续检查去报错，而不是在这里抛异常）
 */
export function extractHtml(text: string): string {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]?.includes("<html")) return fenced[1].trim();

  const start = text.search(/<!DOCTYPE html|<html[\s>]/i);
  if (start >= 0) {
    const tail = text.slice(start);
    const end = tail.toLowerCase().lastIndexOf("</html>");
    if (end >= 0) return tail.slice(0, end + 7).trim();
    return tail.trim();
  }
  return text.trim();
}

/**
 * 产物静态检查
 * ------------------------------------------------------------
 * 只看「机器能判断的硬事实」，不看「看起来好不好看」。
 *
 * 为什么不判断美观：那需要人（或另一个模型）来评判，成本高且不稳定。
 * 而「是否自包含」「有没有事件绑定」这类是二值判断，可重复、可解释，
 * 也正好对应我们要做的失败归因 —— 哪一项没过，就知道问题出在哪一类。
 */
export function inspectArtifact(html: string): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) =>
    results.push({ name, pass, detail });

  add(
    "完整 HTML 结构",
    /<html[\s>]/i.test(html) && /<\/html>/i.test(html),
    "含 <html> 与 </html>",
  );
  add("内联样式", /<style[\s>]/i.test(html), "含 <style> 块");
  add("内联脚本", /<script[\s>]/i.test(html), "含 <script> 块");

  // 自包含的关键：不能有外部资源引用
  const externals = [
    ...html.matchAll(
      /<(?:script|link|img)[^>]+(?:src|href)=["'](?:https?:)?\/\/[^"']+/gi,
    ),
  ].map((m) => m[0].slice(0, 80));
  add(
    "完全自包含（无外部引用）",
    externals.length === 0,
    externals.length === 0
      ? "没有任何指向外部的 script/link/img"
      : `发现 ${externals.length} 处外部引用：${externals[0]}`,
  );

  const hasListener = /addEventListener|onclick\s*=|onClick/i.test(html);
  add("有事件处理", hasListener, hasListener ? "含事件绑定" : "没找到任何事件绑定");

  const hasStorage = /localStorage/i.test(html);
  add(
    "数据能持久化",
    hasStorage,
    hasStorage ? "用到了 localStorage" : "没用到 localStorage",
  );

  const cjk = (html.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  add("中文界面", cjk >= 10, `含 ${cjk} 个中文字符`);

  return results;
}

/** 生成任务的默认输出预算。给足余量，避免被思考 token 吃光 */
export const GENERATE_MAX_OUTPUT_TOKENS = 16384;

/**
 * 生成阶段默认的思考档位。
 *
 * 这个值是实测出来的，不是拍的：
 *   同一条提示词，开启思考（high）跑了 53.2 秒、输出 16384 tokens 被截断、
 *   其中 11914 是思考 token，最终产物 13.8 KB 且**只有外壳没有内容**；
 *   关闭思考跑了 18.5 秒、输出 6961 tokens、产物 23.9 KB 且**8 项检查全过**。
 *
 * 结论：对「写一个自包含页面」这类任务，思考不但慢和贵，
 * 还会挤占本该用来写代码的输出预算。所以默认关闭。
 */
export const GENERATE_DEFAULT_EFFORT = "none" as const;