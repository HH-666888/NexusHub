# -*- coding: utf-8 -*-
"""生成技术文档用的两张示意图。"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).parent
BASE.mkdir(exist_ok=True)
FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
CONSOLA = "C:/Windows/Fonts/consola.ttf"
BLUE = (37, 99, 235)
INK = (15, 23, 42)
MUTED = (100, 116, 139)
LINE = (203, 213, 225)
SURFACE = (248, 250, 252)
WHITE = (255, 255, 255)
GREEN = (5, 150, 105)


def font(size: int, bold: bool = False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def rounded(draw, box, fill, outline, radius=16, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def center_text(draw, box, text, size=22, color=INK, bold=False):
    f = font(size, bold)
    x0, y0, x1, y1 = box
    bbox = draw.multiline_textbbox((0, 0), text, font=f, spacing=6, align="center")
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.multiline_text(
        ((x0 + x1 - w) / 2, (y0 + y1 - h) / 2),
        text,
        font=f,
        fill=color,
        spacing=6,
        align="center",
    )


def arrow(draw, start, end, color=BLUE, width=3):
    draw.line([start, end], fill=color, width=width)
    ex, ey = end
    sx, sy = start
    if abs(ex - sx) >= abs(ey - sy):
        direction = 1 if ex > sx else -1
        points = [(ex, ey), (ex - 12 * direction, ey - 7), (ex - 12 * direction, ey + 7)]
    else:
        direction = 1 if ey > sy else -1
        points = [(ex, ey), (ex - 7, ey - 12 * direction), (ex + 7, ey - 12 * direction)]
    draw.polygon(points, fill=color)


def architecture():
    img = Image.new("RGB", (1800, 1080), WHITE)
    d = ImageDraw.Draw(img)
    d.text((60, 42), "NexusHub 总体架构", font=font(34, True), fill=INK)
    d.text((60, 92), "浏览器负责呈现与交互，FastAPI 负责编排、模型调用、运行与持久化", font=font(18), fill=MUTED)

    # Browser layer
    rounded(d, (60, 140, 1740, 330), SURFACE, LINE, 20)
    d.text((88, 160), "浏览器 · Vue 3 + Vite + TypeScript", font=font(21, True), fill=BLUE)
    boxes = [
        (88, 205, 440, 300, "9 个页面\n登录 / 项目 / 设置 / 记忆 / 辅助 / 工作台"),
        (468, 205, 820, 300, "主工作台\n任务树 · 代码流 · 门禁 · 预览"),
        (848, 205, 1200, 300, "辅助工作台\nCodeMirror · 检查 · 教练"),
        (1228, 205, 1712, 300, "浏览器状态\nSSE 渲染 · 草稿/视图恢复 · 主题"),
    ]
    for x0, y0, x1, y1, text in boxes:
        rounded(d, (x0, y0, x1, y1), WHITE, LINE, 14, 1)
        center_text(d, (x0, y0, x1, y1), text, 17, INK)

    arrow(d, (900, 330), (900, 390))

    # API layer
    rounded(d, (60, 390, 1740, 560), WHITE, BLUE, 20, 3)
    d.text((88, 408), "FastAPI · 同源 API + SSE", font=font(21, True), fill=BLUE)
    api_items = [
        (88, 452, 330, 530, "认证 / 项目"),
        (350, 452, 592, 530, "运行 / 门禁"),
        (612, 452, 854, 530, "记忆 / 设置"),
        (874, 452, 1116, 530, "辅助 / 技能"),
        (1136, 452, 1378, 530, "RAG 检索"),
        (1398, 452, 1712, 530, "事件流 / 预览"),
    ]
    for x0, y0, x1, y1, text in api_items:
        rounded(d, (x0, y0, x1, y1), SURFACE, LINE, 12, 1)
        center_text(d, (x0, y0, x1, y1), text, 16, INK)

    arrow(d, (900, 560), (900, 620))

    # Pipeline + AI
    rounded(d, (60, 620, 1110, 780), WHITE, GREEN, 20, 3)
    d.text((88, 638), "编排引擎 · 六道工序 + 回环", font=font(21, True), fill=GREEN)
    stages = [
        (88, 686, 240, 754, "01 需求"),
        (252, 686, 404, 754, "02 架构"),
        (416, 686, 568, 754, "03 开发"),
        (580, 686, 732, 754, "04 装配"),
        (744, 686, 896, 754, "05 测试"),
        (908, 686, 1060, 754, "06 交付"),
    ]
    for x0, y0, x1, y1, text in stages:
        rounded(d, (x0, y0, x1, y1), (236, 253, 245), (167, 243, 208), 10, 1)
        center_text(d, (x0, y0, x1, y1), text, 15, (6, 78, 59))

    rounded(d, (1140, 620, 1740, 780), WHITE, (124, 58, 237), 20, 3)
    d.text((1168, 638), "AI 能力层", font=font(21, True), fill=(109, 40, 217))
    ai_items = [
        (1168, 686, 1350, 754, "DeepSeek 客户端"),
        (1362, 686, 1544, 754, "结构化输出"),
        (1556, 686, 1712, 754, "RAG / 成本"),
    ]
    for x0, y0, x1, y1, text in ai_items:
        rounded(d, (x0, y0, x1, y1), (245, 243, 255), (221, 214, 254), 10, 1)
        center_text(d, (x0, y0, x1, y1), text, 15, (76, 29, 149))

    # bottom data
    arrow(d, (420, 780), (420, 835))
    arrow(d, (900, 780), (900, 835))
    arrow(d, (1440, 780), (1440, 835))
    data = [
        (60, 835, 640, 1015, "MySQL 8\n运行 / 事件 / 任务 / 产物 / 记忆"),
        (660, 835, 1240, 1015, "本机进程运行时\n产物目录 · 动态端口 · 健康检查"),
        (1260, 835, 1740, 1015, "data/cassettes\n模型调用录制回放"),
    ]
    for x0, y0, x1, y1, text in data:
        rounded(d, (x0, y0, x1, y1), SURFACE, LINE, 16, 1)
        center_text(d, (x0, y0, x1, y1), text, 17, MUTED)

    img.save(BASE / "architecture.png")


def pipeline():
    img = Image.new("RGB", (1800, 620), WHITE)
    d = ImageDraw.Draw(img)
    d.text((60, 34), "六道工序与测试回环", font=font(32, True), fill=INK)
    d.text((60, 82), "流程层是确定性状态机；每道工序内部由模型规划、生成、校验", font=font(17), fill=MUTED)

    stages = [
        ("01", "需求分析", "SpecV2\n验收标准"),
        ("02", "架构设计", "ArchV2\n模块 / 文件"),
        ("03", "自主开发", "逐文件生成\n语法 / SQL 校验"),
        ("04", "集成装配", "入口 / 依赖\n可启动工程"),
        ("05", "自动测试", "真起进程\nHTTP / 页面用例"),
        ("06", "验收交付", "结果汇总\n预览地址"),
    ]
    start_x, y, w, h, gap = 60, 170, 250, 190, 32
    boxes = []
    for i, (no, name, desc) in enumerate(stages):
        x = start_x + i * (w + gap)
        rounded(d, (x, y, x + w, y + h), WHITE, BLUE if i < 5 else GREEN, 16, 2)
        d.text((x + 18, y + 16), no, font=font(20, True), fill=BLUE if i < 5 else GREEN)
        d.text((x + 18, y + 50), name, font=font(22, True), fill=INK)
        d.text((x + 18, y + 96), desc, font=font(16), fill=MUTED, spacing=8)
        boxes.append((x, y, x + w, y + h))

    for i in range(5):
        arrow(d, (boxes[i][2] + 4, y + h // 2), (boxes[i + 1][0] - 4, y + h // 2))
    # feedback edge from test to build
    sx = boxes[4][0] + w // 2
    tx = boxes[2][0] + w // 2
    d.line([(sx, y + h), (sx, y + h + 80), (tx, y + h + 80), (tx, y + h + 4)], fill=(220, 38, 38), width=3)
    d.polygon([(tx, y + h + 4), (tx - 7, y + h + 18), (tx + 7, y + h + 18)], fill=(220, 38, 38))
    d.text((tx + 12, y + h + 94), "失败带错误回环，最多 2 轮", font=font(17, True), fill=(185, 28, 28))
    d.text((60, 540), "测试失败 → 读真实错误 → 回到开发修复 → 重新测试；超过上限则明确失败，不无限烧钱", font=font(16), fill=MUTED)
    img.save(BASE / "pipeline.png")


if __name__ == "__main__":
    architecture()
    pipeline()
    print("assets written")