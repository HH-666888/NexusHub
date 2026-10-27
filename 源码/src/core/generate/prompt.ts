/**
 * 生成任务的提示词与产物静态检查，纯逻辑，不碰存储与网络。
 * 与探测脚本共用同一份规则，保证脚本测出的效果与网页一致。
 */

import type { CheckResult } from "../domain/check";
import { moduleSignatureCandidates, type BuildBatch } from "../domain/module-build";

/** 检查项的可选项；做成对象是为了加字段时不动调用点签名 */
export interface InspectOptions {
  /** 并行构建批次；不传或 null 表示没做并行构建，对应检查项不出现 */
  batch?: BuildBatch | null;
}

/**
 * 系统提示词。单文件自包含是刻意收紧的第一步：排除环境故障，能直接预览与下载。
 * 「只输出 HTML」是因为模型爱在代码块前后加说明，会污染产物提取。
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

/** 从输出里提取 HTML：```html 代码块 → <html 起的正文 → 原样返回 */
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

/** 只判机器可判的硬事实，不判美观：二值判断可重复、可解释，也便于失败归因 */
export function inspectArtifact(html: string, options: InspectOptions = {}): CheckResult[] {
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

  /*
    第八项：模块代码确实进入了产物，防的是「表演式并行」——
    并行调用了但产物照旧单次生成，前七项照样能全绿。
    做法是从每个 ModuleBuild 取一段特征片段，逐条在最终 HTML 里找；
    模块数为 0 一律不通过（没产出就没证据），有单测断言「不含片段」必须红。

    没传 batch 时这一项不出现，而不是标成未做并计入通过数：
    旧路径的 passed/total 一个字都不变。
  */
  const batch = options.batch ?? null;
  if (batch) {
    const probes = batch.modules.map((m) => ({
      moduleId: m.moduleId,
      candidates: moduleSignatureCandidates(m),
    }));
    const missing = probes.filter((p) => !p.candidates.some((c) => html.includes(c)));
    const passed = probes.length > 0 && missing.length === 0;

    let detail: string;
    if (probes.length === 0) {
      // 没有成功模块即不通过：跳过等于默认通过，这次并行构建没有可核对的东西
      detail =
        `并行构建没有任何成功模块的产出（失败 ${batch.failed.length} 个），` +
        "无从证明模块代码进入了产物";
    } else if (passed) {
      detail =
        `${probes.length} 个模块的特征片段都能在产物里找到（例如 ${probes[0].candidates[0]}）` +
        (batch.failed.length > 0
          ? `；另有 ${batch.failed.length} 个模块构建失败，它们本来就没有产出可核对`
          : "");
    } else {
      const parts = missing.slice(0, 3).map((p) =>
        p.candidates.length > 0
          ? `模块 ${p.moduleId} 的特征片段「${p.candidates[0]}」在产物里找不到`
          : `模块 ${p.moduleId} 提不出任何可核对的代码特征（html/css/js 都是空的？）`,
      );
      if (missing.length > 3) parts.push(`另有 ${missing.length - 3} 个模块同样没找到`);
      detail = parts.join("；");
    }

    add("模块代码确实进入了产物", passed, detail);
  }

  return results;
}

/**
 * 生成任务的默认输出预算（装配那次用它）。
 * 32768 按实测最坏值留：思考 14k + 整页正文 8k + 余量；接入点上限 131072。
 * 预算要装下思考与正文两段，改之前先看真实运行里 reasoning_tokens 的分布。
 */
export const GENERATE_MAX_OUTPUT_TOKENS = 32768;

/**
 * 生成阶段的思考档位。high 而非 none：并行构建是创造性写码，判断该花思考。
 * 思考 token 计入 max_tokens，预算必须同时装下思考与正文。
 */
export const GENERATE_DEFAULT_EFFORT = "high" as const;