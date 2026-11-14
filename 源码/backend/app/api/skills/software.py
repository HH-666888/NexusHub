"""软件开发全流程 Skill：读取入口与工序参考，生成短提示词块。"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from app.config import get_settings

# 每道工序只加载真正的入口文件，避免把 30KB 的 SKILL.md 全塞进每次调用。
STAGE_FILES: dict[str, list[str]] = {
    "plan": [
        "references/01-需求分析/需求分析.md",
        "references/01-需求分析/需求规格模板.md",
    ],
    "design": [
        "references/02-架构设计/形态判定.md",
        "references/02-架构设计/选型对照.md",
    ],
    "build": [
        "references/03-三方向开发/接口设计.md",
        "references/03-三方向开发/数据建模.md",
        "references/03-三方向开发/后端-FastAPI.md",
        "references/03-三方向开发/前端-原生HTML.md",
    ],
    "assemble": ["references/04-集成装配/装配联调.md"],
    "test": [
        "references/05-自动化测试/验证门.md",
        "references/05-自动化测试/接口示例测试.md",
    ],
    "deliver": ["references/06-验收交付/交付清单.md"],
}

RED_LINES = [
    "未实现或未验证的东西，不得说成已完成。",
    "不得用 mock、假数据或跳过接口制造“通过”。",
    "不得提交真实密钥、token 或 .env。",
    "不得删测试、改预期来让验证变绿。",
    "基线跑不起来时，不得继续叠加改动。",
]


def skill_root() -> Path:
    base = Path(__file__).resolve().parents[3]
    return (base / get_settings().skill_dir).resolve()


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta: dict[str, str] = {}
    for line in parts[1].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            meta[key.strip()] = value.strip()
    return meta, parts[2].lstrip("\n")


def _read(relative: str, limit: int = 1200) -> str:
    path = skill_root() / relative
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"(?m)^---.*?^---\\s*", "", text, count=1, flags=re.S)
    text = re.sub(r"\\n{3,}", "\\n\\n", text).strip()
    return text[:limit]


@lru_cache(maxsize=1)
def info() -> dict:
    path = skill_root() / "SKILL.md"
    if not path.is_file():
        return {"name": "", "version": "", "description": "", "stages": [], "missing": True}
    text = path.read_text(encoding="utf-8")
    meta, body = _frontmatter(text)
    version = ""
    match = re.search(r"\\|\\s*版本\\s*\\|\\s*([^|\\n]+)", text)
    if match:
        version = match.group(1).strip()
    description = meta.get("description", "")
    return {
        "name": meta.get("name", "软件开发全流程生成"),
        "version": version or "1.6",
        "description": description,
        "stages": list(STAGE_FILES),
        "root": str(skill_root()),
        "missing": False,
    }


@lru_cache(maxsize=8)
def block(stage: str) -> str:
    data = info()
    if data.get("missing"):
        return ""
    files = STAGE_FILES.get(stage, [])
    excerpts: list[str] = []
    budget = 2200
    for relative in files:
        text = _read(relative, limit=min(1100, budget))
        if not text:
            continue
        excerpts.append("### " + relative + "\\n" + text)
        budget -= len(text)
        if budget <= 300:
            break
    if not excerpts:
        return ""
    red = "\\n".join("- " + line for line in RED_LINES)
    return (
        f"【内置 Skill：{data['name']} v{data['version']}】\\n"
        f"{data['description'][:320]}\\n"
        f"硬性红线：\\n{red}\\n"
        f"当前工序必须遵循的参考：\\n" + "\\n\\n".join(excerpts)
    )


def list_skills() -> list[dict]:
    data = info()
    return [
        {
            "name": data.get("name", ""),
            "version": data.get("version", ""),
            "description": data.get("description", ""),
            "stages": data.get("stages", []),
            "files": STAGE_FILES,
        }
    ]