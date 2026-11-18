"""v2 三场景验收：真实调用、自动回答门禁、收集证据。

用法：
    python scripts/accept.py
输出：
    data/accept-report.json
"""

from __future__ import annotations

import json
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000"
PROMPTS = [
    ("habit", "做一个习惯打卡：能创建习惯、每天打卡、显示连续天数"),
    ("vote", "做一个投票：发起投票、一人一票、看每个选项的百分比"),
    ("ledger", "做一个记账：记一笔、按分类汇总、显示总额"),
]


def login() -> httpx.Client:
    client = httpx.Client(base_url=BASE, timeout=60)
    response = client.post("/api/auth/login", json={"username": "admin", "password": "123456"})
    response.raise_for_status()
    return client


def answer_gates(client: httpx.Client, run_id: str, answered: set[int]) -> None:
    events = client.get(f"/api/runs/{run_id}/events").json()
    for event in events:
        if event["kind"] != "gate" or event["seq"] in answered:
            continue
        questions = event["payload"].get("questions", [])
        answers = [{"id": q["id"], "value": q.get("default", "")} for q in questions]
        client.post(
            f"/api/runs/{run_id}/answers",
            json={"round": event["payload"].get("round", 1), "answers": answers, "auto": False},
        ).raise_for_status()
        answered.add(event["seq"])
        print(f"    gate seq={event['seq']} 问题 {len(questions)} 个 → 已按默认回答")


def one(client: httpx.Client, key: str, prompt: str) -> dict:
    print(f"\n[{key}] {prompt}")
    run = client.post("/api/runs", json={"prompt": prompt}).json()
    run_id = run["id"]
    print(f"    run {run_id}")

    answered: set[int] = set()
    deadline = time.time() + 600
    status = "running"
    while time.time() < deadline:
        detail = client.get(f"/api/runs/{run_id}").json()
        status = detail["status"]
        if status in {"done", "failed", "cancelled"}:
            break
        if status == "paused":
            answer_gates(client, run_id, answered)
        time.sleep(3)

    detail = client.get(f"/api/runs/{run_id}").json()
    events = client.get(f"/api/runs/{run_id}/events").json()
    verdict = None
    for event in events:
        if event["kind"] == "verdict":
            verdict = event["payload"]
    runtime = client.get(f"/api/runs/{run_id}/runtime").json().get("runtime") or {}
    preview_ok = None
    if runtime.get("previewUrl"):
        try:
            preview_ok = httpx.get(runtime["previewUrl"], timeout=5).status_code
        except httpx.HTTPError:
            preview_ok = 0

    errors = [event["payload"].get("message") for event in events if event["kind"] == "error"]
    result = {
        "key": key,
        "prompt": prompt,
        "runId": run_id,
        "status": detail["status"],
        "stage": detail["stage"],
        "costCny": detail["totalCostCny"],
        "events": len(events),
        "tasks": len({e["payload"]["task"]["id"] for e in events if e["kind"] == "task"}),
        "models": sum(1 for e in events if e["kind"] == "usage"),
        "verdict": verdict,
        "previewUrl": runtime.get("previewUrl"),
        "previewStatus": preview_ok,
        "errors": errors,
    }
    print(f"    状态 {result['status']} / 阶段 {result['stage']} / 成本 ¥{result['costCny']}")
    if verdict:
        print(f"    验收 {verdict['passed']}/{verdict['total']}")
    if preview_ok:
        print(f"    预览 {runtime['previewUrl']} → {preview_ok}")
    if errors:
        print(f"    错误：{errors[-1][:200]}")
    return result


def main() -> int:
    client = login()
    rows = [one(client, key, prompt) for key, prompt in PROMPTS]

    out = Path(__file__).resolve().parents[1] / "data" / "v2-accept-report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告：{out}")

    passed = sum(1 for row in rows if row["status"] == "done")
    print(f"完成 {passed}/{len(rows)}")
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())