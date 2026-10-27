/**
 * 保护用户名校验与归一化、密码强度、会话有效期。
 */

import { describe, expect, it } from "vitest";
import {
  checkPasswordStrength,
  checkUsername,
  isSessionExpired,
  normalizeUsername,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_TTL_MS,
  USERNAME_MAX,
  USERNAME_MIN,
  type Session,
} from "@/core/domain/user";

describe("用户名校验", () => {
  it("接受字母、数字、下划线、连字符", () => {
    for (const n of ["zhangsan", "user_01", "my-name", "abc123"]) {
      expect(checkUsername(n).ok, n).toBe(true);
    }
  });

  it("接受中文用户名 —— 强迫人把“张三”写成拼音是无谓的摩擦", () => {
    const r = checkUsername("张三");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("张三");
  });

  it("归一化为小写，避免大小写记错就登不上", () => {
    const r = checkUsername("  ZhangSan  ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("zhangsan");
  });

  it("太短或太长都被拒绝", () => {
    expect(checkUsername("a").ok).toBe(false);
    expect(checkUsername("a".repeat(USERNAME_MAX + 1)).ok).toBe(false);
    // 边界值恰好通过
    expect(checkUsername("a".repeat(USERNAME_MIN)).ok).toBe(true);
    expect(checkUsername("a".repeat(USERNAME_MAX)).ok).toBe(true);
  });

  it("只有空白被拒绝", () => {
    expect(checkUsername("   ").ok).toBe(false);
    expect(checkUsername("").ok).toBe(false);
  });

  it("含空格、@、点号等符号一律拒绝", () => {
    for (const n of ["a b", "a@b", "a.b", "a!b", "a/b", "a\\b", "a#b"]) {
      expect(checkUsername(n).ok, n).toBe(false);
    }
  });

  it("拒绝的提示语可以直接显示给用户", () => {
    const r = checkUsername("a");
    expect(r.reason).toBeTruthy();
    expect(r.reason).toContain(String(USERNAME_MIN));
  });
});

describe("用户名归一化", () => {
  it("去空格并转小写", () => {
    expect(normalizeUsername("  ZhangSan  ")).toBe("zhangsan");
  });

  it("对中文是无操作", () => {
    expect(normalizeUsername("张三")).toBe("张三");
  });

  it("归一化之后大小写变体指向同一个账号", () => {
    expect(normalizeUsername("ABC")).toBe(normalizeUsername("abc"));
  });
});

describe("密码强度", () => {
  it(`少于 ${PASSWORD_MIN} 位直接拒绝`, () => {
    const r = checkPasswordStrength("Ab1!");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(PASSWORD_MIN));
  });

  it("恰好达到长度门槛且有两类字符就通过", () => {
    expect(checkPasswordStrength("abc123").ok).toBe(true);
  });

  it("单一字符类型拒绝 —— 挡住 123456 与 abcdef 这类最差密码", () => {
    expect(checkPasswordStrength("123456").ok).toBe(false);
    expect(checkPasswordStrength("abcdef").ok).toBe(false);
    expect(checkPasswordStrength("!!!!!!").ok).toBe(false);
  });

  it("超长密码拒绝（防止拿超长输入拖垮哈希计算）", () => {
    expect(checkPasswordStrength("a1".repeat(PASSWORD_MAX)).ok).toBe(false);
  });

  it("数字加字母即可，不强制要求符号", () => {
    expect(checkPasswordStrength("zhang123").ok).toBe(true);
    expect(checkPasswordStrength("张三abc123").ok).toBe(true);
  });

  it("通过的返回值就是原密码", () => {
    expect(checkPasswordStrength("abc123").value).toBe("abc123");
  });
});

describe("会话有效期", () => {
  const base: Session = {
    id: "x",
    userId: 1,
    createdAt: 1000,
    expiresAt: 1000 + SESSION_TTL_MS,
    userAgent: null,
    ip: null,
  };

  it("未到期时有效", () => {
    expect(isSessionExpired(base, 2000)).toBe(false);
  });

  it("到期瞬间即算过期（边界取闭区间）", () => {
    expect(isSessionExpired(base, base.expiresAt)).toBe(true);
  });

  it("超过有效期算过期", () => {
    expect(isSessionExpired(base, base.expiresAt + 1)).toBe(true);
  });
});
