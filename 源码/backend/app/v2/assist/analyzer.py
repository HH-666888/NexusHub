"""辅助开发：多语言静态检查。

只做“看得懂”的检查：语法、结构、常见坏味道。
不执行代码，不做类型解析，规则尽量确定、少误报。
"""

from __future__ import annotations

import ast
import re
from html.parser import HTMLParser

SEVERITY_ORDER = {"error": 0, "warn": 1, "info": 2}


def lang_of(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".py"):
        return "python"
    if lower.endswith((".java",)):
        return "java"
    if lower.endswith((".js", ".mjs")):
        return "javascript"
    if lower.endswith((".html", ".htm")):
        return "html"
    if lower.endswith(".css"):
        return "css"
    if lower.endswith(".sql"):
        return "sql"
    return "text"


def _finding(path: str, line: int, severity: str, rule: str, message: str, stage: str) -> dict:
    return {
        "file_path": path,
        "line": int(line or 0),
        "severity": severity,
        "rule": rule,
        "message": message[:500],
        "stage": stage,
    }


def analyze(path: str, content: str) -> list[dict]:
    lang = lang_of(path)
    handlers = {
        "python": _python,
        "java": _java,
        "javascript": _javascript,
        "html": _html,
        "css": _css,
        "sql": _sql,
    }
    handler = handlers.get(lang)
    if handler is None:
        return []
    try:
        return handler(path, content)
    except Exception:  # noqa: BLE001
        # 解析器自身出错时不阻塞，交给界面标“仅基础检查”
        return [_finding(path, 0, "info", "parser-error", "该文件解析失败，仅展示内容", "build")]


# ───────── Python ─────────

_SECRET = re.compile(
    r"(?:api[_-]?key|secret|password|token|key)\s*=\s*['\"][^'\"]{8,}['\"]",
    re.IGNORECASE,
)


def _python(path: str, content: str) -> list[dict]:
    findings: list[dict] = []
    try:
        tree = ast.parse(content)
    except SyntaxError as error:
        return [_finding(path, error.lineno or 0, "error", "py-syntax", f"语法错误：{error.msg}", "build")]

    imported: dict[str, int] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported[alias.asname or alias.name.split(".")[0]] = node.lineno
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    imported[alias.asname or alias.name] = node.lineno

    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used.add(node.id)
        elif isinstance(node, ast.Attribute):
            current = node
            while isinstance(current, ast.Attribute):
                current = current.value
            if isinstance(current, ast.Name):
                used.add(current.id)

    for name, line in imported.items():
        if name not in used:
            findings.append(_finding(path, line, "warn", "py-unused-import", f"导入了 {name} 但没用到", "build"))

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            length = (node.end_lineno or node.lineno) - node.lineno + 1
            if length > 40:
                findings.append(
                    _finding(path, node.lineno, "warn", "py-long-function", f"函数 {node.name} 有 {length} 行，建议拆分", "build")
                )
        elif isinstance(node, ast.ExceptHandler) and node.type is None:
            findings.append(_finding(path, node.lineno, "warn", "py-bare-except", "用了裸 except，会吞掉所有异常", "build"))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec"}:
            findings.append(_finding(path, node.lineno, "error", "py-dangerous-call", f"使用了 {node.func.id}()", "build"))

    for index, line in enumerate(content.splitlines(), start=1):
        if re.match(r"^\s*#\s*TODO\b", line):
            findings.append(_finding(path, index, "info", "py-todo", "还留着 TODO 注释", "test"))
        if _SECRET.search(line):
            findings.append(_finding(path, index, "error", "py-hardcoded-secret", "疑似把密钥/口令写死在代码里", "build"))
    return findings


# ───────── Java ─────────


def _java(path: str, content: str) -> list[dict]:
    findings: list[dict] = []
    try:
        import javalang

        javalang.parse.parse(content)
    except ImportError:
        findings.append(_finding(path, 0, "info", "java-no-parser", "没装 Java 解析器，仅做基础检查", "build"))
    except Exception as error:  # noqa: BLE001
        line = getattr(getattr(error, "at", None), "position", None)
        findings.append(_finding(path, getattr(line, "line", 0) or 0, "error", "java-syntax", f"语法解析失败：{error}", "build"))

    for index, line in enumerate(content.splitlines(), start=1):
        if re.search(r"catch\s*\([^)]*\)\s*\{\s*\}", line):
            findings.append(_finding(path, index, "warn", "java-empty-catch", "空 catch 会静默吞掉异常", "build"))
        if re.match(r"^\s*//\s*TODO\b", line):
            findings.append(_finding(path, index, "info", "java-todo", "还留着 TODO 注释", "test"))
        if _SECRET.search(line):
            findings.append(_finding(path, index, "error", "java-hardcoded-secret", "疑似把密钥/口令写死在代码里", "build"))
    return findings


