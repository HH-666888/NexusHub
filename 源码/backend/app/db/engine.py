"""引擎只建一次。

参数按数据库契约 §4.6：连接池 5+10、pre_ping 防死连接、recycle 小于 MySQL 的
wait_timeout（默认 8 小时，这里 30 分钟），免得拿到被服务端关掉的连接。
"""

from sqlalchemy import create_engine

from app.config import get_settings

engine = create_engine(
    get_settings().database_url,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True,
)
