"""模型层工厂：按阶段选模型，按配置包录制回放。"""

from __future__ import annotations

from contextvars import ContextVar
from pathlib import Path

from app.config import get_settings
from app.api.ai.model.client import ModelClient
from app.api.ai.model.record import RecordedModelClient

_DECIDE_STAGES = {"plan", "design"}

# 每次运行/每个用户自己的 Key，放在线程上下文里，避免全局串号
_USER_API_KEY: ContextVar[str | None] = ContextVar("nexus_user_api_key", default=None)


def set_user_api_key(key: str | None) -> None:
    _USER_API_KEY.set((key or "").strip() or None)


def resolve_model(stage: str) -> str:
    settings = get_settings()
    return settings.model_decide if stage in _DECIDE_STAGES else settings.model_execute


def build_client(stage: str = "plan") -> RecordedModelClient:
    settings = get_settings()
    inner = None
    if settings.record_mode != "replay":
        inner = ModelClient(
            api_key=_USER_API_KEY.get() or settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
        )
    cassette_dir = Path(__file__).resolve().parents[3] / "data" / "cassettes"
    return RecordedModelClient(inner, settings.record_mode, cassette_dir)


def model_for(stage: str) -> str:
    return resolve_model(stage)