"""辅助开发的 AI 陪跑：按六阶段给建议，不直接改代码。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AssistFile, AssistFinding, AssistProject
from app.domain.user import User
from app.v2.ai.factory import build_client, model_for
from app.v2.assist import memory_service

STAGE_GUIDE = {
    "plan": "帮用户把需求写清楚：目标、受众、场景、可测的验收标准。指出还缺什么。",
    "design": "帮用户划模块、定文件、定接口。检查每条验收是否有模块负责，指出循环依赖。",
    "build": "用户自己写代码。你只解释、审查、指出问题，不直接改文件。",
    "assemble": "帮用户把模块接起来：入口、静态资源、依赖、启动方式。",
    "test": "帮用户从验收标准生成测试用例，解释失败原因，判断覆盖是否够。",
    "deliver": "帮用户过上线前检查清单，汇总未完成项与风险。",
}


def assist(db: Session, *, user: User, project: AssistProject, message: str, stage: str) -> tuple[str, list[dict]]:
    files = db.execute(select(AssistFile).where(AssistFile.project_id == project.id)).scalars().all()
    findings = db.execute(
        select(AssistFinding)
        .where(AssistFinding.project_id == project.id, AssistFinding.status == "open")
        .limit(12)
    ).scalars().all()

    memory_text, citations = memory_service.prompt_block(db, user.id)

    system = """你是 NexusHub 的辅助开发教练，按软件开发的六道工序陪用户一步一步做。

原则：
1. 用户自己写代码，你只给建议、解释、检查，不声称已经修改文件。
2. 回答要短：先结论，再原因，最多 5 条建议。
3. 结合当前阶段的任务，不要跳到别的阶段。
4. 信息不足时，直接问一个最关键的问题。
5. 不编造文件内容或检查结果。
""" + (f"\n{memory_text}" if memory_text else "")

    context = [
        f"项目：{project.title}",
        f"目标：{project.goal or '（未填写）'}",
        f"当前阶段：{stage}（{STAGE_GUIDE.get(stage, '')}）",
        "文件：" + (", ".join(item.path for item in files) if files else "还没有文件"),
    ]
    if findings:
        context.append("未解决问题：")
        context.extend(f"- [{item.severity}] {item.file_path}:{item.line} {item.message}" for item in findings)
    if message:
        context.append(f"用户的问题：{message}")
    else:
        context.append("用户没有具体问题，请给出当前阶段最该做的下一步。")

    try:
        client = build_client("plan")
        try:
            reply = client.complete(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": "\n".join(context)},
                ],
                model_for("plan"),
                max_tokens=700,
                temperature=0.3,
            )
        finally:
            client.close()
    except Exception as error:  # noqa: BLE001
        return f"AI 暂时不可用：{error}", citations

    return reply.content.strip(), citations