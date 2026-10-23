/**
 * 研发团队运转图 —— 校验
 * ============================================================
 * 模型是给**模型生成的 JSON** 用的，所以校验不是可选项：
 * 大模型一定会漏字段、一定会给重复的 id、一定会写出
 * 「一个不看任何数的角色」这种自己都说不通的东西。
 *
 * ── 为什么返回清单而不是布尔值 ──
 *   返回 true/false 的话，调用方只知道"不行"，不知道哪里不行。
 *   于是只能重试一次，而重试往往错在同一个地方。
 *   返回逐条问题 + **怎么修**，才有机会在下一轮改对。
 *
 * ── error 与 warning 的分界 ──
 *   error    放过去的话，产出的图是**错的**（自相矛盾、缺块、
 *            或者权限失守）。必须修。
 *   warning  放过去图还能看，但**质量有问题**（名字太长、
 *            角色描述太笼统）。记下来，不拦。
 *
 *   这个分界很重要：如果把 warning 也当 error，生成会因为
 *   "某一步名字有 8 个字"这种小事整个失败 —— 那比问题本身糟得多。
 */

import { authorityOf } from "./authority";
import { HUB_ID, isClosed, sortSteps, type Loop } from "./loop";
import { flattenOrg, type OrgNode, type OrgTree } from "./org";
import type { Blueprint, Walkthrough } from "./model";

export type Severity = "error" | "warning";
export type IssueScope = "org" | "loop" | "walkthrough";

export interface Issue {
  severity: Severity;
  scope: IssueScope;
  /** 出问题的对象路径，例如 `org.frontend` / `loop.s3` */
  path: string;
  message: string;
  /** 怎么修。写清楚具体动作，不只是"请修正" */
  fix: string;
}

export interface ValidationReport {
  /** 没有 error 才算通过 */
  ok: boolean;
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  /** 一句话汇总，给界面和日志用 */
  summary: string;
}

/* ============================================================
   阈值
   ============================================================ */

/** 步骤少于此数就谈不上"一圈" */
export const MIN_STEPS = 3;
/** 树深超过这个数，一屏就放不下了 —— 参考图是 4 层 */
export const MAX_DEPTH = 5;
/** 角色名超过这个长度，卡片上会折行 */
export const MAX_ROLE_LEN = 12;
/** 步骤名超过这个长度，参考图上那排短标签就排不下 */
export const MAX_STEP_NAME_LEN = 6;

/* ============================================================
   主入口
   ============================================================ */

export function validateBlueprint(bp: Blueprint): ValidationReport {
  const issues: Issue[] = [
    ...validateOrg(bp.org),
    ...validateLoop(bp.loop),
    ...(bp.walkthrough ? validateWalkthrough(bp.walkthrough, bp.loop) : []),
  ];

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings,
    summary: buildSummary(errors.length, warnings.length),
  };
}

