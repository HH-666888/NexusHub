"""ORM 基类。

只给 models.py 用。业务侧不认识它 —— 对外一律是 app.domain 里的 Pydantic 模型。
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
