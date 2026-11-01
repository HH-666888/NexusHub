/**
 * 密码哈希
 * ============================================================
 * 用 Node 内置的 scrypt，不引入任何第三方加密库。
 *
 * 为什么是 scrypt：
 *   OWASP 密码存储建议的排序是 Argon2id > scrypt > bcrypt > PBKDF2。
 *   scrypt 排在第二，而且 Node 内置 —— 既安全又零依赖。
 *   零依赖这件事对本项目有实际意义：
 *   不必担心某个第三方包被投毒（业界已发生过凭据窃取器被植入的情况）。
 *
 * 三条纪律：
 *   1. 绝不存明文密码
 *   2. 每个用户独立随机盐，杜绝彩虹表与“同密码同哈希”
 *   3. 校验用时间恒定比较，杜绝时序侧信道
 *
 * 存储格式自描述：scrypt$N$r$p$盐$哈希
 * 好处：以后想提高强度参数，老密码依然能验证通过，
 *       可以在用户下次登录成功时静默升级到新参数。
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** CPU/内存代价参数。N 越大越安全也越慢 */
const PARAMS = {
  N: 16384, // 2^14，约 16 MB 内存代价
  r: 8,
  p: 1,
} as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt 内存上限：128 * N * r，留一倍余量 */
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

/** 异步版本，避免阻塞事件循环（登录时同步哈希会卡住其他请求） */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * 生成密码哈希。
 * 返回形如：scrypt$16384$8$1$<盐>$<哈希>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * 校验密码。
 *
 * 注意：无论成功失败，耗时都应当接近 —— 因此即使哈希格式损坏，
 * 也走一次完整的 scrypt 计算再返回 false，避免通过响应时间判断账号是否存在。
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  const wellFormed =
    parts.length === 6 &&
    parts[0] === "scrypt" &&
    Number.isFinite(Number(parts[1])) &&
    Number.isFinite(Number(parts[2])) &&
    Number.isFinite(Number(parts[3]));

  if (!wellFormed) {
    // 格式损坏也要消耗一次等价的计算量，然后失败
    await scryptAsync(password, randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
    return false;
  }

  const params = {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  };
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");

  const actual = await scryptAsync(password, salt, expected.length, params);

  // 长度不等时 timingSafeEqual 会抛错，必须先判断
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 判断一个已存哈希是否使用了当前的强度参数。
 * 用于在用户登录成功时静默升级旧哈希。
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return (
    Number(parts[1]) !== PARAMS.N ||
    Number(parts[2]) !== PARAMS.r ||
    Number(parts[3]) !== PARAMS.p
  );
}