function buildSummary(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return "没有问题";
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} 处必须修`);
  if (warnings > 0) parts.push(`${warnings} 处建议改`);
  return parts.join("，");
}

/* ============================================================
   组织结构
   ============================================================ */

function validateOrg(tree: OrgTree): Issue[] {
  const out: Issue[] = [];
  const all = flattenOrg(tree.root);

  /* ---- 唯一的根 ---- */
  if (!tree.root || !tree.root.id) {
    out.push({
      severity: "error",
      scope: "org",
      path: "org.root",
      message: "没有根节点",
      fix: "补一个根节点。参考图上根是那个拍板的人",
    });
    return out;
  }

  /* ---- id 唯一 ---- */
  const seen = new Set<string>();
  for (const n of all) {
    if (seen.has(n.id)) {
      out.push({
        severity: "error",
        scope: "org",
        path: `org.${n.id}`,
        message: `id「${n.id}」重复了`,
        fix: "给重复的节点换一个 id。连线和高亮都靠 id，重了会连错",
      });
    }
    seen.add(n.id);
  }

  /* ---- 逐节点 ---- */
  for (const n of all) {
    const p = `org.${n.id}`;

    if (!n.role.trim()) {
      out.push({
        severity: "error",
        scope: "org",
        path: p,
        message: "这个节点没有名字",
        fix: "补一个角色名，例如「前端 Agent」",
      });
    } else if (n.role.length > MAX_ROLE_LEN) {
      out.push({
        severity: "warning",
        scope: "org",
        path: p,
        message: `角色名「${n.role}」有 ${n.role.length} 个字，卡片上会折行`,
        fix: `压到 ${MAX_ROLE_LEN} 个字以内`,
      });
    }

    const isLeaf = n.children.length === 0;

    /*
      【最要紧的一条】叶子必须看得到数。
      一个不看任何数的具体资产，等于一个凭感觉拍脑袋的人 ——
      它在图上占了位置，却说不清自己凭什么做判断。
    */
    if (isLeaf && n.watches.length === 0) {
      out.push({
        severity: "error",
        scope: "org",
        path: p,
        message: `「${n.role}」是最下面一层，但没写它看什么数`,
        fix: "补 1-3 个指标。参考图上每个资产底下都有一行小字，例如「Star · Issue」",
      });
    }

    // 有下级的节点应当说清自己干什么 —— 否则它只是个转发器
    if (!isLeaf && n.actions.length === 0 && n.actor !== "human") {
      out.push({
        severity: "warning",
        scope: "org",
        path: p,
        message: `「${n.role}」下面有人，但它自己没写干什么`,
        fix: "补一个动作，例如「派活」。参考图上总管写的是「收汇报 · 派活 · 验收」",
      });
    }
  }

  /* ---- 深度 ---- */
  const depth = maxDepth(tree.root);
  if (depth > MAX_DEPTH) {
    out.push({
      severity: "warning",
      scope: "org",
      path: "org.root",
      message: `树有 ${depth} 层，一屏放不下`,
      fix: `压到 ${MAX_DEPTH} 层以内，把中间层合并掉`,
    });
  }

  /* ---- 连线必须连着真实节点 ---- */
  for (const l of tree.links) {
    if (!seen.has(l.from)) {
      out.push({
        severity: "error",
        scope: "org",
        path: `org.link.${l.from}→${l.to}`,
        message: `连线从一个不存在的节点「${l.from}」出发`,
        fix: "改成真实的节点 id，或者删掉这条声明（默认标签会自动补上）",
      });
    }
    if (!seen.has(l.to)) {
      out.push({
        severity: "error",
        scope: "org",
        path: `org.link.${l.from}→${l.to}`,
        message: `连线连到一个不存在的节点「${l.to}」`,
        fix: "改成真实的节点 id，或者删掉这条声明",
      });
    }
    if (l.from === l.to) {
      out.push({
        severity: "error",
        scope: "org",
        path: `org.link.${l.from}`,
        message: "一条线连到了它自己",
        fix: "删掉这条线",
      });
    }
  }

  /* ---- 有没有人 ---- */
  if (!all.some((n) => n.actor === "human")) {
    out.push({
      severity: "warning",
      scope: "org",
      path: "org.root",
      message: "这棵树里没有人",
      fix: "参考图最上面一层是人。没有人的话，没有谁能为对外动作负责",
    });
  }

  return out;
}

/** 树的最大层数。根自己算一层 */
function maxDepth(node: OrgNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(maxDepth));
}

/* ============================================================
   闭环
   ============================================================ */

function validateLoop(loop: Loop): Issue[] {
  const out: Issue[] = [];

  /* ---- 步数 ---- */
  if (loop.steps.length < MIN_STEPS) {
    out.push({
      severity: "error",
      scope: "loop",
      path: "loop.steps",
      message: `只有 ${loop.steps.length} 步，谈不上"一圈"`,
      fix: `至少 ${MIN_STEPS} 步。参考图是 7 步：收→看→建议→人拍板→动手→验收→回流`,
    });
  }

  /* ---- 序号 ---- */
  const orders = new Set<number>();
  for (const s of loop.steps) {
    if (!Number.isInteger(s.order) || s.order < 1) {
      out.push({
        severity: "error",
        scope: "loop",
        path: `loop.${s.id}`,
        message: `「${s.name}」的序号是 ${s.order}，必须是 1 起的整数`,
        fix: "改成 1、2、3……",
      });
    }
    if (orders.has(s.order)) {
      out.push({
        severity: "error",
        scope: "loop",
        path: `loop.${s.id}`,
        message: `序号 ${s.order} 用了两次`,
        fix: "每个步骤一个序号，不能重",
      });
    }
    orders.add(s.order);
  }

  /* ---- id ---- */
  const ids = new Set<string>();
  for (const s of loop.steps) {
    if (s.id === HUB_ID) {
      out.push({
        severity: "error",
        scope: "loop",
        path: `loop.${s.id}`,
        message: `步骤的 id 不能叫「${HUB_ID}」`,
        fix: "换一个 id。hub 是中心角色的保留 id，撞了连线会连到中心去",
      });
    }
    if (ids.has(s.id)) {
      out.push({
        severity: "error",
        scope: "loop",
        path: `loop.${s.id}`,
        message: `id「${s.id}」重复了`,
        fix: "换一个 id",
      });
    }
    ids.add(s.id);
  }

  /* ---- 逐步骤 ---- */
  for (const s of loop.steps) {
    const p = `loop.${s.id}`;

    /*
      【最要紧的一条】原理必填。
      缺了它，这一步就只是"一个名字 + 一个箭头"，
      而看的人只会问"凭什么这么设计"。
      参考图上每一步底下那句黄标签，就是这张图的价值所在。
    */
    if (!s.rationale.trim()) {
      out.push({
        severity: "error",
        scope: "loop",
        path: p,
        message: `「${s.name}」没写原理`,
        fix: "补一句「为什么要有这一步」。参考图上写的是「只看不碰店铺：看错了，最多写错一句话」",
      });
    }

    if (!s.duty.trim()) {
      out.push({
        severity: "error",
        scope: "loop",
        path: p,
        message: `「${s.name}」没写做什么`,
        fix: "补一句这一步具体干什么",
      });
    }

    if (s.name.length > MAX_STEP_NAME_LEN) {
      out.push({
        severity: "warning",
        scope: "loop",
        path: p,
        message: `步骤名「${s.name}」有 ${s.name.length} 个字`,
        fix: `压到 ${MAX_STEP_NAME_LEN} 个字以内。参考图上都是 3 个字：接数据 / 看数 / 给建议`,
      });
    }

    // AI 步骤没写模式 —— 不拦，但要说一声。
    // 没写模式会被 resolveScope 按"可能对外"处理，也就是会多问一次人
    if (s.actor === "ai" && !s.mode) {
      out.push({
        severity: "warning",
        scope: "loop",
        path: p,
        message: `「${s.name}」是 AI 在做，但没写是只读还是干活`,
        fix: "补 mode。「只读」和「干活」的风险差一个数量级，界面上也要靠它画徽章",
      });
    }
  }

  /* ---- 连线 ---- */
  const known = new Set([...ids, HUB_ID]);
  for (const t of loop.transitions) {
    for (const end of [t.from, t.to]) {
      if (!known.has(end)) {
        out.push({
          severity: "error",
          scope: "loop",
          path: `loop.transition.${t.from}→${t.to}`,
          message: `连线连到了一个不存在的位置「${end}」`,
          fix: `只能是某个步骤的 id，或者中心角色的「${HUB_ID}」`,
        });
      }
    }
  }

  /* ---- 闭环 ---- */
  if (!isClosed(loop)) {
    out.push({
      severity: "error",
      scope: "loop",
      path: "loop.closure",
      message: "这个圈没有闭上",
      fix: "补一条从最后一步回到第一步的连线，并写一句 closure 说明。参考图上写的是「一周后的数据，回到起点」",
    });
  }

  /* ---- 权限 ---- */
  const auth = authorityOf(loop);
  if (auth.unguarded.length > 0) {
    out.push({
      severity: "error",
      scope: "loop",
      path: "loop.steps",
      message: `有 ${auth.unguarded.length} 步会对外产生后果（${auth.unguarded
        .map((u) => u.name)
        .join("、")}），但整个圈里没有一步是人做的`,
      fix: "补一步人拍板。参考图的 04 就是为这件事存在的 —— 少了它，这套流程可以自己对外做决定",
    });
  }

  /* ---- 顺序 ---- */
  const sorted = sortSteps(loop.steps);
  const humanAt = sorted.findIndex((s) => s.actor === "human");
  const firstWriteAt = sorted.findIndex((s) => s.mode === "write");
  if (humanAt >= 0 && firstWriteAt >= 0 && humanAt > firstWriteAt) {
    out.push({
      severity: "warning",
      scope: "loop",
      path: `loop.${sorted[firstWriteAt].id}`,
      message: `「${sorted[firstWriteAt].name}」在动手，而人拍板排在它后面`,
      fix: "把拍板挪到动手之前。参考图的顺序是「先让它看，再让它干」，拍板夹在中间",
    });
  }

  return out;
}

/* ============================================================
   走通的例子
   ============================================================ */

function validateWalkthrough(wt: Walkthrough, loop: Loop): Issue[] {
  const out: Issue[] = [];

  if (!wt.title.trim()) {
    out.push({
      severity: "warning",
      scope: "walkthrough",
      path: "walkthrough.title",
      message: "例子没有标题",
      fix: "补一个，例如「上新品，完整走一圈」",
    });
  }

  const beatIds = new Set(wt.beats.map((b) => b.stepId));

  /* ---- 每一步都要有内容 ---- */
  for (const s of loop.steps) {
    if (!beatIds.has(s.id)) {
      out.push({
        severity: "error",
        scope: "walkthrough",
        path: `walkthrough.${s.id}`,
        message: `例子漏了「${s.name}」这一步`,
        fix: "每一步都要填上它在这个例子里具体是什么。图上缺一块，读的人会以为这条流程断了",
      });
    }
  }

  /* ---- 不能有多余的 ---- */
  const loopIds = new Set(loop.steps.map((s) => s.id));
  for (const b of wt.beats) {
    if (!loopIds.has(b.stepId)) {
      out.push({
        severity: "error",
        scope: "walkthrough",
        path: `walkthrough.${b.stepId}`,
        message: `例子里有一块对不上任何步骤（${b.stepId}）`,
        fix: "删掉它，或者改成真实步骤的 id",
      });
    }
    if (!b.content.trim()) {
      out.push({
        severity: "error",
        scope: "walkthrough",
        path: `walkthrough.${b.stepId}`,
        message: "有一块是空的",
        fix: "补上这一步具体在做什么",
      });
    }
  }

  /* ---- 里程碑有序 ---- */
  const withMilestone = wt.beats.filter((b) => b.milestone);
  if (withMilestone.length > 0 && withMilestone.length < wt.beats.length) {
    out.push({
      severity: "warning",
      scope: "walkthrough",
      path: "walkthrough.beats",
      message: `${wt.beats.length} 步里只有 ${withMilestone.length} 步写了里程碑`,
      fix: "要么都写，要么都不写。只写一半的话，底部那条流程链会断断续续",
    });
  }

  return out;
}