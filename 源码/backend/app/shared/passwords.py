"""密码哈希。

用 argon2id（数据库契约 §3.1）：内存硬、并行度可调，是目前的一线选择。

**迁移提示**：迁移前的前端版本用的是 Node 的 scrypt，哈希串格式完全不同。
如果要把老用户带过来，必须先按 scrypt 校验一次、成功后立刻用 argon2 重算
（"登录时静默升级"），不能直接当成 argon2 去验 —— 那会让所有老账号登不进来。
"""

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

_hasher = PasswordHasher()

# 用户不存在时也跑一次校验，避免"响应快慢"泄露账号是否存在
_DUMMY_HASH = _hasher.hash("nexus-dummy-password")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False


def burn_password_time() -> None:
    """账号不存在时调用：让耗时与"密码错"那条路径接近，挡住时序侧信道。"""
    verify_password("nexus-dummy-password", _DUMMY_HASH)
