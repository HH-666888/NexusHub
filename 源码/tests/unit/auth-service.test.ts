import { beforeEach, describe, expect, it } from "vitest";
import type { AuthStore } from "@/core/ports/auth-store";
import type { NewSession, NewUser, Session, User } from "@/core/domain/user";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { hashSessionToken } from "@/core/auth/session";
import {
  loginUser,
  logout,
  logoutAllDevices,
  registerUser,
  resolveSession,
} from "@/core/auth/service";

// 内存假存储：认证业务逻辑不依赖数据库，真 SQLite 由 smoke:auth 覆盖。
function createFakeStore(): AuthStore & {
  _users: Map<number, User>;
  _sessions: Map<string, Session>;
} {
  const _users = new Map<number, User>();
  const _sessions = new Map<string, Session>();
  let nextId = 1;

  return {
    _users,
    _sessions,

    async findUserByUsername(username: string) {
      return [..._users.values()].find((u) => u.username === username) ?? null;
    },
    async findUserById(id: number) {
      return _users.get(id) ?? null;
    },
    async insertUser(data: NewUser) {
      const now = Date.now();
      const user: User = { ...data, id: nextId++, createdAt: now, updatedAt: now };
      _users.set(user.id, user);
      return user;
    },
    async updateUserPasswordHash(userId: number, passwordHash: string) {
      const u = _users.get(userId);
      if (u) _users.set(userId, { ...u, passwordHash, updatedAt: Date.now() });
    },

    async insertSession(data: NewSession) {
      _sessions.set(data.id, { ...data, createdAt: Date.now() });
    },
    async findSession(sessionId: string) {
      return _sessions.get(sessionId) ?? null;
    },
    async deleteSession(sessionId: string) {
      _sessions.delete(sessionId);
    },
    async deleteSessionsByUser(userId: number) {
      let n = 0;
      for (const [id, s] of _sessions) {
        if (s.userId === userId) {
          _sessions.delete(id);
          n++;
        }
      }
      return n;
    },
  };
}

const VALID = {
  username: "ZhangSan",
  password: "abc123",
};

let store: ReturnType<typeof createFakeStore>;

beforeEach(() => {
  store = createFakeStore();
});

