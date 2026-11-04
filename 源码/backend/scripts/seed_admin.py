"""种一个演示管理员账号：admin / 123456。

说明：注册接口要求"至少两类字符"，而 123456 只有数字，走正常注册会被拒。
这个脚本走数据层直接落库（哈希仍然用 argon2id），只用于比赛演示账号。

可重复执行：已存在就跳过。
用法（在 源码/backend 下）：
    python -m scripts.seed_admin
"""

from __future__ import annotations

from app.db.session import SessionLocal
from app.features.auth.repo import SqlAuthStore
from app.shared.passwords import hash_password
from app.shared.time import now_ms

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "123456"


def main() -> int:
    db = SessionLocal()
    try:
        store = SqlAuthStore(db)
        if store.find_user_by_username(ADMIN_USERNAME) is not None:
            print(f"已存在：{ADMIN_USERNAME}，跳过")
            return 0

        now = now_ms()
        account = store.insert_user(
            username=ADMIN_USERNAME,
            display_name="管理员",
            password_hash=hash_password(ADMIN_PASSWORD),
            now=now,
        )
        db.commit()
        print(f"已创建：{account.username} / {ADMIN_PASSWORD}（id={account.id}，绕过密码强度校验）")
        return 0
    except Exception as error:  # noqa: BLE001 - 脚本要给出人话
        db.rollback()
        print(f"创建失败：{error}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())