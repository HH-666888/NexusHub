"""配置只在这里读一次。

别处一律 `from app.config import get_settings`，不要在模块里直接读 os.environ ——
散着读的话，测试就没法替换，部署时也说不清哪个变量生效了。
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """环境变量表。字段名是小写，对应的大写环境变量由 pydantic-settings 自动匹配。"""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # 数据库：契约要求 utf8mb4 与 UTC
    database_url: str = "mysql+pymysql://nexus:nexus@127.0.0.1:3306/nexus?charset=utf8mb4"

    # 模型
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_api_key: str = ""
    model_decide: str = "deepseek-chat"
    model_execute: str = "deepseek-chat"

    # 运行预算
    run_cost_limit_cny: float = 5.0

    # 语料目录（相对 backend/ 根）
    playbook_dir: str = "content/playbook"

    # cookie 的 Secure 标记：本地 http 打开会让浏览器不回传 cookie（表现为登录后又变未登录）
    cookie_secure: bool = False

    # 同源部署时留空；本地两端不同端口调试才需要
    allowed_origin: str = ""

    # ---- 全栈运行时（契约 §5.9）----

    # 建库建用户用的供给账号；留空则供给接口直接 503
    mysql_provisioner_url: str = ""
    # 产物代码用的账号（只对 nexus_run_% 有权限）；主机在这里写死 127.0.0.1，
    # 注入给容器时会换成 host.docker.internal
    mysql_product_url: str = ""
    # 内部调用的口令：Next 侧带 x-internal-token 才能进；两侧必须一致
    internal_token: str = ""
    # 运行器：docker（默认，有隔离）或 process（开发机没有 docker 时的退路，无隔离）
    # ── 新链路 ──
    pipeline: str = "demo"            # demo | real
    record_mode: str = "off"          # off | record | replay
    max_loopback: int = 2
    ask_max_questions: int = 0        # 0 = 不限
    ask_max_rounds: int = 0           # 0 = 不限
    memory_daily_limit: int = 3       # AI 记忆每天最多写几条

    runtime_runner: str = "docker"

    # 产物工作区：与前端 WORKSPACE_ROOT 指向同一个目录（容器把它只读挂载进去）
    runtime_workspace_dir: str = "./data/workspace"


@lru_cache
def get_settings() -> Settings:
    """进程内单例。测试里改环境变量后调用 get_settings.cache_clear() 即可重读。"""
    return Settings()
