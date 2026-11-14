"""Agent 循环：模型自己选工具、看结果、再决定下一步。"""

from __future__ import annotations

import json
import time

from sqlalchemy.orm import Session

from app.api.agent.tools import TOOLS, execute, parse_arguments, trace_item
from app.api.ai.cost.ledger import record_usage
from app.api.ai.factory import build_client, model_for, set_user_api_key
from app.api.assist import memory_service
from app.api.skills.software import block as skill_block
from app.db.models import AssistProject, Setting
from app.domain.user import User


SYSTEM = """你是 NexusHub 的项目分析 Agent。

你可以调用工具查看项目文件、检查语法、检索开发规范。规则：
1. 需要事实时必须调用工具，不要凭空猜测文件内容。
2. 每次只调用真正需要的工具；拿到结果后判断是否足够。
3. 不要修改文件，不要声称已经修改。
4. 最终回答先给结论，再给最多 5 条依据或下一步。
5. 如果工具结果不足以回答，直接说明缺什么。
"""


def run_agent(
    db: Session,
    *,
    user: User,
    project: AssistProject,
    message: str,
    stage: str,
    max_steps: int = 6,
) -> dict:
    key_row = db.get(Setting, {"user_id": user.id, "key": "apiKey"})
    if key_row is not None and isinstance(key_row.value, str):
        set_user_api_key(key_row.value)
    memory_text, citations = memory_service.prompt_block(db, user.id)

    system = (
        SYSTEM
        + "\n\n" + skill_block(stage)
        + (f"\n\n{memory_text}" if memory_text else "")
    )
    user_text = (
        f"项目：{project.title}\n"
        f"目标：{project.goal or '（未填写）'}\n"
        f"当前阶段：{stage}\n"
        f"用户问题：{message or '请先看项目，给出当前最该做的下一步。'}"
    )
    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_text},
    ]

    client = build_client("plan")
    model = model_for("plan")
    trace: list[dict] = []
    total_cost = 0.0
    final = ""
    try:
        for _ in range(max_steps):
            reply = client.complete(
                messages,
                model,
                max_tokens=1200,
                temperature=0.2,
                tools=TOOLS,
                tool_choice="auto",
            )
            total_cost += record_usage(
                db, user_id=user.id, project_id=project.id, kind="agent", reply=reply
            )
            calls = reply.tool_calls or []
            if not calls:
                final = (reply.content or "").strip()
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": reply.content or "",
                    "tool_calls": calls,
                }
            )
            for call in calls:
                function = call.get("function") or {}
                name = str(function.get("name") or "")
                arguments = parse_arguments(str(function.get("arguments") or "{}"))
                began = time.monotonic()
                try:
                    result, meta = execute(name, arguments, db=db, project=project)
                except Exception as error:  # noqa: BLE001
                    result, meta = f"工具执行失败：{error}", {}
                ms = int((time.monotonic() - began) * 1000)
                trace.append(trace_item(name, {**arguments, **meta}, result, ms))
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or name,
                        "name": name,
                        "content": result[:3000],
                    }
                )
        else:
            messages.append(
                {"role": "user", "content": "工具调用次数已到上限，请基于已有结果直接回答。"}
            )
            reply = client.complete(messages, model, max_tokens=800, temperature=0.2)
            total_cost += record_usage(
                db, user_id=user.id, project_id=project.id, kind="agent", reply=reply
            )
            final = (reply.content or "").strip()
    finally:
        client.close()

    if not final:
        final = "Agent 没有给出最终回答，可以换一种问法再试。"
    return {
        "reply": final,
        "tools": trace,
        "citations": citations,
        "costCny": round(total_cost, 6),
        "model": model,
    }