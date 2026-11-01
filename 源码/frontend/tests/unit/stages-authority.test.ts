import { describe, expect, it } from "vitest";
import {
  STAGES,
  STAGE_MAP,
  stageApproval,
  stageAuthorityNote,
} from "@/core/pipeline/stages";
import {
  actorBadge,
  authorityOf,
  explainAuthority,
  requiredApproval,
  resolveScope,
} from "@/core/pipeline/authority";

/**
 * 保护六道工序的权限：谁在做、能不能改、要不要人点头、看什么数。
 * 改错了界面徽章与告警会跟着错，而那种错从画面上看不出来。
 */

describe("工序权限 · 基本形状", () => {
  it("六道工序都填齐了四个字段", () => {
    // 缺一个的话界面上会显示成空白，或者落到"保守推定"那一档 ——
    // 而保守推定会让一道内部工序被当成对外，多问一次人
    for (const s of STAGES) {
      expect(s.actor, `${s.name} 没写谁做`).toBeTruthy();
      expect(s.access, `${s.name} 没写能不能改`).toBeTruthy();
      expect(s.watches.length, `${s.name} 没写看什么数`).toBeGreaterThan(0);
    }
  });

  it("最要紧验收与交付必须是只读的", () => {
    // 判定者不参与生产：验收若也能改，自己修完自己判过就不再是独立检查。
    // 谁把 access 改成 write，这条会红。
    const verify = STAGE_MAP.verify;
    expect(verify.access).toBe("read");
    expect(verify.scope).toBe("observe");
    expect(resolveScope(verify)).toBe("observe");
    expect(actorBadge(verify)).toBe("AI · 只读");
  });

  it("只有验收是只读的 —— 其余五道都在写东西", () => {
    const readOnly = STAGES.filter((s) => s.access === "read");
    expect(readOnly.map((s) => s.id)).toEqual(["verify"]);
  });

  it("六道工序都是 AI 在做（现在还没有需要人动手的工序）", () => {
    // 将来如果加了"人工确认上线"之类，这条会红 —— 那时该改的是断言
    expect(STAGES.map((s) => s.actor)).toEqual(["ai", "ai", "ai", "ai", "ai", "ai"]);
  });
});

describe("工序权限 · 要不要人点头", () => {
  it("规则算出来：只看不改的不用批，写自己这边的也不用批", () => {
    for (const s of STAGES) {
      if (s.humanGate) continue; // 加码的那一道单说
      expect(requiredApproval(s), `${s.name} 按规则不该要人批`).toBe("none");
    }
  });

  it("humanGate 只能抬高，不能降低", () => {
    // 规格化按规则算是不用人批，但故意让它停下来问：规格错了后面五道全白做。
    // 反过来不行：加一道门的人不该顺手把权限也放开。
    const fake = {
      ...STAGE_MAP.verify,
      actor: "ai" as const,
      access: "write" as const,
      scope: "outward" as const,
    };
    // outward + ai → 规则说要人批，加不加 humanGate 都是要
    expect(requiredApproval(fake)).toBe("human");
  });

  it("规格化是唯一加了人工门禁的工序", () => {
    const gated = STAGES.filter((s) => s.humanGate);
    expect(gated.map((s) => s.id)).toEqual(["spec"]);
  });

  it("加码的那一道，说明里要讲清为什么", () => {
    // 只说"要不要人批"不够 —— 用户得知道为什么偏偏是这一步
    const note = stageAuthorityNote(STAGE_MAP.spec);
    expect(note).toContain("故意");
    expect(note).toContain("决定后面每一道怎么做");
  });

  it("没加码的那些，说明就是规则本身那句话", () => {
    expect(stageAuthorityNote(STAGE_MAP.verify)).toBe(
      explainAuthority(STAGE_MAP.verify),
    );
  });

  it("stageApproval 对六道工序都给得出结论", () => {
    for (const s of STAGES) {
      expect(["none", "human"], `${s.name}`).toContain(stageApproval(s));
    }
    expect(stageApproval(STAGE_MAP.spec)).toBe("human");
    expect(stageApproval(STAGE_MAP.build)).toBe("none");
  });
});

describe("工序权限 · 整套流程的画像", () => {
  const report = authorityOf(STAGES);

  it("算得出哪些只看不改", () => {
    expect(report.observeOnly.map((o) => o.id)).toEqual(["verify"]);
  });

  it("没有任何一处是对外的 —— 所以没有“失守”这回事", () => {
    // 这是如实报告，不是检查通过：Nexus 不部署不发布，六道工序全在自己这边做。
    // 哪天加了一道真的对外的工序，这里会红，那时必须同时补人拍板。
    expect(report.unguarded).toHaveLength(0);
    expect(report.gated).toHaveLength(0);
  });

  it("结论是一句人话，不是“通过”两个字", () => {
    expect(report.verdict).toContain("1 处只看不改");
  });

  it("空流程不会崩", () => {
    const empty = authorityOf([]);
    expect(empty.verdict).toBe("还没有工序");
  });
});

describe("工序权限 · 看什么数", () => {
  it("每一道都说得出来", () => {
    for (const s of STAGES) {
      for (const w of s.watches) {
        expect(w.label.trim(), `${s.name} 有一个空的指标名`).toBeTruthy();
      }
    }
  });

  it("验收看的是判定依据，不是产出指标", () => {
    // 通过率、无法判定项，这些是我凭什么说做完了
    // 而不是"我做了多少"。后者是生产者的说法，不是判定者的。
    const labels = STAGE_MAP.verify.watches.map((w) => w.label).join(" ");
    expect(labels).toContain("通过率");
    expect(labels).toContain("无法判定项");
  });

  it("规格化看的是用户原话 —— 那是它唯一的依据", () => {
    const labels = STAGE_MAP.spec.watches.map((w) => w.label).join(" ");
    expect(labels).toContain("用户原话");
  });
});
