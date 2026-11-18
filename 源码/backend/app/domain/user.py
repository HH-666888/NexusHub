"""账号与会话的规则。

刻意的取舍：**只校验长度**。
- 用户名：去空格转小写，4–20 个字符
- 密码：6–128 位
不限制字符种类（不再要求"至少两类"），因为这一层随时可以加严，
而现在加只会挡住正常注册。真正不能省的是唯一性与最大长度（数据库列宽）。
"""

from app.domain.base import ApiModel

USERNAME_MIN = 4
USERNAME_MAX = 20
PASSWORD_MIN = 6
PASSWORD_MAX = 128

# 登录态保持 7 天（与前端 SESSION_TTL_MS 一致）
SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000


class FieldCheck(ApiModel):
    """字段校验结果。`value` 是归一化后的值，只有 ok 时才有意义。"""

    ok: bool
    reason: str | None = None
    value: str | None = None


def normalize_username(raw: str) -> str:
    """去空格 + 转小写。否则 ZhangSan 与 zhangsan 会指向两个账号。"""
    return raw.strip().lower()


def check_username(raw: str) -> FieldCheck:
    value = normalize_username(raw)
    if len(value) < USERNAME_MIN:
        return FieldCheck(ok=False, reason=f"用户名至少 {USERNAME_MIN} 个字符")
    if len(value) > USERNAME_MAX:
        return FieldCheck(ok=False, reason=f"用户名最多 {USERNAME_MAX} 个字符")
    return FieldCheck(ok=True, value=value)


def check_password_strength(password: str) -> FieldCheck:
    """长度之外，还要求字母和数字都出现。

    只有长度的规则等于没有强度：`abcdef` 这类纯字母口令能直接过，
    弱口令策略那一项就是空的。
    """
    if len(password) < PASSWORD_MIN:
        return FieldCheck(ok=False, reason=f"密码至少 {PASSWORD_MIN} 位")
    if len(password) > PASSWORD_MAX:
        return FieldCheck(ok=False, reason=f"密码过长（最多 {PASSWORD_MAX} 位）")
    if not any(ch.isalpha() for ch in password):
        return FieldCheck(ok=False, reason="密码至少要包含一个字母")
    if not any(ch.isdigit() for ch in password):
        return FieldCheck(ok=False, reason="密码至少要包含一个数字")
    return FieldCheck(ok=True, value=password)


class User(ApiModel):
    """对外形状：**不含密码哈希**。哈希只在 repo 与 service 之间流动。"""

    id: int
    username: str
    display_name: str
    created_at: int


class UserAccount(User):
    """带凭据的内部形状。只在 features/auth 内部使用。"""

    password_hash: str
