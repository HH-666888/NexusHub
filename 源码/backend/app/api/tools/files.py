"""文件工具：只允许在工作区内读写。"""

from __future__ import annotations

from pathlib import Path


class WorkspaceError(Exception):
    """路径越界或大小超限。"""


MAX_FILE_BYTES = 512 * 1024


def workspace_root(run_id: str) -> Path:
    from app.config import get_settings

    root = Path(get_settings().runtime_workspace_dir).resolve() / run_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe(root: Path, relative: str) -> Path:
    if not relative or relative.startswith(("/", "\\")) or ".." in Path(relative).parts:
        raise WorkspaceError(f"非法路径：{relative}")
    target = (root / relative).resolve()
    if not str(target).startswith(str(root)):
        raise WorkspaceError(f"路径越界：{relative}")
    return target


def write_file(run_id: str, relative: str, content: str) -> Path:
    data = content.encode("utf-8")
    if len(data) > MAX_FILE_BYTES:
        raise WorkspaceError(f"文件过大：{relative}")
    root = workspace_root(run_id)
    target = _safe(root, relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return target


def read_file(run_id: str, relative: str) -> str:
    root = workspace_root(run_id)
    target = _safe(root, relative)
    return target.read_text(encoding="utf-8")


def list_files(run_id: str) -> list[str]:
    root = workspace_root(run_id)
    return sorted(str(path.relative_to(root)).replace("\\", "/") for path in root.rglob("*") if path.is_file())