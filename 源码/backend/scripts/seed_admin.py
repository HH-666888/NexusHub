"""种一个演示管理员账号：admin / 123456。

规则放宽后（只校验长度：用户名 4–20、密码 ≥6），123456 走正常注册即可，
不再需要绕过校验。

可重复执行：已存在就跳过。
用法（在 源码/backend 下）：
    python -m scripts.seed_admin
"""

from __future__ import annotations

from app.db.session import SessionLocal
from app.features.auth import service as auth_service
from app.features.auth.repo import SqlAuthStore
from app.shared.errors import AppError
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

        user, _token = auth_service.register(
            store,
            username=ADMIN_USERNAME,
            password=ADMIN_PASSWORD,
            confirm_password=ADMIN_PASSWORD,
            now=now_ms(),
        )
        db.commit()
        print(f"已创建：{user.username} / {ADMIN_PASSWORD}（id={user.id}）")
        return 0
    except AppError as error:
        db.rollback()
        print(f"创建失败：{error}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())