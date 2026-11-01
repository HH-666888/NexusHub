"""会话工厂。

expire_on_commit=False：提交后还要读对象属性（比如返回新建的 run），
默认行为会在提交后让属性失效并触发额外查询。
"""

from sqlalchemy.orm import sessionmaker

from app.db.engine import engine

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)
