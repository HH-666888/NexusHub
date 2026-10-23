import { describe, expect, it } from "vitest";
import {
  countOrgNodes,
  depthOf,
  findOrgNode,
  flattenOrg,
  leavesOf,
  linkBetween,
  orgStats,
  resolveLinks,
  treeDepth,
  type OrgNode,
  type OrgTree,
} from "@/core/blueprint/org";

/**
 * 一棵镜像参考图形状的树：人 → 总管 → 6 个领域 → 各自的资产。
 *
 * ⚠️ 这是**测试夹具**，不是产品里的演示数据。
 *    产品里不摆写死的例子（那是「先可以不写死」这条决定），
 *    但测试必须有一棵确定的树 —— 否则校验、遍历、统计都没法验。
 */
function leaf(id: string, role: string, watches: string[]): OrgNode {
  return {
    id,
    role,
    actions: [],
    watches: watches.map((label) => ({ label })),
    actor: "program",
    children: [],
  };
}

const TREE: OrgTree = {
  root: {
    id: "owner",
    role: "我",
    actions: ["定方向"],
    note: "只说做什么，不管怎么做",
    watches: [],
    actor: "human",
    children: [
      {
        id: "orchestrator",
        role: "编排 Agent",
        actions: ["收汇报", "派活", "验收"],
        note: "盯着每一块转没转",
        watches: [],
        actor: "ai",
        children: [
          {
            id: "frontend",
            role: "前端 Agent",
            actions: ["做页面"],
            watches: [{ label: "构建" }, { label: "页面" }],
            actor: "ai",
            children: [leaf("page-a", "页面 A", ["构建", "报错"]), leaf("page-b", "页面 B", ["构建"])],
          },
          {
            id: "backend",
            role: "后端 Agent",
            actions: ["写接口"],
            watches: [{ label: "接口" }, { label: "数据" }],
            actor: "ai",
            children: [leaf("api", "接口清单", ["用例通过"]), leaf("db", "数据库", ["迁移"])],
          },
          {
            id: "qa",
            role: "测试 Agent",
            actions: ["跑用例"],
            watches: [{ label: "覆盖" }, { label: "失败" }],
            actor: "ai",
            children: [leaf("unit", "单元测试", ["通过率"]), leaf("e2e", "端到端", ["通过率"])],
          },
          {
            id: "docs",
            role: "文档 Agent",
            actions: ["写说明"],
            watches: [{ label: "资料" }, { label: "状态" }],
            actor: "ai",
            children: [leaf("readme", "README", ["更新"]), leaf("changelog", "变更记录", ["每次发布"])],
          },
          {
            id: "ops",
            role: "运维 Agent",
            actions: ["看部署"],
            watches: [{ label: "构建" }, { label: "日志" }],
            actor: "program",
            children: [leaf("ci", "构建流水线", ["每天"]), leaf("logs", "线上日志", ["按点"])],
          },
          {
            id: "audit",
            role: "巡检 Agent",
            actions: ["查隐患"],
            watches: [{ label: "依赖" }, { label: "安全" }],
            actor: "ai",
            children: [leaf("deps", "依赖升级", ["新发现"]), leaf("cve", "安全问题", ["今天", "近期"])],
          },
        ],
      },
    ],
  },
  // 只声明最上面那一层：它和人之间说的话和下面几层不一样
  links: [
    {
      from: "owner",
      to: "orchestrator",
      down: { label: "定方向", hint: "拍板" },
      up: { label: "汇报", hint: "每天按点" },
    },
  ],
};

describe("运转图 · 遍历", () => {
  it("摊平是前序：父在子前面", () => {
    const all = flattenOrg(TREE.root);
    expect(all[0].id).toBe("owner");
    expect(all[1].id).toBe("orchestrator");
    // 前端那一支必须整体排在后端之前
    const ids = all.map((n) => n.id);
    expect(ids.indexOf("page-b")).toBeLessThan(ids.indexOf("backend"));
  });

  it("按 id 找得到，找不到给 null 而不是抛", () => {
    expect(findOrgNode(TREE, "qa")?.role).toBe("测试 Agent");
    // 不抛：调用方多半只是在问"有没有这个节点"
    expect(findOrgNode(TREE, "不存在")).toBeNull();
  });

  it("层数：根是 0，资产是 3", () => {
    expect(depthOf(TREE, "owner")).toBe(0);
    expect(depthOf(TREE, "orchestrator")).toBe(1);
    expect(depthOf(TREE, "frontend")).toBe(2);
    expect(depthOf(TREE, "page-a")).toBe(3);
  });

  it("找不到的节点层数是 -1 —— 和「根」区分开", () => {
    // 返回 0 的话，「找不到」和「就是根」会撞在一起
    expect(depthOf(TREE, "不存在")).toBe(-1);
  });

  it("树深：这是一棵四层的树", () => {
    expect(treeDepth(TREE.root)).toBe(4);
  });

  it("只有根的树深度是 1", () => {
    const solo: OrgNode = { ...TREE.root, children: [] };
    expect(treeDepth(solo)).toBe(1);
  });

  it("节点总数", () => {
    // 1 人 + 1 总管 + 6 领域 + 12 个资产（每个领域两个）
    expect(countOrgNodes(TREE)).toBe(20);
  });

  it("叶子就是那些具体资产", () => {
    const leaves = leavesOf(TREE);
    expect(leaves).toHaveLength(12);
    expect(leaves.map((l) => l.id)).toContain("page-a");
    // 领域 Agent 不是叶子，它们还有下级
    expect(leaves.map((l) => l.id)).not.toContain("frontend");
  });
});