# ───────── JavaScript ─────────


def _javascript(path: str, content: str) -> list[dict]:
    findings: list[dict] = []
    try:
        import esprima

        esprima.parseScript(content)
    except ImportError:
        findings.append(_finding(path, 0, "info", "js-no-parser", "没装 JS 解析器，仅做基础检查", "build"))
    except Exception as error:  # noqa: BLE001
        line = getattr(error, "lineNumber", 0) or 0
        findings.append(_finding(path, line, "error", "js-syntax", f"语法解析失败：{error}", "build"))

    for index, line in enumerate(content.splitlines(), start=1):
        if re.match(r"^\s*//\s*TODO\b", line):
            findings.append(_finding(path, index, "info", "js-todo", "还留着 TODO 注释", "test"))
        if re.search(r"\beval\s*\(", line):
            findings.append(_finding(path, index, "error", "js-eval", "使用了 eval()", "build"))
        if re.search(r"\bvar\s+\w+", line):
            findings.append(_finding(path, index, "info", "js-var", "建议用 let/const 代替 var", "build"))
        if _SECRET.search(line):
            findings.append(_finding(path, index, "error", "js-hardcoded-secret", "疑似把密钥/口令写死在代码里", "build"))
    return findings


# ───────── HTML ─────────

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class _HtmlChecker(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.findings: list[dict] = []
        self.path = ""

    def handle_starttag(self, tag: str, attrs) -> None:
        attrs = dict(attrs)
        if tag == "img" and "alt" not in attrs:
            self.findings.append(_finding(self.path, self.getpos()[0], "info", "html-img-alt", "img 缺少 alt", "build"))
        if tag == "script" and str(attrs.get("src", "")).startswith("http"):
            self.findings.append(_finding(self.path, self.getpos()[0], "warn", "html-external-script", "引用了外部脚本，离线会失效", "assemble"))
        if tag not in _VOID:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID:
            return
        if not self.stack:
            self.findings.append(_finding(self.path, self.getpos()[0], "warn", "html-stray-close", f"多余的 </{tag}>", "build"))
            return
        open_tag, line = self.stack.pop()
        if open_tag != tag:
            self.findings.append(
                _finding(self.path, line, "warn", "html-mismatch", f"<{open_tag}> 与 </{tag}> 不匹配", "build")
            )


def _html(path: str, content: str) -> list[dict]:
    checker = _HtmlChecker()
    checker.path = path
    checker.feed(content)
    for tag, line in checker.stack:
        checker.findings.append(_finding(path, line, "warn", "html-unclosed", f"<{tag}> 没有闭合", "build"))
    return checker.findings


# ───────── CSS ─────────


def _css(path: str, content: str) -> list[dict]:
    findings: list[dict] = []
    try:
        import tinycss2

        rules = tinycss2.parse_stylesheet(content, skip_comments=True, skip_whitespace=True)
    except ImportError:
        return [_finding(path, 0, "info", "css-no-parser", "没装 CSS 解析器，仅做基础检查", "build")]

    seen: dict[str, int] = {}
    for rule in rules:
        if rule.type == "error":
            findings.append(
                _finding(path, getattr(rule.source_line, "line", 0) if hasattr(rule, "source_line") else 0, "error", "css-syntax", "CSS 语法错误", "build")
            )
            continue
        if rule.type != "qualified-rule":
            continue
        selector = tinycss2.serialize(rule.prelude).strip()
        if selector in seen:
            findings.append(_finding(path, 0, "info", "css-duplicate", f"选择器 {selector} 重复定义", "build"))
        seen[selector] = 1

    important = content.count("!important")
    if important > 3:
        findings.append(_finding(path, 0, "info", "css-important", f"用了 {important} 次 !important", "build"))
    return findings


# ───────── SQL ─────────


def _sql(path: str, content: str) -> list[dict]:
    findings: list[dict] = []
    try:
        import sqlparse
    except ImportError:
        return [_finding(path, 0, "info", "sql-no-parser", "没装 SQL 解析器，仅做基础检查", "assemble")]

    for statement in sqlparse.parse(content):
        text = str(statement).strip()
        if not text:
            continue
        upper = text.upper()
        if upper.startswith(("UPDATE", "DELETE")) and " WHERE " not in f" {upper} ":
            findings.append(_finding(path, 0, "error", "sql-no-where", "UPDATE/DELETE 没有 WHERE，会改全表", "assemble"))
        if re.search(r"\bSELECT\s+\*", upper):
            findings.append(_finding(path, 0, "info", "sql-select-star", "SELECT * 建议改成具体字段", "assemble"))
    return findings