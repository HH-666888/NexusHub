"""辅助开发：项目、文件、检查、阶段辅助。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AssistFile, AssistFinding, AssistProject
from app.deps import get_current_user, get_db
from app.domain.user import User
from app.shared.time import now_ms
from app.v2.assist import analyzer, coach, memory_service

router = APIRouter()

PREFIX = "a-"
STAGES = ["plan", "design", "build", "assemble", "test", "deliver"]
STAGE_LABELS = {
    "plan": "需求分析",
    "design": "架构设计",
    "build": "并行开发",
    "assemble": "集成装配",
    "test": "自动测试",
    "deliver": "验收交付",
}


def _owned(db: Session, project_id: str, user: User) -> AssistProject:
    project = db.get(AssistProject, project_id)
    if project is None or project.user_id != user.id:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _project_out(db: Session, project: AssistProject) -> dict:
    files = db.execute(
        select(AssistFile).where(AssistFile.project_id == project.id).order_by(AssistFile.path)
    ).scalars().all()
    open_findings = db.execute(
        select(AssistFinding).where(AssistFinding.project_id == project.id, AssistFinding.status == "open")
    ).scalars().all()
    return {
        "id": project.id,
        "title": project.title,
        "goal": project.goal or "",
        "stage": project.stage,
        "stageLabel": STAGE_LABELS.get(project.stage, project.stage),
        "status": project.status,
        "mode": project.mode,
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
        "files": [
            {"path": item.path, "lang": item.lang, "bytes": len(item.content.encode("utf-8"))}
            for item in files
        ],
        "findings": {
            "open": len(open_findings),
            "error": sum(1 for item in open_findings if item.severity == "error"),
            "warn": sum(1 for item in open_findings if item.severity == "warn"),
        },
        "stages": [
            {"id": stage, "label": STAGE_LABELS[stage], "state": _stage_state(project.stage, stage)}
            for stage in STAGES
        ],
    }


def _stage_state(current: str, stage: str) -> str:
    if STAGES.index(stage) < STAGES.index(current):
        return "done"
    if stage == current:
        return "active"
    return "wait"


@router.get("/projects")
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(AssistProject)
        .where(AssistProject.user_id == user.id)
        .order_by(AssistProject.updated_at.desc())
        .limit(50)
    ).scalars().all()
    return {"projects": [_project_out(db, project) for project in rows]}


@router.post("/projects", status_code=201)
def create_project(
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    goal = str(payload.get("goal") or "").strip()
    title = str(payload.get("title") or "").strip()
    if not goal and not title:
        raise HTTPException(status_code=400, detail="请先写一句要做什么")
    if not title:
        title = goal[:24]
    stamp = now_ms()
    project = AssistProject(
        id=PREFIX + uuid.uuid4().hex[:20],
        user_id=user.id,
        title=title,
        goal=goal,
        stage="plan",
        status="active",
        mode="suggest",
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(project)
    db.commit()
    return _project_out(db, project)


@router.get("/projects/{project_id}")
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return _project_out(db, _owned(db, project_id, user))


@router.patch("/projects/{project_id}")
def update_project(
    project_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _owned(db, project_id, user)
    for field in ("title", "goal", "mode"):
        if field in payload:
            setattr(project, field, str(payload[field])[:120])
    if "stage" in payload:
        stage = str(payload["stage"])
        if stage not in STAGES:
            raise HTTPException(status_code=400, detail="unknown stage")
        old_stage = project.stage
        project.stage = stage
        if STAGES.index(stage) > STAGES.index(old_stage):
            memory_service.record_from_stage(db, project, stage)
    project.updated_at = now_ms()
    db.commit()
    return _project_out(db, project)


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _owned(db, project_id, user)
    db.execute(delete(AssistFinding).where(AssistFinding.project_id == project.id))
    db.execute(delete(AssistFile).where(AssistFile.project_id == project.id))
    db.execute(delete(AssistProject).where(AssistProject.id == project.id))
    db.commit()
    return {"ok": True}


@router.post("/projects/{project_id}/files")
def save_file(
    project_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, project_id, user)
    path = str(payload.get("path") or "").strip().replace("\\", "/")
    if not path or ".." in path:
        raise HTTPException(status_code=400, detail="非法路径")
    content = str(payload.get("content") or "")
    if len(content.encode("utf-8")) > 512 * 1024:
        raise HTTPException(status_code=413, detail="文件太大")

    existing = db.execute(
        select(AssistFile).where(AssistFile.project_id == project_id, AssistFile.path == path)
    ).scalar_one_or_none()
    lang = analyzer.lang_of(path)
    if existing is None:
        db.add(
            AssistFile(
                project_id=project_id,
                path=path,
                lang=lang,
                content=content,
                updated_at=now_ms(),
            )
        )
    else:
        existing.content = content
        existing.lang = lang
        existing.updated_at = now_ms()
    project = db.get(AssistProject, project_id)
    project.updated_at = now_ms()
    db.commit()
    return {"ok": True, "path": path, "lang": lang, "bytes": len(content.encode("utf-8"))}


@router.get("/projects/{project_id}/file")
def read_file(
    project_id: str,
    path: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, project_id, user)
    row = db.execute(
        select(AssistFile).where(AssistFile.project_id == project_id, AssistFile.path == path)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="file not found")
    return {"path": row.path, "lang": row.lang, "content": row.content}


@router.delete("/projects/{project_id}/file")
def delete_file(
    project_id: str,
    path: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, project_id, user)
    db.execute(delete(AssistFile).where(AssistFile.project_id == project_id, AssistFile.path == path))
    db.commit()
    return {"ok": True}


@router.post("/projects/{project_id}/analyze")
def analyze_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, project_id, user)
    files = db.execute(select(AssistFile).where(AssistFile.project_id == project_id)).scalars().all()
    if not files:
        raise HTTPException(status_code=400, detail="还没有文件可检查")

    db.execute(delete(AssistFinding).where(AssistFinding.project_id == project_id))
    stamp = now_ms()
    total = 0
    for item in files:
        for finding in analyzer.analyze(item.path, item.content):
            db.add(
                AssistFinding(
                    project_id=project_id,
                    file_path=finding["file_path"],
                    line=finding["line"],
                    severity=finding["severity"],
                    rule=finding["rule"],
                    message=finding["message"],
                    stage=finding["stage"],
                    status="open",
                    created_at=stamp,
                )
            )
            total += 1
    db.commit()
    return {"ok": True, "count": total}


@router.get("/projects/{project_id}/findings")
def list_findings(
    project_id: str,
    status: str = "open",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    _owned(db, project_id, user)
    query = select(AssistFinding).where(AssistFinding.project_id == project_id)
    if status != "all":
        query = query.where(AssistFinding.status == status)
    rows = db.execute(query.order_by(AssistFinding.file_path, AssistFinding.line).limit(300)).scalars().all()
    return {
        "findings": [
            {
                "id": row.id,
                "path": row.file_path,
                "line": row.line,
                "severity": row.severity,
                "rule": row.rule,
                "message": row.message,
                "stage": row.stage,
                "stageLabel": STAGE_LABELS.get(row.stage, row.stage),
                "status": row.status,
            }
            for row in rows
        ]
    }


@router.patch("/findings/{finding_id}")
def update_finding(
    finding_id: int,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    row = db.get(AssistFinding, finding_id)
    if row is None:
        raise HTTPException(status_code=404, detail="finding not found")
    project = db.get(AssistProject, row.project_id)
    if project is None or project.user_id != user.id:
        raise HTTPException(status_code=404, detail="finding not found")
    status = str(payload.get("status") or "open")
    if status not in {"open", "fixed", "ignored"}:
        raise HTTPException(status_code=400, detail="unknown status")
    row.status = status
    db.commit()
    return {"ok": True}


@router.post("/projects/{project_id}/apply")
def apply_edit(
    project_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _owned(db, project_id, user)
    path = str(payload.get("path") or "").strip()
    instruction = str(payload.get("instruction") or "").strip()
    if not path or not instruction:
        raise HTTPException(status_code=400, detail="需要文件名与修改要求")

    row = db.execute(
        select(AssistFile).where(AssistFile.project_id == project_id, AssistFile.path == path)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="文件不存在")

    previous = row.content
    content, note = coach.apply_edit(db, user=user, project=project, path=path, content=previous, instruction=instruction)
    if content is None:
        raise HTTPException(status_code=502, detail=note or "AI 没有给出可用的修改")

    if path.endswith(".py"):
        try:
            compile(content, path, "exec")
        except SyntaxError as error:
            raise HTTPException(status_code=422, detail=f"改完语法不通过：{error}")

    row.content = content
    row.updated_at = now_ms()
    project.updated_at = now_ms()
    db.commit()
    return {"ok": True, "path": path, "content": content, "previous": previous, "note": note}


@router.post("/projects/{project_id}/stage/ai")
def stage_ai(
    project_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _owned(db, project_id, user)
    message = str(payload.get("message") or "").strip()
    reply, citations = coach.assist(
        db,
        user=user,
        project=project,
        message=message,
        stage=str(payload.get("stage") or project.stage),
    )
    return {"reply": reply, "citations": citations}