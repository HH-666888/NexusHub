"""时间。

全项目只有一种时间表示：epoch 毫秒整数（契约书 §4.3）。
不引入 datetime 做业务时间 —— 时区问题在数据库契约里已经从根上排除了。
"""

from time import time


def now_ms() -> int:
    return int(time() * 1000)


def elapsed_ms(started_at: int) -> int:
    return now_ms() - started_at
