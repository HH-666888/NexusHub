# -*- coding: utf-8 -*-
"""生成《NexusHub 前端 Vue 全量替换分阶段实施计划》。"""

from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


OUT = r"C:\Users\lenovo\Desktop\传智杯-AI web开发-Nexus\源码\docs\NexusHub-前端Vue全量替换-分阶段实施计划.docx"

NAVY = "1F2937"
TEAL = "0F4C5C"
ACCENT = "0E7490"
MUTED = "6B7280"
LIGHT = "F3F4F6"
LIGHT2 = "F9FAFB"
BLUE_BG = "E0F2FE"
AMBER_BG = "FEF3C7"
AMBER = "92400E"
GREEN_BG = "DCFCE7"
GREEN = "166534"
WHITE = "FFFFFF"
BORDER = "D1D5DB"


def set_run_font(run, size=10.5, bold=False, color="333333", name="Microsoft YaHei"):
    run.font.name = name
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), "微软雅黑")


def style_font(style, size=10.5, bold=False, color="333333", name="Microsoft YaHei"):
    style.font.name = name
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor.from_string(color)
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), "微软雅黑")


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), fill)
    shd.set(qn("w:val"), "clear")
    tc_pr.append(shd)


def cell_margins(cell, top=60, bottom=60, left=90, right=90):
    tc_pr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for tag, value in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        node = OxmlElement(f"w:{tag}")
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tc_pr.append(mar)


def set_table_borders(table, color=BORDER, size=4):
    tbl = table._tbl
    tbl_pr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), str(size))
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)
        borders.append(element)
    tbl_pr.append(borders)


def repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def no_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant = OxmlElement("w:cantSplit")
    cant.set(qn("w:val"), "true")
    tr_pr.append(cant)


def set_col_width(cell, cm):
    cell.width = Cm(cm)
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = tc_pr.find(qn("w:tcW"))
    if tc_w is None:
        tc_w = OxmlElement("w:tcW")
        tc_pr.append(tc_w)
    tc_w.set(qn("w:w"), str(int(cm * 567)))
    tc_w.set(qn("w:type"), "dxa")


def add_table(doc, headers, rows, widths, header_fill=NAVY, font_size=8.8, first_col_bold=False):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    hdr = table.rows[0]
    repeat_header(hdr)
    no_split(hdr)
    for i, text in enumerate(headers):
        cell = hdr.cells[i]
        set_col_width(cell, widths[i])
        shade(cell, header_fill)
        cell_margins(cell, 70, 70, 80, 80)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(str(text))
        set_run_font(run, font_size, True, WHITE)
    for r_idx, row in enumerate(rows):
        tr = table.add_row()
        no_split(tr)
        for i, text in enumerate(row):
            cell = tr.cells[i]
            set_col_width(cell, widths[i])
            if r_idx % 2 == 1:
                shade(cell, LIGHT2)
            cell_margins(cell, 60, 60, 80, 80)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            run = p.add_run(str(text))
            set_run_font(run, font_size, first_col_bold and i == 0, "333333")
    return table


def add_callout(doc, text, fill=BLUE_BG, accent=ACCENT, bold_prefix=None, width=17.0):
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    cell = table.cell(0, 0)
    set_col_width(cell, width)
    shade(cell, fill)
    cell_margins(cell, 120, 120, 160, 160)
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge, sz in (("top", 4), ("bottom", 4), ("right", 4), ("left", 20)):
        e = OxmlElement(f"w:{edge}")
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), str(sz))
        e.set(qn("w:space"), "0")
        e.set(qn("w:color"), accent if edge == "left" else fill)
        borders.append(e)
    tc_pr.append(borders)
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.3
    if bold_prefix:
        run = p.add_run(bold_prefix)
        set_run_font(run, 10, True, accent)
    run = p.add_run(text)
    set_run_font(run, 10, False, "1F2937")
    return table


def add_para(doc, text="", size=10.5, bold=False, color="333333",
             space_before=0, space_after=4, align=None, indent=None, line=1.35, style=None):
    p = doc.add_paragraph(style=style)
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = line
    if indent is not None:
        p.paragraph_format.left_indent = Cm(indent)
    if align is not None:
        p.alignment = align
    if text:
        run = p.add_run(text)
        set_run_font(run, size, bold, color)
    return p


def add_bullets(doc, items, size=10.2, color="333333"):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.3
        p.paragraph_format.left_indent = Cm(0.72)
        p.paragraph_format.first_line_indent = Cm(-0.32)
        run = p.add_run(item)
        set_run_font(run, size, False, color)


def add_heading(doc, text, level=1):
    p = doc.add_heading(level=level)
    p.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    p.paragraph_format.space_after = Pt(5 if level == 1 else 4)
    p.paragraph_format.keep_with_next = True
    run = p.add_run(text)
    if level == 1:
        set_run_font(run, 16, True, TEAL)
        p_pr = p._p.get_or_add_pPr()
        p_bdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "10")
        bottom.set(qn("w:space"), "3")
        bottom.set(qn("w:color"), "99F6E4")
        p_bdr.append(bottom)
        p_pr.append(p_bdr)
    elif level == 2:
        set_run_font(run, 12.5, True, "1F2937")
    else:
        set_run_font(run, 11, True, ACCENT)
    return p


