"""把一份 .sql 文件拆成可逐条执行的语句。

为什么要拆：MySQL 的 DDL 不是事务性的，整段一起发的话，中途失败会留下
"建了一半的表"，很难收拾。逐条执行至少能定位到是哪一条挂了。
"""

import re


def split_statements(sql: str) -> list[str]:
    """按行剥掉 `--` 注释，再按分号切分。够用就好，不实现完整 SQL 词法分析。"""
    without_comments = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    statements = [part.strip() for part in re.split(r";\s*(?:\n|$)", without_comments)]
    return [s for s in statements if s]