describe("运转图 · 边的话", () => {
  it("【关键】声明过的边用声明的话", () => {
    /*
      参考图上，人和总管之间写的是「定方向 / 汇报 每天按点」；
      总管和领域之间写的是「派活 / 日报」。
      **同一棵树里不同层的边说的是不同的话** ——
      所以边必须能单独声明，不能从父子关系硬推。
    */
    const l = linkBetween(TREE, "owner", "orchestrator");
    expect(l.down.label).toBe("定方向");
    expect(l.up.label).toBe("汇报");
    expect(l.up.hint).toBe("每天按点");
  });

  it("没声明的边退回「派活 / 日报」", () => {
    const l = linkBetween(TREE, "orchestrator", "frontend");
    expect(l.down.label).toBe("派活");
    expect(l.up.label).toBe("日报");
  });

  it("声明一条就只影响那一条，别的照旧", () => {
    // 这条能抓住「用一个全局标签把整棵树的边都盖掉」这类错
    expect(linkBetween(TREE, "orchestrator", "qa").down.label).toBe("派活");
    expect(linkBetween(TREE, "frontend", "page-a").down.label).toBe("派活");
  });

  it("补齐所有边，并标出哪些是推出来的", () => {
    const links = resolveLinks(TREE);
    // 19 条边 = 20 个节点 - 1 个根
    expect(links).toHaveLength(19);

    const declared = links.filter((l) => !l.implied);
    const implied = links.filter((l) => l.implied);
    expect(declared).toHaveLength(1);
    expect(declared[0].from).toBe("owner");
    expect(implied).toHaveLength(18);
  });

  it("每条边都连着一个真实的父子对", () => {
    const parentOf = new Map<string, string>();
    const walk = (n: OrgNode) => {
      for (const c of n.children) {
        parentOf.set(c.id, n.id);
        walk(c);
      }
    };
    walk(TREE.root);

    for (const l of resolveLinks(TREE)) {
      expect(parentOf.get(l.to), `${l.to} 的父节点不是 ${l.from}`).toBe(l.from);
    }
  });
});

describe("运转图 · 统计", () => {
  it("数得出来几个人、几个 AI、几个程序", () => {
    const s = orgStats(TREE);
    expect(s.total).toBe(20);
    expect(s.depth).toBe(4);
    expect(s.byActor.human).toBe(1);
    // 总管 + 前端 + 后端 + 测试 + 文档 + 巡检 = 6 个 AI
    expect(s.byActor.ai).toBe(6);
    // 运维 + 12 个资产都是程序在收 = 13 个
    expect(s.byActor.program).toBe(13);
  });

  it("byActor 加起来必须等于总数 —— 不然就是分类漏了", () => {
    const s = orgStats(TREE);
    expect(s.byActor.human + s.byActor.ai + s.byActor.program).toBe(s.total);
  });

  it("有看数的节点占比 —— 这个数低了说明有角色不知道凭什么做判断", () => {
    const s = orgStats(TREE);
    // 只看数的：6 个领域 + 12 个资产 = 18；人和总管不看数
    expect(s.watchedRatio).toBe(0.9);
  });

  it("空树不会除零", () => {
    const solo: OrgTree = {
      root: { ...TREE.root, children: [], watches: [] },
      links: [],
    };
    const s = orgStats(solo);
    expect(s.total).toBe(1);
    expect(s.depth).toBe(1);
    expect(s.watchedRatio).toBe(0);
  });

  it("占比保留两位小数 —— 界面上不该出现 66.66666%", () => {
    const s = orgStats(TREE);
    expect(String(s.watchedRatio).length).toBeLessThanOrEqual(5);
  });
});