def add_page_number_footer(section):
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run("第 ")
    set_run_font(run, 8.5, False, MUTED)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    r = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "1"
    r.append(t)
    fld.append(r)
    p._p.append(fld)
    run = p.add_run(" 页 / 共 ")
    set_run_font(run, 8.5, False, MUTED)
    fld2 = OxmlElement("w:fldSimple")
    fld2.set(qn("w:instr"), "NUMPAGES")
    r2 = OxmlElement("w:r")
    t2 = OxmlElement("w:t")
    t2.text = "1"
    r2.append(t2)
    fld2.append(r2)
    p._p.append(fld2)
    run = p.add_run(" 页")
    set_run_font(run, 8.5, False, MUTED)


def add_header(section):
    header = section.header
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run("NexusHub · 前端 Vue 全量替换实施计划")
    set_run_font(run, 8.5, False, MUTED)
    run2 = p.add_run("    v1.0 / 规划稿")
    set_run_font(run2, 8.5, False, "9CA3AF")
    p_pr = p._p.get_or_add_pPr()
    p_bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "4")
    bottom.set(qn("w:space"), "4")
    bottom.set(qn("w:color"), "E5E7EB")
    p_bdr.append(bottom)
    p_pr.append(p_bdr)


def stage_block(doc, tag, title, percent, goal, work, gates, rollback, days):
    add_heading(doc, f"{tag}｜{title}（{percent}）", 2)
    add_para(doc, f"参考工期：{days}。本阶段完成度是累计值，不是本阶段增量。", 9.2, False, MUTED, 0, 4)
    add_para(doc, "目标", 10.2, True, "1F2937", 3, 2)
    add_para(doc, goal, 10.2, False, "333333", 0, 4)
    add_para(doc, "工作项", 10.2, True, "1F2937", 3, 2)
    add_bullets(doc, work)
    add_para(doc, "出口标准", 10.2, True, "1F2937", 3, 2)
    add_bullets(doc, gates)
    add_para(doc, f"回滚点：{rollback}", 9.5, False, MUTED, 2, 8)


