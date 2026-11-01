"""账号与会话的规则（契约书 §3.1、§4.1）。

规则照抄前端 `core/domain/user.ts`，一个字都没改：用户名去空格转小写、2–20 字符、
允许中文/字母/数字/下划线/连字符；密码 6–128 位、至少包含两类字符；会话 7 天。

**两边不许各写一套**：前端负责即时反馈，后端负责最终裁决，判据必须是同一份。
"""

from app.domain.base import ApiModel

USERNAME_MIN = 2
USERNAME_MAX = 20
PASSWORD_MIN = 6
PASSWORD_MAX = 128

# 登录态保持 7 天（与前端 SESSION_TTL_MS 一致）
SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

_ALLOWED_USERNAME = r"^[\u4e00-\u9fa5A-Za-z0-9_-]+$"


class FieldCheck(ApiModel):
    """字段校验结果。`value` 是归一化后的值，只有 ok 时才有意义。"""

    ok: bool
    reason: str | None = None
    value: str | None = None


def normalize_username(raw: str) -> str:
    """去空格 + 转小写。否则 ZhangSan 与 zhangsan 会指向两个账号。"""
    return raw.strip().lower()


def check_username(raw: str) -> FieldCheck:
    import re

    value = normalize_username(raw)
    if len(value) < USERNAME_MIN:
        return FieldCheck(ok=False, reason=f"用户名至少 {USERNAME_MIN} 个字符")
    if len(value) > USERNAME_MAX:
        return FieldCheck(ok=False, reason=f"用户名最多 {USERNAME_MAX} 个字符")
    if re.search(r"\s", raw.strip()):
        return FieldCheck(ok=False, reason="用户名不能包含空格")
    if not re.match(_ALLOWED_USERNAME, value):
        return FieldCheck(ok=False, reason="用户名只能包含中文、字母、数字、下划线或连字符")
    return FieldCheck(ok=True, value=value)


def check_password_strength(password: str) -> FieldCheck:
    """至少两类字符。123456、abcdef 这类单一字符由"至少两类"挡住。"""
    if len(password) < PASSWORD_MIN:
        return FieldCheck(ok=False, reason=f"密码至少 {PASSWORD_MIN} 位")
    if len(password) > PASSWORD_MAX:
        return FieldCheck(ok=False, reason=f"密码过长（最多 {PASSWORD_MAX} 位）")

    kinds = sum(
        (
            any(c.islower() for c in password),
            any(c.isupper() for c in password),
            any(c.isdigit() for c in password),
            any(not c.isalnum() for c in password),
        )
    )
    if kinds < 2:
        return FieldCheck(ok=False, reason="密码需要包含字母、数字、符号中的至少两类")
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
