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

    # 运行预算与并行
    run_cost_limit_cny: float = 5.0
    max_parallel_build: int = 3

    # 语料目录（相对 backend/ 根）
    playbook_dir: str = "content/playbook"

    # cookie 的 Secure 标记：本地 http 打开会让浏览器不回传 cookie（表现为登录后又变未登录）
    cookie_secure: bool = False

    # 同源部署时留空；本地两端不同端口调试才需要
    allowed_origin: str = ""


@lru_cache
def get_settings() -> Settings:
    """进程内单例。测试里改环境变量后调用 get_settings.cache_clear() 即可重读。"""
    return Settings()
