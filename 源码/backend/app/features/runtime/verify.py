"""三层验证：数据库、接口、界面（契约 §5.9）。

为什么要三层：一层过了不代表能用。表建了但接口 500、接口通了但页面调错路径，
都会让"做完了"变成假的。三层各自给出可读的检查项，失败能定位到方向。

不依赖 docker：这里只对已经跑起来的 URL 与数据库发请求，
所以本机没装容器也能测（测试里用真实的 HTTP server + sqlite）。
"""

import json
from http.client import HTTPConnection
from urllib.parse import urlparse

from sqlalchemy import create_engine, inspect, text

from app.features.runtime.schemas import LayerResult, Verdict
from app.features.runtime.schemas import StageCheckItem as Check

# 单次请求的耐心：产物服务就在本机，超过 5 秒基本是死了
HTTP_TIMEOUT_SECONDS = 5


def _layer(name: str, items: list[Check]) -> LayerResult:
    return LayerResult(
        layer=name,  # type: ignore[arg-type]
        checks=items,
        passed=sum(1 for item in items if item.pass_),
        total=len(items),
    )


def _http_get(url: str) -> tuple[int, str, str]:
    """(状态码, 正文, content-type)。连不上时返回 (0, "", "")，由调用方记成失败。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return 0, "", ""
    connection = HTTPConnection(parsed.hostname, parsed.port or 80, timeout=HTTP_TIMEOUT_SECONDS)
    try:
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read().decode("utf-8", errors="replace")
        return response.status, body, response.getheader("content-type") or ""
    except OSError:
        return 0, "", ""
    finally:
        connection.close()


def verify_database(db_url: str) -> LayerResult:
    """表建出来了吗、有数据吗。"""
    items: list[Check] = []
    engine = create_engine(db_url)
    try:
        names = inspect(engine).get_table_names()
    except Exception as exc:  # noqa: BLE001 —— 连不上就是失败项，不是异常
        return _layer("db", [Check(name="连上数据库", pass_=False, detail=str(exc)[:200])])
    finally:
        engine.dispose()

    items.append(
        Check(
            name="表已创建",
            pass_=len(names) > 0,
            detail=f"{len(names)} 张表：{'、'.join(names) or '（空）'}",
        )
    )

    non_empty = 0
    for table in names:
        count = _count_rows(db_url, table)
        if count is None:
            items.append(Check(name=f"表 {table} 可查询", pass_=False, detail="查询失败"))
            continue
        if count > 0:
            non_empty += 1
        items.append(Check(name=f"表 {table} 可查询", pass_=True, detail=f"{count} 行"))

    if names:
        items.append(
            Check(
                name="有演示数据",
                pass_=non_empty > 0,
                detail=f"{non_empty} 张表有数据",
            )
        )
    return _layer("db", items)


def _count_rows(db_url: str, table: str) -> int | None:
    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            # 表名来自数据库自己的元数据，不是外部输入
            return int(conn.execute(text(f"SELECT COUNT(*) FROM `{table}`")).scalar_one())
    except Exception:  # noqa: BLE001
        # sqlite 不接受反引号，退一步用裸名
        try:
            with engine.connect() as conn:
                return int(conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one())
        except Exception:  # noqa: BLE001
            return None
    finally:
        engine.dispose()


def verify_api(preview_url: str) -> LayerResult:
    """/health 通不通，以及 OpenAPI 里登记的每个只读端点能不能 200。"""
    items: list[Check] = []
    base = preview_url.rstrip("/")

    status, body, _ = _http_get(f"{base}/health")
    items.append(
        Check(
            name="GET /health",
            pass_=status == 200,
            detail=f"HTTP {status}" if status != 200 else "200",
        )
    )

    status, body, _ = _http_get(f"{base}/openapi.json")
    paths: list[str] = []
    if status == 200:
        try:
            spec = json.loads(body)
            paths = [p for p in spec.get("paths", {}) if "{" not in p]
        except json.JSONDecodeError:
            paths = []
    items.append(
        Check(
            name="有接口清单",
            pass_=len(paths) > 0,
            detail=f"{len(paths)} 个路径" if paths else f"HTTP {status}",
        )
    )

    for path in paths[:8]:  # 最多打 8 个，防产物端点太多把验证拖死
        code, _, _ = _http_get(f"{base}{path}")
        items.append(Check(name=f"GET {path}", pass_=code == 200, detail=f"HTTP {code}"))

    return _layer("api", items)


def verify_ui(preview_url: str) -> LayerResult:
    """页面能打开吗、是不是真的在调自己的接口、有没有引外链。"""
    base = preview_url.rstrip("/")
    status, body, content_type = _http_get(f"{base}/")
    return _layer("ui", check_page(status, content_type, body))


def check_page(status: int, content_type: str, body: str) -> list[Check]:
    """页面的判定规则。抽成纯函数：换一份 HTML 就能测，不用起服务。"""
    items: list[Check] = [
        Check(
            name="页面能打开",
            pass_=status == 200,
            detail=f"HTTP {status}" if status != 200 else "200",
        )
    ]
    items.append(
        Check(
            name="是 HTML",
            pass_="html" in content_type.lower(),
            detail=content_type or "（无 content-type）",
        )
    )
    items.append(
        Check(
            name="调用了自己的接口",
            pass_="/api/" in body,
            detail="找到 /api/ 调用" if "/api/" in body else "页面里没有 /api/ 调用",
        )
    )
    external = "http://" in body.replace("http://127.0.0.1", "") or "https://" in body
    items.append(
        Check(
            name="没有引外部资源",
            pass_=not external,
            detail="没有外链" if not external else "页面里有外链",
        )
    )
    return items


def verify_all(*, preview_url: str, db_url: str) -> Verdict:
    """三层跑完，汇总成一份 Verdict（与落盘的 verdict.json 同一份结构）。"""
    layers = [verify_database(db_url), verify_api(preview_url), verify_ui(preview_url)]
    return Verdict(
        layers=layers,
        passed=sum(layer.passed for layer in layers),
        total=sum(layer.total for layer in layers),
        screenshots=[],
    )