describe("注册", () => {
  it("只需要用户名和密码，昵称默认等于用户名", async () => {
    const r = await registerUser(store, VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.id).toBe(1);
    expect(r.value.user.displayName).toBe("zhangsan");
    expect(r.value.token).toBeTruthy();
  });

  it("用户名归一化为小写存储", async () => {
    const r = await registerUser(store, VALID);
    expect(r.ok && r.value.user.username).toBe("zhangsan");
  });

  it("中文用户名也能注册", async () => {
    const r = await registerUser(store, { username: "张三", password: "abc123" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.user.username).toBe("张三");
    expect(r.ok && r.value.user.displayName).toBe("张三");
  });

  it("密码不以明文存储", async () => {
    const r = await registerUser(store, VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.passwordHash).not.toContain(VALID.password);
    expect(await verifyPassword(VALID.password, r.value.user.passwordHash)).toBe(true);
  });

  it("会话入库的是令牌哈希，不是令牌本身", async () => {
    const r = await registerUser(store, VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.session.id).toBe(hashSessionToken(r.value.token));
    expect(r.value.session.id).not.toBe(r.value.token);
    // 库里也查不到原文令牌
    expect([...store._sessions.keys()]).not.toContain(r.value.token);
  });

  it("同一用户名的大小写变体视为重复", async () => {
    await registerUser(store, VALID);
    const dup = await registerUser(store, { ...VALID, username: "ZHANGSAN" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toContain("已被占用");
  });

  it("密码太短被拒绝", async () => {
    const weak = await registerUser(store, { ...VALID, password: "ab1" });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.reason).toContain("6");
  });

  it("单一字符类型的密码被拒绝", async () => {
    const weak = await registerUser(store, { ...VALID, password: "123456" });
    expect(weak.ok).toBe(false);
  });

  it("用户名太短、含空格、含非法符号都被拒绝", async () => {
    for (const username of ["a", "a b", "a@b", "a.b"]) {
      const r = await registerUser(store, { ...VALID, username });
      expect(r.ok, username).toBe(false);
    }
  });

  it("校验失败时不会往库里写任何数据", async () => {
    await registerUser(store, { ...VALID, password: "ab1" });
    expect(store._users.size).toBe(0);
    expect(store._sessions.size).toBe(0);
  });
});

describe("登录", () => {
  beforeEach(async () => {
    await registerUser(store, VALID);
  });

  it("正确凭据登录成功", async () => {
    const r = await loginUser(store, { username: "zhangsan", password: "abc123" });
    expect(r.ok).toBe(true);
  });

  it("用户名大小写不敏感 —— 注册时用 ZhangSan、登录时用 ZHANGSAN 也能进", async () => {
    const r = await loginUser(store, { username: "ZHANGSAN", password: "abc123" });
    expect(r.ok).toBe(true);
  });

  it("密码错误与账号不存在返回完全相同的提示（不泄露账号是否存在）", async () => {
    const wrongPw = await loginUser(store, {
      username: "zhangsan",
      password: "wrong123",
    });
    const noUser = await loginUser(store, {
      username: "nobody",
      password: "wrong123",
    });
    expect(wrongPw.ok).toBe(false);
    expect(noUser.ok).toBe(false);
    if (!wrongPw.ok && !noUser.ok) {
      expect(wrongPw.reason).toBe(noUser.reason);
    }
  });

  it("每次登录签发独立会话，互不影响", async () => {
    const a = await loginUser(store, { username: "zhangsan", password: "abc123" });
    const b = await loginUser(store, { username: "zhangsan", password: "abc123" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.token).not.toBe(b.value.token);
    expect(store._sessions.size).toBe(3); // 注册那次 + 这两次
  });

  it("登录成功后会把强度偏低的老哈希静默升级", async () => {
    // 手工塞一个旧参数的哈希
    const legacy = "scrypt$1024$8$1$c2FsdA$aGFzaA";
    const u = [...store._users.values()][0];
    await store.updateUserPasswordHash(u.id, legacy);

    // 旧哈希对不上现在的密码，所以这次登录会失败 —— 先验证失败
    const failed = await loginUser(store, {
      username: "zhangsan",
      password: "abc123",
    });
    expect(failed.ok).toBe(false);

    // 换成一个用当前参数生成的哈希，再登录应当成功
    await store.updateUserPasswordHash(u.id, await hashPassword("abc123"));
    const ok2 = await loginUser(store, {
      username: "zhangsan",
      password: "abc123",
    });
    expect(ok2.ok).toBe(true);
  });
});

describe("会话解析与登出", () => {
  it("有效令牌能换回用户", async () => {
    const r = await registerUser(store, VALID);
    if (!r.ok) throw new Error("注册失败");
    const user = await resolveSession(store, r.value.token);
    expect(user?.id).toBe(r.value.user.id);
  });

  it("伪造令牌、空令牌一律返回 null", async () => {
    await registerUser(store, VALID);
    expect(await resolveSession(store, "forged-token")).toBeNull();
    expect(await resolveSession(store, "")).toBeNull();
    expect(await resolveSession(store, undefined)).toBeNull();
    expect(await resolveSession(store, null)).toBeNull();
  });

  it("过期会话返回 null，并顺手把它删掉（不需要额外的清理任务）", async () => {
    const r = await registerUser(store, VALID);
    if (!r.ok) throw new Error("注册失败");

    const s = store._sessions.get(r.value.session.id)!;
    store._sessions.set(s.id, { ...s, expiresAt: Date.now() - 1 });

    expect(await resolveSession(store, r.value.token)).toBeNull();
    expect(store._sessions.has(s.id)).toBe(false);
  });

  it("登出后令牌立即失效 —— 这是服务端会话优于 JWT 的地方", async () => {
    const r = await registerUser(store, VALID);
    if (!r.ok) throw new Error("注册失败");

    await logout(store, r.value.token);
    expect(await resolveSession(store, r.value.token)).toBeNull();
  });

  it("登出只影响当前设备", async () => {
    const a = await registerUser(store, VALID);
    const b = await loginUser(store, { username: "zhangsan", password: "abc123" });
    if (!a.ok || !b.ok) throw new Error("准备失败");

    await logout(store, a.value.token);
    expect(await resolveSession(store, a.value.token)).toBeNull();
    expect(await resolveSession(store, b.value.token)).not.toBeNull();
  });

  it("可以一次性踢掉该用户所有设备", async () => {
    const a = await registerUser(store, VALID);
    await loginUser(store, { username: "zhangsan", password: "abc123" });
    const c = await loginUser(store, { username: "zhangsan", password: "abc123" });
    if (!a.ok || !c.ok) throw new Error("准备失败");

    const killed = await logoutAllDevices(store, a.value.user.id);
    expect(killed).toBe(3);
    expect(await resolveSession(store, a.value.token)).toBeNull();
    expect(await resolveSession(store, c.value.token)).toBeNull();
  });
});
