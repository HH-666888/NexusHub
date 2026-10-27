/**
 * 保护 scrypt 密码哈希与令牌哈希：格式、随机盐、篡改检测与参数升级。
 */

import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "@/core/auth/password";
import { createSessionToken, hashSessionToken } from "@/core/auth/session";

describe("密码哈希（scrypt）", () => {
  it("哈希结果不是明文，且格式自描述", async () => {
    const hash = await hashPassword("Abcd1234!");
    expect(hash).not.toContain("Abcd1234!");
    expect(hash.startsWith("scrypt$")).toBe(true);
    // scrypt$N$r$p$盐$哈希 —— 共 6 段
    expect(hash.split("$")).toHaveLength(6);
  });

  it("同一个密码两次哈希结果不同（每次独立随机盐）", async () => {
    const a = await hashPassword("Abcd1234!");
    const b = await hashPassword("Abcd1234!");
    expect(a).not.toBe(b);
    // 但两个都能验证通过
    expect(await verifyPassword("Abcd1234!", a)).toBe(true);
    expect(await verifyPassword("Abcd1234!", b)).toBe(true);
  });

  it("正确密码验证通过，错误密码不通过", async () => {
    const hash = await hashPassword("Abcd1234!");
    expect(await verifyPassword("Abcd1234!", hash)).toBe(true);
    expect(await verifyPassword("Abcd1235!", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("abcd1234!", hash)).toBe(false);
  });

  it("哈希被篡改时验证失败，且不抛异常", async () => {
    const hash = await hashPassword("Abcd1234!");
    const parts = hash.split("$");

    // 不能直接改 Base64 最后一个字符：64 字节哈希编码成 86 个字符，
    // 最后那位只有低 2 位是真实数据，翻转补齐位解码回来字节没变。
    // 改成翻转真实字节的最低位，结果才是确定的。
    const bytes = Buffer.from(parts[5], "base64url");
    bytes[0] = bytes[0] ^ 0x01;
    parts[5] = bytes.toString("base64url");

    expect(parts[5]).not.toBe(hash.split("$")[5]); // 先确认确实改动了
    expect(await verifyPassword("Abcd1234!", parts.join("$"))).toBe(false);
  });

  it("格式损坏的哈希不会抛异常，只是返回 false", async () => {
    for (const bad of ["", "abc", "scrypt$1$2$3", "bcrypt$1$2$3$4$5"]) {
      await expect(verifyPassword("Abcd1234!", bad)).resolves.toBe(false);
    }
  });

  it("当前参数生成的哈希不需要重算", async () => {
    const hash = await hashPassword("Abcd1234!");
    expect(needsRehash(hash)).toBe(false);
  });

  it("强度参数偏低的老哈希会被标记为需要升级", () => {
    // 模拟一个早期用 N=1024 生成的哈希
    const legacy = "scrypt$1024$8$1$c2FsdA$aGFzaA";
    expect(needsRehash(legacy)).toBe(true);
    // 格式损坏的也当作需要升级
    expect(needsRehash("garbage")).toBe(true);
  });
});

describe("会话令牌", () => {
  it("每次生成的令牌都不同，且足够长", () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) set.add(createSessionToken());
    expect(set.size).toBe(50);
    // 32 字节 base64url 编码后是 43 个字符
    expect(createSessionToken()).toHaveLength(43);
  });

  it("令牌哈希稳定且不可逆", () => {
    const token = createSessionToken();
    const h1 = hashSessionToken(token);
    const h2 = hashSessionToken(token);
    expect(h1).toBe(h2); // 同一个令牌哈希稳定
    expect(h1).not.toContain(token); // 不可逆
    expect(h1).toHaveLength(64); // sha256 十六进制
  });

  it("不同令牌的哈希不同", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });
});
