"""把后端的 OpenAPI 描述导出成文件，供前端生成类型。

前端不允许手写与后端重复的 interface（契约 R3），所以每次接口变了都要重新导出：

    cd backend && python -m tools.export_openapi openapi.json
    cd frontend && npm run gen:types

这是一个开发期的工具，不参与运行时。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.main import create_app

DEFAULT_OUTPUT = Path("openapi.json")


def export(output: Path) -> Path:
    """写出的 JSON 固定为「按 key 排序 + 2 空格缩进」，这样 git diff 才有意义。"""
    spec = create_app().openapi()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return output


def main(argv: list[str]) -> int:
    output = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUTPUT
    written = export(output)
    sys.stdout.write(f"已写出 {written}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
