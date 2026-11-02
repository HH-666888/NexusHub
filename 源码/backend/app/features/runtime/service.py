"""运行时的业务：建库、起容器、验证、回收。

规则（契约 §5.9）：同一 run 重复调用要幂等；停止时容器与库一起回收。
这里不碰 SQLAlchemy（走 repo），也不拼 HTTP（走 router）。
"""


class RuntimeError_(Exception):
    """运行时错误。带上契约里的错误码，由全局处理器包成信封。"""

    def __init__(self, code: str, message: str, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
