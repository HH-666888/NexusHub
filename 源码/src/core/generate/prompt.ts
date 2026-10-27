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
import { moduleSignatureCandidates, type BuildBatch } from "../domain/module-build";

/**
 * 产物检查的可选项。
 *
 * 目前只有一项：这次装配有没有拿到并行构建的批次。
 * 做成一个对象而不是第二个位置参数，是为了以后加检查项时
 * 不必再动所有调用点的签名（现在已经有十几处在调 inspectArtifact）。
 */
export interface InspectOptions {
  /**
   * 并行构建的批次。
   *
   * **不传 / 传 null = 这次没做并行构建** ——
   * 那条「模块代码确实进入了产物」的检查**不出现**
   * （理由见下面 inspectArtifact 里那段：不出现好过占着名额不干活）。
   */
  batch?: BuildBatch | null;
}

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
    ---------- 第八项：模块代码确实进入了产物（★ 本期新增，是探针）----------

    ── 它要防的是什么 ──
      「表演式并行」：并行跑 N 次、结果扔掉，最后照旧单次生成。
      那种实现下，上面七项**照样能全绿** —— 产物是一份完整页面，
      看起来一切正常。而"并行构建"这四个字是假的。

      所以需要一条只有"模块产出真的被喂进装配"才可能通过的断言：
      从每个 ModuleBuild 里取一段**特征片段**（data-module 标记 /
      具名函数 / 类选择器），逐条在最终 HTML 里找。
      找不到 → 不通过，并且**指名道姓**说是哪个模块的哪一段没找到。

    ── 为什么它不会恒真 ──
      ① 片段是具体的字符串，不是"有没有 <html>"这种任何页面都满足的东西；
      ② 模块数为 0（一个都没成功）时**一律不通过** —— 没有产出就没有证据；
      ③ 有一条单测专门喂一份"不含任何片段"的产物，断言它必须红
         （tests/unit/generate-service.test.ts 里那条探针用例）。
      恒真的断言等于没检查，而这一条的意义恰恰是"能被证伪"。

    ── 没传 batch 时它不出现（而不是"标成未做但计入通过数"）──
      不出现：`inspectArtifact(html)` 仍然只返回原来那七项，
      旧路径的 `passed/total` 一个字都不变。
      明确标成"未做并行构建"但计进通过数的话，`8/8 通过` 会被读成
      "连并行构建都验过了" —— 那是在用一个没跑过的检查充数。
      宁可这一项不存在，也不要一个占了名额却没干活的检查。
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
      /*
        一个成功模块都没有 → 不通过。
        这里刻意不写"无模块，跳过"：跳过等于默认通过，
        而不通过才是实话 —— 这次并行构建没有产出任何可核对的东西。
      */
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
 * 生成任务的默认输出预算（装配那一次用的就是它）。给足余量，避免被思考 token 吃光。
 *
 * ── 为什么从 16384 抬到 32768（真实运行实测，不是拍的）──
 *   装配是"把各模块片段拼成一整页"的那一次调用，开着思考（high）。
 *   同一条提示词、同一个 16384 的两次真实运行：
 *     bf665a20  思考  8162 · 输出 13224  ✅ 正文约 5000，没截断
 *     6c0f8312  思考 14273 · 输出 16384  ❌ 正文只剩 2111，产物被截断
 *   也就是说：这一道的思考长度在 8k~14k 之间浮动，
 *   16384 是"看运气"的预算 —— 思考一长，正文就没地方了，
 *   而截断的 HTML 是不完整的，产物直接判不合格（那次 8 项检查只过 3 项）。
 *
 *   32768 是按最坏观测值留的：思考 14k + 一整页正文 8k + 余量。
 *   （上限不用担心：实测这个接入点接受 max_tokens 到 131072。）
 *
 *   ⚠️ 别再"按感觉留余量"。这一道和模块那一道都已经栽过同一个坑：
 *   预算是要装下「思考 + 正文」两段的，而思考那一段可以比正文还长。
 *   改这个数之前，先去真实运行的 cost_records 里看一眼
 *   reasoning_tokens 的实际分布。
 */
export const GENERATE_MAX_OUTPUT_TOKENS = 32768;

/**
 * 生成阶段默认的思考档位。
 *
 * ── 为什么是 high，而不是原来的 none ──
 *   这里曾经是 "none"，依据是一次实测：同一条提示词开启思考（high）
 *   跑了 53.2 秒、输出 16384 被截断、其中 11914 是思考 token，
 *   最终产物 13.8 KB 且只有外壳没有内容；关掉思考 18.5 秒、输出 6961、
 *   产物 23.9 KB 且 8 项检查全过。那次结论被推广成了"写码不用思考"。
 *
 *   但它有两个问题，都是这次改回来的理由：
 *     一、**并行构建是创造性写码，不是机械任务。** 一个模块要决定
 *         "这块功能怎么切、接口怎么留、和别的模块怎么接"，
 *         这些判断恰恰是思考该花的地方；把它当样板代码处理，
 *         省下的是小钱，赔的是成品质量。
 *     二、**"看得见的思考"是这个产品的卖点。** 实测真实运行里
 *         build 的 5 次调用 reasoning_tokens 全是 0 ——
 *         界面上那一步的「思考」tab 永远是「这一步没有返回思考内容」，
 *         而用户以为系统根本没想。一个不思考的并行构建，
 *         配上"思考"这个页签，本身就是一处不自洽。
 *
 * ⚠️ 开了思考就要给够预算：**思考 token 计入 max_tokens**
 *   （适配器文件头第 ① 条）。预算是要装下「思考 + 正文」两段的，
 *   不是只装正文 —— 两道都栽过这个坑，也都在真实运行里量到了数：
 *     · 模块那一道（MODULE_MAX_OUTPUT_TOKENS）：6000 的时候，
 *       4 个模块里有 2 个的思考把预算吃光、正文一个字都没吐出来；
 *     · 装配那一道（GENERATE_MAX_OUTPUT_TOKENS）：16384 的时候，
 *       思考量到过 14273，正文只剩 2111，产物被截断判不合格。
 *   两个数现在都是按实测的最坏观测值定的，不再是估算。
 */
export const GENERATE_DEFAULT_EFFORT = "high" as const;