def build():
    doc = Document()

    # 页面设置
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.0)
    section.right_margin = Cm(2.0)
    section.different_first_page_header_footer = True
    add_header(section)
    add_page_number_footer(section)

    # 样式
    normal = doc.styles["Normal"]
    style_font(normal, 10.5, False, "333333")
    normal.paragraph_format.line_spacing = 1.35
    normal.paragraph_format.space_after = Pt(4)
    for level, size, color in ((1, 16, TEAL), (2, 12.5, "1F2937"), (3, 11, ACCENT)):
        st = doc.styles[f"Heading {level}"]
        style_font(st, size, True, color)
    for st_name in ("List Bullet",):
        st = doc.styles[st_name]
        style_font(st, 10.2, False, "333333")

    # 封面
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(20)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run("NEXUSHUB · 前端工程")
    set_run_font(run, 9.5, True, ACCENT)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(24)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run("NexusHub 前端 Vue 全量替换")
    set_run_font(run, 25, True, "0F172A")

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run("分阶段实施计划")
    set_run_font(run, 25, True, "0F172A")

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(24)
    run = p.add_run("从原生 HTML / CSS / JavaScript，到 Vue 3，再到增量 TypeScript")
    set_run_font(run, 11.5, False, MUTED)

    add_callout(
        doc,
        "本文件是实施规划 + 阶段执行记录。截至 2026-11-14，阶段 0、1 已完成，当前完成度 15%；阶段 2 未开始。所有阶段以“视觉与交互一致、后端业务 API 不动、绝不使用假数据”为前提。",
        fill=AMBER_BG,
        accent=AMBER,
        bold_prefix="文档状态  ",
    )

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(6)

    meta_rows = [
        ("文档版本", "v1.0（规划稿）"),
        ("编制日期", "2026 年 11 月 14 日"),
        ("迁移对象", "源码/web 下 9 个用户页面与公共层"),
        ("目标技术栈", "Vite + Vue 3 + JavaScript，第二阶段增量 TypeScript"),
        ("硬约束", "不改业务 API；不改页面视觉与交互；不出现假数据；不重写 Git 历史"),
        ("完成度口径", "累计可交付替换进度；阶段质量门未通过，不得进入下一阶段"),
    ]
    table = doc.add_table(rows=0, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table, "E5E7EB", 4)
    for idx, (k, v) in enumerate(meta_rows):
        tr = table.add_row()
        no_split(tr)
        c0, c1 = tr.cells
        set_col_width(c0, 3.6)
        set_col_width(c1, 13.0)
        for c in (c0, c1):
            cell_margins(c, 70, 70, 100, 100)
            c.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        if idx % 2 == 0:
            shade(c0, LIGHT2)
            shade(c1, LIGHT2)
        p0 = c0.paragraphs[0]
        p0.paragraph_format.space_before = Pt(0)
        p0.paragraph_format.space_after = Pt(0)
        r0 = p0.add_run(k)
        set_run_font(r0, 9.2, True, "374151")
        p1 = c1.paragraphs[0]
        p1.paragraph_format.space_before = Pt(0)
        p1.paragraph_format.space_after = Pt(0)
        r1 = p1.add_run(v)
        set_run_font(r1, 9.2, False, "111827")

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(28)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run("一句话结论：9 个页面、9 个阶段。阶段 5 完成全部页面的 Vue 化，阶段 7 完成 TypeScript，阶段 8 才允许删除备份。")
    set_run_font(run, 10.2, True, TEAL)

    doc.add_page_break()

    # 一、目标与边界
    add_heading(doc, "一、目标与边界", 1)
    add_para(doc, "这份计划解决一个问题：在不改变用户看到的效果、不改变后端业务接口的前提下，把现有原生前端整体迁移为 Vue 3，并在时间允许时增量补上 TypeScript。")
    add_para(doc, "目标", 10.5, True, "1F2937", 6, 2)
    add_bullets(doc, [
        "9 个用户页面全部由 Vue 3 组件渲染，不再依赖页面级 DOM 查询和全局脚本。",
        "视觉、布局、文案、交互、空态、错误态与迁移前一致；同一浏览器、同一分辨率下截图无可见差异。",
        "后端业务 API 路径、请求体、响应体、SSE 事件格式不变；最多只调整静态资源托管目录。",
        "全部数据来自现有接口与真实状态；没有接口的位置只能使用“— / 暂无 / 加载中…”，不得编造数字、状态或时间。",
        "分阶段提交，每阶段可回滚；完整 Git 历史保留，不重写已有提交。",
    ])
    add_para(doc, "非目标", 10.5, True, "1F2937", 6, 2)
    add_bullets(doc, [
        "不重写后端、不改 AI 工作流、不改 RAG、不改工具调用、不改数据库。",
        "不借迁移做视觉改版、不新增功能、不改文案。",
        "不把 Vue 当成“套壳”：不接受只包一层根节点、内部仍用原 JS 改 DOM 的假迁移。",
        "不追求前端满分 10 分；本计划的目标是 8.5–9.5 的工程分，并保证可交付。",
    ])

    add_callout(
        doc,
        "“效果一模一样”的判定边界：同一浏览器、同一分辨率、同一字体环境下，页面截图无可见差异，关键交互结果一致；不承诺跨操作系统字体渲染完全一致。",
        fill=BLUE_BG,
        accent=ACCENT,
        bold_prefix="验收口径  ",
    )

    # 二、策略
    add_heading(doc, "二、迁移策略与关键决策", 1)
    add_para(doc, "为什么不是“先 CDN 再补 TS”", 11, True, "1F2937", 4, 2)
    add_para(doc, "Vue 3 CDN 可以在一天内把页面挂起来，视觉也能一致，但它没有构建、没有单文件组件、没有 TypeScript。后面要补 TS，必须引入 Vite/tsc，等于第二次迁移：模板要重搬、组件要重写、挂载方式要改。")
    add_para(doc, "因此本计划选择：第一阶段直接上 Vite + Vue 3 + JavaScript，第二阶段再增量 TypeScript。这样只迁移一次，时间不够时也能停在“Vue 3 + JS 可用”的状态。")
    doc.add_page_break()
    add_para(doc, "四项关键决策", 11, True, "1F2937", 6, 2)
    add_table(
        doc,
        ["决策", "选择", "原因"],
        [
            ("构建方式", "Vite 多页构建", "保留 /settings/、/workbench/ 等现有 URL；后端只改静态目录，不改路由和 API"),
            ("页面组织", "每页一个 Vue 入口 + 公共组件", "不改造成 SPA，避免刷新 404 和路由 fallback"),
            ("迁移顺序", "先简单页，再辅助工作台，最后工作台", "先用低风险页验证像素一致与迁移流程，再碰 SSE/CodeMirror/iframe"),
            ("类型化", "第二阶段增量 TS", "第一阶段先保证组件与视觉；TS 逐文件开启，不阻塞交付"),
        ],
        [3.0, 4.6, 9.4],
        font_size=9.0,
        first_col_bold=True,
    )

    add_para(doc, "完成度定义", 11, True, "1F2937", 8, 2)
    add_para(doc, "本计划的百分比是“累计可交付替换进度”，不是工时进度，也不是评分。页面迁移完成但视觉未验收，不算完成；页面视觉通过但 TS 未做，最多到 93%。")
    add_table(
        doc,
        ["完成度区间", "含义", "可交付状态"],
        [
            ("0%–15%", "底座与试点页", "能构建、能打开设置页，但还不能替换全站"),
            ("15%–55%", "简单页与中等页", "登录、注册、项目、记忆、辅助列表、欢迎页可用"),
            ("55%–85%", "两个复杂工作台", "全部 9 页由 Vue 渲染，核心交互可用"),
            ("85%–93%", "全量视觉与交互验收", "三分辨率截图通过，可作为 Vue 版本交付"),
            ("93%–100%", "TypeScript 与清理", "类型检查通过，备份删除，最终构建与标签完成"),
        ],
        [3.2, 5.2, 8.6],
        font_size=9.0,
        first_col_bold=True,
    )

    add_para(doc, "执行原则", 10.5, True, "1F2937", 8, 2)
    add_bullets(doc, [
        "先备份后改；任一阶段失败，都能回到 pre-vue-migration 标签。",
        "一次只迁一页；不并行铺开，不把半成品合入主分支。",
        "每页完成 = 截图无差异 + 关键交互通过 + 控制台零异常。",
        "复杂页最后迁；工作台不通过，保留原生页，不阻塞其余页面。",
        "不为赶进度跳过验收；能打开不等于完成。",
    ])

    # 三、页面清单
    doc.add_page_break()
    add_heading(doc, "三、页面清单与迁移顺序", 1)
    add_para(doc, "共 9 个用户页面；根路径 / 只做跳转，不单独迁移。顺序按“风险从低到高”排列，辅助工作台和工作台必须放在最后。")
    add_table(
        doc,
        ["顺序", "页面", "路由", "复杂度", "主要风险", "阶段"],
        [
            ("1", "设置页", "/settings/", "低", "API Key、主题、保存状态", "阶段 1（试点）"),
            ("2", "登录页", "/login/", "低", "登录跳转、回车提交", "阶段 2"),
            ("3", "注册页", "/register/", "低", "校验、重复用户名", "阶段 2"),
            ("4", "项目页", "/projects/", "低中", "列表、创建、删除、空态", "阶段 2"),
            ("5", "记忆页", "/memory/", "中", "分组、置顶、删除、导出", "阶段 3"),
            ("6", "辅助项目列表", "/assist/", "低", "创建、列表、删除", "阶段 3"),
            ("7", "欢迎页", "/welcome/", "中", "动画、主题、滚动", "阶段 3"),
            ("8", "辅助工作台", "/assist/workspace/", "高", "CodeMirror、SSE、Agent、图片、检查", "阶段 4"),
            ("9", "工作台", "/workbench/", "最高", "SSE、树、任务、代码流、iframe、门禁", "阶段 5"),
        ],
        [1.2, 3.2, 3.4, 1.9, 6.0, 2.3],
        font_size=8.8,
    )
    add_callout(
        doc,
        "阶段 5 是分水岭：9 个页面全部 Vue 化，但还没有做全量截图验收；阶段 6 才代表“效果一致”。阶段 7 是加分项，不是交付前提。",
        fill=BLUE_BG,
        accent=ACCENT,
        bold_prefix="阅读提示  ",
    )

    # 四、阶段总表
    doc.add_page_break()
    add_heading(doc, "四、阶段总表", 1)
    add_para(doc, "下表是整套计划的控制面。每一行都是一个质量门：上一阶段出口未通过，不进入下一阶段。参考工期是稳妥估计，不是承诺。")
    add_table(
        doc,
        ["阶段", "名称", "页面完成", "累计完成度", "参考工期", "阶段出口"],
        [
            ("0", "备份与基线", "0 / 9", "5%", "0.5 天", "基线截图、标签、副本齐全；代码未动"),
            ("1", "工程底座 + 设置页", "1 / 9", "15%", "0.5–1 天", "Vite 可构建；设置页截图无差异"),
            ("2", "认证与项目页", "4 / 9", "35%", "1 天", "登录、注册、项目页通过；跳转正常"),
            ("3", "列表与欢迎页", "7 / 9", "55%", "0.5–1 天", "记忆、辅助列表、欢迎页通过"),
            ("4", "辅助工作台", "8 / 9", "70%", "1–1.5 天", "CodeMirror、SSE、Agent、图片全通"),
            ("5", "工作台", "9 / 9", "85%", "1.5–2 天", "SSE、树、代码流、预览、门禁全通"),
            ("6", "全量验收", "9 / 9", "93%", "0.5–1 天", "三分辨率截图无差异；控制台零异常"),
            ("7", "增量 TypeScript", "9 / 9", "98%", "1 天", "vue-tsc 零错误；页面无变化"),
            ("8", "清理与交付", "9 / 9", "100%", "0.5 天", "备份删除；最终构建与标签完成"),
        ],
        [1.2, 3.6, 2.2, 2.4, 2.3, 5.3],
        font_size=8.8,
    )
    add_para(doc, "合计参考工期 7–9.5 天。若只做一天，只能完成阶段 0–2 的一部分，不可能完成“全量 + 视觉一致 + TS”。", 9.2, False, MUTED, 4, 8)

    # 五、阶段明细
    add_heading(doc, "五、阶段明细与出口标准", 1)
    add_para(doc, "以下每个阶段都按“目标 → 工作项 → 出口标准 → 回滚点”组织。出口标准不通过，不允许开始下一阶段。")

    doc.add_page_break()
    stage_block(
        doc, "阶段 0", "备份与基线", "0% → 5%",
        "在改任何代码之前，固定当前可用的原生版本，建立可比较、可回滚的基线。",
        [
            "在 Git 上打标签 pre-vue-migration，并新建分支 feat/vue-migration。",
            "把 源码/web 复制为本地基线目录 web-baseline-20261114；该目录不提交，只用于逐页对比。",
            "对 9 个页面分别截图：1440×900、1920×1080、390×844；覆盖默认、空态、加载态、错误态、弹窗态。",
            "记录每个页面的控制台错误、404、字体、滚动条和关键交互；形成基线清单。",
            "固定迁移期使用的浏览器版本与字体环境，后续所有对比都在同一环境完成。",
        ],
        [
            "Git 标签、分支、基线副本都存在，且能明确回滚。",
            "9 个页面 × 3 个分辨率的基线截图齐全；复杂页至少包含空态、加载态、错误态。",
            "基线清单记录当前已知问题，避免迁移时把旧问题误判为新问题。",
            "本阶段不产生任何页面代码改动。",
        ],
        "删除分支与基线副本，回到 pre-vue-migration 标签。",
        "0.5 天",
    )

    stage_block(
        doc, "阶段 1", "工程底座 + 设置页试点", "5% → 15%",
        "用最简单的设置页验证整条迁移链路：Vite 构建、Vue 组件、静态托管、像素对比。这是 Go / No-Go 门。",
        [
            "搭建 Vite 多页工程，保留现有 URL 目录；构建输出到 web/dist。",
            "抽出公共 Appbar、API 请求层、基础 UI 原语（Button、Panel、Modal、EmptyState）。",
            "迁移设置页：API Key、主题、保存状态、错误提示全部走 Vue 状态。",
            "后端只调整静态资源根目录到 web/dist；业务 API、SSE、上传接口一律不动。",
            "建立截图对比脚本或固定对比流程；记录首屏时间、控制台错误、请求 404。",
        ],
        [
            "npm run build 通过；构建产物能由现有后端直接打开。",
            "设置页在 1440 / 1920 / 390 三个宽度下与基线无可见差异。",
            "保存、读取、错误提示、主题切换全部正常；控制台零异常。",
            "如果设置页无法做到像素一致，停止全量迁移，先修底座，不得带病铺开。",
        ],
        "删除 Vite 工程与 dist，恢复原静态目录；保留基线截图。",
        "0.5–1 天",
    )

    stage_block(
        doc, "阶段 2", "认证与项目页", "15% → 35%",
        "迁移登录、注册、项目页，覆盖表单、认证跳转、列表 CRUD 三类最常见交互。",
        [
            "登录页：回车提交、错误提示、登录成功跳转、已登录访问登录页的处理。",
            "注册页：用户名/密码校验、重复用户名、成功后跳转。",
            "项目页：列表、创建、删除、空态、加载态、错误态；保持现有分页/排序行为。",
            "统一 API 错误处理；禁止用假项目、假时间填充页面。",
            "每页迁移后立即截图对比，不通过不进入下一页。",
        ],
        [
            "三个页面视觉与基线一致；表单错误态和空态一致。",
            "登录、注册、退出、项目创建/删除全流程可用；刷新后状态正确。",
            "未登录访问受保护页会跳转登录；登录后能回到原目标页。",
            "控制台零异常，网络无 404/500。",
        ],
        "按页面回滚：保留已通过页面，单独 revert 未通过页面。",
        "1 天",
    )

    stage_block(
        doc, "阶段 3", "列表与欢迎页", "35% → 55%",
        "迁移记忆页、辅助项目列表、欢迎页，覆盖分组列表、置顶/删除/导出、动画与主题。",
        [
            "记忆页：分组、置顶、删除、导出、空态；保持现有统计口径。",
            "辅助项目列表：创建、进入、删除、空态；保持现有排序。",
            "欢迎页：滚动、动画、主题切换、入口按钮；动画时序与基线一致。",
            "把重复的列表项、空态、确认弹窗抽成公共组件，避免复制。",
            "逐页截图对比；欢迎页额外录制动画关键帧对比。",
        ],
        [
            "三个页面视觉一致；欢迎页动画无明显加速/延迟/跳变。",
            "记忆置顶、删除、导出结果正确；辅助项目创建/进入/删除正确。",
            "空态、加载态、错误态与基线一致；无假数据。",
            "公共列表组件至少被两个页面复用。",
        ],
        "按页面回滚；欢迎页动画不通过则保留原生页，不阻塞其他页。",
        "0.5–1 天",
    )

    stage_block(
        doc, "阶段 4", "辅助工作台", "55% → 70%",
        "迁移最复杂的交互页之一：CodeMirror、文件页签、检查结果、AI 流式/自动/Agent、图片上传、测试与交付。",
        [
            "CodeMirror 封装为 Vue 组件：onMounted 初始化，onUnmounted 销毁，避免重复实例。",
            "文件树/页签、保存、删除、检查、撤销全部改为 Vue 状态驱动。",
            "AI 对话：普通流式、协作建议、自动改码、Agent 工具卡、图片输入全部保留。",
            "SSE 连接在组件卸载时关闭；切页、切文件不泄漏监听器。",
            "空态、错误态、加载态、工具调用结果与基线一致；不伪造 AI 输出。",
        ],
        [
            "辅助工作台所有功能可用：文件、保存、检查、AI、Agent、图片、测试、交付。",
            "CodeMirror 不重复初始化；切页再回来编辑器正常。",
            "SSE 不重连风暴、不重复追加；关闭页面后无残留请求。",
            "三分辨率截图与基线一致；控制台零异常。",
        ],
        "整页回滚到原生版本；已迁移的公共组件保留。",
        "1–1.5 天",
    )

    stage_block(
        doc, "阶段 5", "工作台", "70% → 85%",
        "迁移风险最高的页面：SSE 事件流、树布局、任务分组、代码流、iframe 预览、门禁弹窗、验收面板。",
        [
            "SSE 事件处理改为集中状态更新；phase/task/reasoning/text/tool/retrieval/gate 等事件逐类对齐。",
            "树布局、任务分组、折叠、代码流、文件页签、预览 iframe 全部保留原行为。",
            "门禁弹窗、继续/回退、验收结果、证据链与基线一致。",
            "iframe 的 URL、刷新、跨端口行为不变；不额外加 sandbox 限制。",
            "异常路径：SSE 断开、事件乱序、空运行、失败运行都要有真实提示。",
        ],
        [
            "9 / 9 页面全部由 Vue 渲染，原生页面脚本不再参与页面渲染。",
            "完整跑通一次真实工作流：计划 → 设计 → 开发 → 装配 → 测试 → 交付。",
            "门禁弹窗、验收、证据、代码流、预览均与基线一致。",
            "控制台零异常；SSE 断开/恢复行为正确；无假事件、假状态。",
        ],
        "整页回滚；若 SSE 无法稳定，保留原生工作台，其他 8 页照常交付。",
        "1.5–2 天",
    )

    stage_block(
        doc, "阶段 6", "全量视觉与交互验收", "85% → 93%",
        "逐页、逐状态、逐分辨率对比，确认“效果一模一样”，并留下可复查的证据。",
        [
            "9 个页面 × 3 个分辨率 × 默认/空态/加载/错误/弹窗，逐张截图对比。",
            "检查字体、间距、颜色、滚动条、层级、动画时序、移动端断点。",
            "检查登录过期、刷新、前进后退、键盘操作、复制粘贴等边界。",
            "记录首屏时间、构建体积、静态资源数量；不编造性能数据。",
            "所有差异必须修复或书面记录为“浏览器环境差异”，不能口头放过。",
        ],
        [
            "肉眼无可见差异；像素差异不超过 0.1%，且无布局位移。",
            "关键交互清单全部通过；控制台零异常、网络无 404/500。",
            "三分辨率截图与对比记录归档；可作为 Vue 版本交付。",
            "此时前端工程分预计 8–8.5 / 10，已可停止并交付。",
        ],
        "回到阶段 5 的最后一个通过提交；按页面修复，不整体重来。",
        "0.5–1 天",
    )

    stage_block(
        doc, "阶段 7", "增量 TypeScript", "93% → 98%",
        "在不改变任何视觉与交互的前提下，把 JavaScript 逐批改成 TypeScript，并让 vue-tsc 通过。",
        [
            "新增 tsconfig.json，开启 allowJs，先让现有 JS 能参与类型检查。",
            "先改公共层：API 类型、store、Appbar、UI 原语；再改页面组件。",
            "新组件统一使用 <script setup lang=\"ts\">；旧文件逐个重命名并补类型。",
            "每批改完运行 vue-tsc --noEmit，零错误才提交。",
            "不借 TS 改造改行为、改样式、改文案；每批都做截图抽查。",
        ],
        [
            "vue-tsc --noEmit 零错误；构建通过。",
            "页面视觉与阶段 6 一致；关键交互回归通过。",
            "公共 API、SSE 事件、工具结果都有明确类型或类型别名。",
            "前端工程分预计 8.5–9.5 / 10；未覆盖的 any 有清单，不假装全量类型化。",
        ],
        "按批次回滚；TS 批次不影响已通过的 Vue 页面。",
        "1 天",
    )

    stage_block(
        doc, "阶段 8", "清理与交付", "98% → 100%",
        "删除迁移备份，完成最终构建、文档、标签与交付检查。",
        [
            "确认 9 个页面全部通过阶段 6/7 的验收，且无未关闭的差异项。",
            "删除 web-baseline-20261114；确认仓库中不残留备份目录、dist 临时文件、调试开关。",
            "更新 README：技术栈、构建命令、静态托管说明、已知限制。",
            "执行一次干净构建与全页面冒烟；打标签 vue-migration-done。",
            "提交最终变更，保留完整历史；不 amend、不 rebase 已推送提交。",
        ],
        [
            "最终构建可复现；所有页面可打开；控制台零异常。",
            "备份已删除；仓库无临时文件；文档与实际一致。",
            "Git 标签、分支、提交记录完整；可回滚到迁移前。",
            "完成度 100%，交付。",
        ],
        "从 vue-migration-done 回退到阶段 7 或 pre-vue-migration。",
        "0.5 天",
    )

    # 六、阶段门
    add_heading(doc, "六、阶段门的统一判定", 1)
    add_para(doc, "每个阶段结束都必须过同一套门。任何一项不通过，阶段完成度不得上调，也不得进入下一阶段。")
    add_table(
        doc,
        ["门禁项", "判定标准", "不通过时"],
        [
            ("构建", "npm run build 成功，产物可由后端直接托管", "修构建，不进入下一页"),
            ("路由", "9 个页面 URL 全部 200；刷新不 404", "检查多页入口与静态目录"),
            ("视觉", "同环境截图无可见差异；像素差异 ≤ 0.1%", "按页修复 CSS/DOM，不整体重来"),
            ("交互", "该阶段关键流程全部通过", "回滚该页，保留已通过页面"),
            ("控制台", "零 JS 异常；无 404/500", "修到零异常再继续"),
            ("数据", "无假数据；空态只用 — / 暂无 / 加载中…", "删除假数据，改真实接口或空态"),
            ("提交", "每阶段至少一个可回滚提交", "补提交后再进入下一阶段"),
        ],
        [2.6, 9.4, 5.0],
        font_size=9.0,
        first_col_bold=True,
    )

    # 七、视觉一致性
    add_heading(doc, "七、视觉与交互一致性方案", 1)
    add_para(doc, "“一模一样”不能靠肉眼感觉，必须有基线、有对比、有记录。")
    add_para(doc, "三条硬约束", 10.5, True, "1F2937", 6, 2)
    add_bullets(doc, [
        "CSS 原样保留：不重命名类名、不改设计令牌、不引入新的全局样式；必须改的样式要逐条记录原因。",
        "DOM 层级尽量不变：Vue 根节点挂在原容器上，不额外包一层；避免 .work > .tasks 这类子选择器失效。",
        "第三方命令式组件单独封装：CodeMirror 在 onMounted 初始化、onUnmounted 销毁；iframe 的 URL 与刷新逻辑不变。",
    ])
    add_para(doc, "逐页交互清单", 10.5, True, "1F2937", 6, 2)
    add_table(
        doc,
        ["检查类", "每页至少覆盖"],
        [
            ("加载", "首屏、刷新、慢接口、空列表"),
            ("错误", "接口失败、未登录、无权限、网络断开"),
            ("表单", "空值、非法值、重复提交、回车提交"),
            ("列表", "空态、分页/排序、删除确认、操作后刷新"),
            ("复杂交互", "弹窗层级、滚动锁定、键盘 Esc、前进后退"),
            ("数据真实性", "不出现编造的项目、任务、耗时、成本、状态"),
        ],
        [3.4, 13.6],
        font_size=9.0,
        first_col_bold=True,
    )

    # 八、Git
    add_heading(doc, "八、备份、分支与提交规则", 1)
    add_bullets(doc, [
        "迁移前：打标签 pre-vue-migration；新建分支 feat/vue-migration；复制 web 为本地基线目录。",
        "迁移中：每阶段至少一个提交；提交信息写清阶段与页面，例如 feat(web): 迁移设置页到 Vue 3。",
        "迁移中：不 amend、不 rebase 已推送提交；只追加，不改写历史。",
        "迁移后：全部验收通过，打标签 vue-migration-done，再删除基线副本。",
        "任何阶段失败：回退到该阶段开始前的提交；不把半成品留在主分支。",
    ])

    # 九、风险
    add_heading(doc, "九、主要风险与应对", 1)
    add_table(
        doc,
        ["风险", "触发信号", "影响", "应对 / 回滚"],
        [
            ("多包一层根节点", "布局错位、子选择器失效", "全站视觉漂移", "挂载在原容器；保留 DOM 层级；每页截图"),
            ("静态路由 404", "刷新 /workbench/ 空白", "页面不可用", "Vite 多页输出保持原目录；逐路由冒烟"),
            ("CodeMirror 重复初始化", "编辑器空白/重复工具栏", "辅助工作台不可用", "生命周期封装；卸载销毁；切页回归"),
            ("SSE 泄漏", "事件重复、切页后仍追加", "工作台状态错乱", "onUnmounted 关闭；请求中止；断线测试"),
            ("iframe 预览异常", "预览空白、URL 丢失", "核心演示失败", "保持原 URL/刷新/端口；单独回归"),
            ("视觉差异", "截图对比不通过", "验收失败", "按页修复；不整体重来；保留原生页兜底"),
            ("工期超限", "阶段 5 仍未完成", "交付风险", "停在阶段 5/6，交付 Vue+JS；不半途开 TS"),
            ("假数据诱惑", "接口未通，先填占位数字", "直接违规", "只用 — / 暂无 / 加载中…；接口不通就显示错误"),
        ],
        [3.4, 4.6, 3.8, 5.2],
        font_size=8.6,
        first_col_bold=True,
    )

    # 十、评分
    doc.add_page_break()
    add_heading(doc, "十、阶段与预期分数", 1)
    add_para(doc, "以下是工程判断，不是官方评分。前端工程满分 10 分；本计划不承诺满分。")
    add_table(
        doc,
        ["停止点", "技术状态", "前端工程预计", "总分影响", "说明"],
        [
            ("阶段 5", "Vue 3 + JavaScript，全页可用", "7.5–8 / 10", "+3–4", "视觉一致、组件化成立；无 TS/构建类型"),
            ("阶段 6", "同上，完成全量验收", "8–8.5 / 10", "+4", "可作为稳定交付版本"),
            ("阶段 7", "Vue 3 + 增量 TypeScript", "8.5–9.5 / 10", "+5–6", "类型检查通过；仍缺测试/性能专项"),
            ("满分", "Vue3 + TS + 测试 + 性能数据", "10 / 10", "+6", "本计划不追求；需要额外时间"),
        ],
        [1.8, 5.4, 3.2, 2.2, 4.4],
        font_size=8.8,
        first_col_bold=True,
    )
    add_callout(
        doc,
        "阶段 5 是“全量替换”的最低可交付点；阶段 6 是“效果一致”的验收点；阶段 7 是“工程分更高”的增强点。三个点都可以停，但不能在页面未验收时开始 TS。",
        fill=GREEN_BG,
        accent=GREEN,
        bold_prefix="停止规则  ",
    )

    # 十一、DoD
    add_heading(doc, "十一、最终完成清单", 1)
    checklist = [
        "9 个页面全部由 Vue 3 渲染，原生页面脚本不再参与渲染。",
        "所有页面在三分辨率下截图无可见差异，差异记录归档。",
        "登录、项目、记忆、辅助工作台、工作台的关键流程全部通过。",
        "CodeMirror、SSE、iframe、门禁弹窗无泄漏、无重复、无残留。",
        "控制台零异常，网络无 404/500。",
        "无假数据；空态只使用 — / 暂无 / 加载中…。",
        "后端业务 API 未改；静态托管路径变更已写入 README。",
        "TypeScript 阶段 vue-tsc 零错误（若执行到阶段 7）。",
        "备份目录已删除；仓库无临时文件；标签与提交完整。",
        "README、构建说明、已知限制与实际一致。",
    ]
    for item in checklist:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.left_indent = Cm(0.3)
        run = p.add_run("□  ")
        set_run_font(run, 11, True, ACCENT)
        run2 = p.add_run(item)
        set_run_font(run2, 10.2, False, "333333")

    doc.add_page_break()
    add_heading(doc, "十二、执行记录（截至 2026-11-14）", 1)
    add_para(doc, "以下记录是实际执行结果，不是计划值。阶段 2 尚未开始，完成度停在 15%。")
    add_table(
        doc,
        ["阶段", "状态", "完成度", "实际产物 / 证据", "提交"],
        [
            ("0 备份与基线", "完成", "5%", "tag pre-vue-migration；27 张真实基线截图；本机 web-baseline-20261114", "5897c6d"),
            ("1 工程底座 + 设置页", "完成", "15%", "web-vue（Vue 3 + Vite）；/settings 优先托管；三分辨率截图字节级一致；9 页控制台零异常", "40181f8 / 0d9fba0"),
            ("2 认证与项目页", "未开始", "15%", "—", "—"),
        ],
        [3.4, 2.0, 1.6, 8.0, 2.0],
        font_size=8.4,
        first_col_bold=True,
    )
    add_callout(
        doc,
        "已知行为修正：原设置页保存按钮查找的是“保存更改”，而页面按钮文案是“保存 API Key”，按钮实际没有接线。迁移后保存可用；初始视觉仍与基线字节级一致，改动单独记录在了提交里。",
        fill=AMBER_BG,
        accent=AMBER,
        bold_prefix="行为差异  ",
    )
    add_para(doc, "各阶段实际结论", 10.5, True, "1F2937", 6, 2)
    add_bullets(doc, [
        "阶段 0：完成 Git 标签与 web 副本，27 张基线截图覆盖 9 页 × 3 分辨率。",
        "阶段 1：设置页改为 Vue 组件；CSS 与 DOM 层级保持原样；三分辨率截图差异为 0。",
        "回归：9 个页面在 1440×900 下控制台零异常、网络无 404/500。",
        "下一步：阶段 2 迁移登录、注册、项目页；未通过视觉门不进入阶段 3。",
    ])

    add_para(doc, "编制说明", 10.5, True, "1F2937", 12, 2)
    add_para(doc, "本计划描述迁移顺序、完成度口径和验收门；阶段 0、1 已执行，其余未开始。执行中每个阶段结束后更新完成度与差异记录，不提前写“已完成”。", 9.8, False, MUTED, 0, 4)

    doc.save(OUT)


if __name__ == "__main__":
    build()
    print(OUT)