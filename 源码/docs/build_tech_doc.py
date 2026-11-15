# -*- coding: utf-8 -*-
"""构建 NexusHub 参赛技术文档（含封面、目录、正文、图表）。"""

from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.text import WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

DOCS = Path(__file__).parent
ASSETS = DOCS / "tech_doc_assets"
OUT = DOCS / "NexusHub-技术文档.docx"

INK = RGBColor(15, 23, 42)
MUTED = RGBColor(100, 116, 139)
BLUE = RGBColor(37, 99, 235)
BODY_EAST = "宋体"
BODY_WEST = "Times New Roman"
HEAD_EAST = "黑体"
TITLE_EAST = "微软雅黑"


def set_run_font(run, *, east=BODY_EAST, west=BODY_WEST, size=12, bold=False, color=INK):
    run.font.name = west
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), west)
    rfonts.set(qn("w:hAnsi"), west)
    rfonts.set(qn("w:eastAsia"), east)


def set_style(style, *, east, west, size, bold=False, color=INK, before=0, after=0, line=1.5):
    style.font.name = west
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = color
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), west)
    rfonts.set(qn("w:hAnsi"), west)
    rfonts.set(qn("w:eastAsia"), east)
    pf = style.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line


def shade(cell, hex_color):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), hex_color)
    tc_pr.append(shd)


def cell_margins(cell, top=60, bottom=60, left=100, right=100):
    tc_pr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for name, value in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        node = OxmlElement(f"w:{name}")
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tc_pr.append(mar)


def add_page_field(paragraph):
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    txt = OxmlElement("w:t")
    txt.text = "1"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr)
    run._r.append(fld_sep)
    run._r.append(txt)
    run._r.append(fld_end)
    set_run_font(run, east=BODY_EAST, west=BODY_WEST, size=9, color=MUTED)


def hrule(paragraph, color="D8E1EE", size=10):
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), "6")
    bottom.set(qn("w:color"), color)
    borders.append(bottom)
    p_pr.append(borders)


class Builder:
    def __init__(self):
        self.doc = Document()
        self.outline = []
        self._setup()

    def _setup(self):
        section = self.doc.sections[0]
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)
        section.header_distance = Cm(1.4)
        section.footer_distance = Cm(1.5)

        normal = self.doc.styles["Normal"]
        set_style(normal, east=BODY_EAST, west=BODY_WEST, size=12, line=1.45, after=0)
        normal.paragraph_format.first_line_indent = Cm(0.85)
        normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

        h1 = self.doc.styles["Heading 1"]
        set_style(h1, east=HEAD_EAST, west="Times New Roman", size=16, bold=True, before=0, after=10, line=1.5)
        h1.paragraph_format.page_break_before = True
        h1.paragraph_format.keep_with_next = True
        h1.paragraph_format.first_line_indent = Cm(0)
        h1.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

        h2 = self.doc.styles["Heading 2"]
        set_style(h2, east=HEAD_EAST, west="Times New Roman", size=14, bold=True, before=11, after=5, line=1.5)
        h2.paragraph_format.keep_with_next = True
        h2.paragraph_format.first_line_indent = Cm(0)
        h2.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

        h3 = self.doc.styles["Heading 3"]
        set_style(h3, east=HEAD_EAST, west="Times New Roman", size=12, bold=True, before=9, after=4, line=1.5)
        h3.paragraph_format.keep_with_next = True
        h3.paragraph_format.first_line_indent = Cm(0)
        h3.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

        self._header_footer(section)

    def _header_footer(self, section):
        section.different_first_page_header_footer = True
        header = section.header.paragraphs[0]
        header.text = ""
        header.paragraph_format.tab_stops.add_tab_stop(Cm(16.0), WD_TAB_ALIGNMENT.RIGHT)
        run = header.add_run("NexusHub · 技术文档")
        set_run_font(run, east=BODY_EAST, size=9, color=MUTED)
        run = header.add_run("\t2026 第九届传智杯 · AI WEB 网页开发挑战赛")
        set_run_font(run, east=BODY_EAST, size=9, color=MUTED)
        hrule(header, color="E2E8F0", size=4)

        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = footer.add_run("第 ")
        set_run_font(run, east=BODY_EAST, size=9, color=MUTED)
        add_page_field(footer)
        run = footer.add_run(" 页")
        set_run_font(run, east=BODY_EAST, size=9, color=MUTED)

    def cover(self):
        doc = self.doc
        for _ in range(2):
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.0

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.3
        run = p.add_run("2026 第九届传智杯")
        set_run_font(run, east=HEAD_EAST, size=18, bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.line_spacing = 1.3
        run = p.add_run("全国大学生数智创新与 AI 应用大赛")
        set_run_font(run, east=HEAD_EAST, size=18, bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(32)
        p.paragraph_format.line_spacing = 1.5
        run = p.add_run("AI WEB 网页开发挑战赛 · 技术应用赛")
        set_run_font(run, east=HEAD_EAST, size=14, bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(10)
        p.paragraph_format.line_spacing = 1.5
        run = p.add_run("NexusHub")
        set_run_font(run, east=TITLE_EAST, west=TITLE_EAST, size=36, bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.line_spacing = 1.5
        run = p.add_run("一个网页里的软件工厂")
        set_run_font(run, east=TITLE_EAST, west=TITLE_EAST, size=18, bold=True)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.line_spacing = 1.5
        run = p.add_run("—— 从一句话需求到可运行、被验收的软件包 ——")
        set_run_font(run, east=HEAD_EAST, size=13)

        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(38)
        p.paragraph_format.line_spacing = 1.5
        run = p.add_run("技 术 文 档")
        set_run_font(run, east=TITLE_EAST, west=TITLE_EAST, size=24, bold=True)

        meta = [
            ("团队名称", "待填写"),
            ("参赛编号", "待填写"),
            ("作品类型", "AI 原生 Web 应用"),
            ("文档版本", "V1.0"),
            ("完成日期", "2026 年 11 月"),
        ]
        for label, value in meta:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(4.6)
            p.paragraph_format.space_after = Pt(5)
            p.paragraph_format.line_spacing = 1.5
            run = p.add_run(label + "：")
            set_run_font(run, east=HEAD_EAST, size=14)
            run = p.add_run(value)
            set_run_font(run, east=HEAD_EAST, size=14)

        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(34)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run("本文件内容以仓库当前代码与真实验证记录为准")
        set_run_font(run, east=BODY_EAST, size=10.5, color=MUTED)

    def toc(self, entries):
        doc = self.doc
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(18)
        run = p.add_run("目  录")
        set_run_font(run, east=HEAD_EAST, size=22, bold=True)

        for title, level in entries:
            p = doc.add_paragraph()
            pf = p.paragraph_format
            pf.left_indent = Cm(0.6 if level == 2 else 0)
            pf.first_line_indent = Cm(0)
            pf.space_before = Pt(3 if level == 1 else 0)
            pf.space_after = Pt(0)
            pf.line_spacing = 1.05
            pf.tab_stops.add_tab_stop(Cm(16.0), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
            run = p.add_run(title)
            set_run_font(run, east=BODY_EAST, size=11.5, bold=(level == 1))
            run = p.add_run("\t00")
            set_run_font(run, east=BODY_EAST, size=11.5, bold=False)

    def h1(self, text):
        p = self.doc.add_paragraph(style="Heading 1")
        run = p.add_run(text)
        set_run_font(run, east=HEAD_EAST, size=16, bold=True)
        self.outline.append((text, 1))

    def h2(self, text):
        p = self.doc.add_paragraph(style="Heading 2")
        run = p.add_run(text)
        set_run_font(run, east=HEAD_EAST, size=14, bold=True)
        self.outline.append((text, 2))

    def h3(self, text):
        p = self.doc.add_paragraph(style="Heading 3")
        run = p.add_run(text)
        set_run_font(run, east=HEAD_EAST, size=12, bold=True)

    def body(self, text, bold_prefix=None, indent=True):
        p = self.doc.add_paragraph()
        p.paragraph_format.first_line_indent = Cm(0.85) if indent else Cm(0)
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.line_spacing = 1.45
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        if bold_prefix and text.startswith(bold_prefix):
            r1 = p.add_run(bold_prefix)
            set_run_font(r1, east=BODY_EAST, size=12, bold=True)
            r2 = p.add_run(text[len(bold_prefix):])
            set_run_font(r2, east=BODY_EAST, size=12)
        else:
            run = p.add_run(text)
            set_run_font(run, east=BODY_EAST, size=12)

    def bullet(self, text, bold_prefix=None):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(0.74)
        pf.first_line_indent = Cm(-0.37)
        pf.space_before = Pt(0)
        pf.space_after = Pt(1)
        pf.line_spacing = 1.45
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        run = p.add_run("• ")
        set_run_font(run, east=BODY_EAST, size=12, color=BLUE, bold=True)
        if bold_prefix and text.startswith(bold_prefix):
            r1 = p.add_run(bold_prefix)
            set_run_font(r1, east=BODY_EAST, size=12, bold=True)
            r2 = p.add_run(text[len(bold_prefix):])
            set_run_font(r2, east=BODY_EAST, size=12)
        else:
            run = p.add_run(text)
            set_run_font(run, east=BODY_EAST, size=12)

    def quote(self, text):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(0.74)
        pf.right_indent = Cm(0.4)
        pf.space_before = Pt(4)
        pf.space_after = Pt(6)
        pf.line_spacing = 1.4
        p.paragraph_format.first_line_indent = Cm(0)
        run = p.add_run(text)
        set_run_font(run, east=BODY_EAST, size=10.5, color=MUTED)
        p_pr = p._p.get_or_add_pPr()
        borders = OxmlElement("w:pBdr")
        left = OxmlElement("w:left")
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "12")
        left.set(qn("w:space"), "8")
        left.set(qn("w:color"), "93C5FD")
        borders.append(left)
        p_pr.append(borders)

    def code(self, text):
        p = self.doc.add_paragraph()
        pf = p.paragraph_format
        pf.left_indent = Cm(0.6)
        pf.right_indent = Cm(0.3)
        pf.space_before = Pt(3)
        pf.space_after = Pt(6)
        pf.line_spacing = 1.15
        pf.first_line_indent = Cm(0)
        run = p.add_run(text)
        set_run_font(run, east="等线", west="Consolas", size=8.5, color=INK)
        p_pr = p._p.get_or_add_pPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:fill"), "F6F8FB")
        p_pr.append(shd)

    def caption(self, text):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(3)
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.first_line_indent = Cm(0)
        run = p.add_run(text)
        set_run_font(run, east=BODY_EAST, size=10.5, color=MUTED)

    def image(self, path, width_cm, caption):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(5)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.first_line_indent = Cm(0)
        run = p.add_run()
        run.add_picture(str(path), width=Cm(width_cm))
        self.caption(caption)

    def table(self, headers, rows, widths, caption=None, font_size=10.5):
        if caption:
            self.caption(caption)
        table = self.doc.add_table(rows=1, cols=len(headers))
        table.style = "Table Grid"
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        header = table.rows[0]
        header.height = Cm(0.72)
        tr_pr = header._tr.get_or_add_trPr()
        tbl_header = OxmlElement("w:tblHeader")
        tbl_header.set(qn("w:val"), "true")
        tr_pr.append(tbl_header)
        for i, text in enumerate(headers):
            cell = header.cells[i]
            cell.width = Cm(widths[i])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            shade(cell, "EAF2FF")
            cell_margins(cell)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            run = p.add_run(str(text))
            set_run_font(run, east=HEAD_EAST, size=font_size, bold=True)

        for row_data in rows:
            row = table.add_row()
            tr_pr = row._tr.get_or_add_trPr()
            cant_split = OxmlElement("w:cantSplit")
            tr_pr.append(cant_split)
            for i, text in enumerate(row_data):
                cell = row.cells[i]
                cell.width = Cm(widths[i])
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                cell_margins(cell)
                p = cell.paragraphs[0]
                p.paragraph_format.space_before = Pt(0)
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.15
                run = p.add_run(str(text))
                set_run_font(run, east=BODY_EAST, size=font_size)

    def page_break(self):
        self.doc.add_page_break()

    def save(self):
        self.doc.core_properties.title = "NexusHub 技术文档"
        self.doc.core_properties.subject = "2026 第九届传智杯 AI WEB 网页开发挑战赛"
        self.doc.core_properties.author = "NexusHub 团队"
        self.doc.core_properties.comments = "技术文档 V1.0"
        self.doc.save(OUT)


OUTLINE = [
    ("一  项目概述", 1),
    ("1.1  项目背景与问题", 2),
    ("1.2  目标用户与使用场景", 2),
    ("1.3  产品定位", 2),
    ("二  需求分析", 1),
    ("2.1  用户需求分析", 2),
    ("2.2  功能需求", 2),
    ("2.4  范围与边界", 2),
    ("三  系统架构设计", 1),
    ("3.1  总体架构", 2),
    ("3.2  技术选型", 2),
    ("3.3  后端模块划分", 2),
    ("3.4  前端架构", 2),
    ("3.6  关键业务流程", 2),
    ("四  AI 技术方案", 1),
    ("4.1  模型选型与理由", 2),
    ("4.2  模型集成方式", 2),
    ("4.3  Agent 与工作流设计", 2),
    ("4.4  RAG 技术应用", 2),
    ("4.5  工具调用与 MCP 边界", 2),
    ("4.6  安全与可控性", 2),
    ("4.7  成本控制与录制回放", 2),
    ("五  核心功能实现", 1),
    ("5.1  主工作台", 2),
    ("5.2  实时事件与代码流", 2),
    ("5.3  自动测试与失败回环", 2),
    ("5.4  辅助开发工作台", 2),
    ("5.5  主控 Agent 与多文档", 2),
    ("六  测试与部署", 1),
    ("6.1  测试策略", 2),
    ("6.3  接口与场景验证", 2),
    ("6.4  部署方式", 2),
    ("6.5  性能与可靠性", 2),
    ("6.6  已知问题", 2),
    ("七  创新点说明", 1),
    ("7.1  技术创新点", 2),
    ("7.2  应用创新点", 2),
    ("八  总结与展望", 1),
    ("8.1  项目总结", 2),
    ("8.2  不足与反思", 2),
    ("附录 A  评分维度对应", 1),
    ("附录 B  关键事件与接口", 1),
]


TOC_ENTRIES = [
    ("一  项目概述", 1),
    ("1.1  项目背景与问题", 2),
    ("1.2  目标用户与使用场景", 2),
    ("1.3  产品定位", 2),
    ("二  需求分析", 1),
    ("2.1  用户需求分析", 2),
    ("2.2  功能需求", 2),
    ("2.4  范围与边界", 2),
    ("三  系统架构设计", 1),
    ("3.1  总体架构", 2),
    ("3.2  技术选型", 2),
    ("3.4  前端架构", 2),
    ("3.6  关键业务流程", 2),
    ("四  AI 技术方案", 1),
    ("4.1  模型选型与理由", 2),
    ("4.2  模型集成方式", 2),
    ("4.3  Agent 与工作流设计", 2),
    ("4.4  RAG 技术应用", 2),
    ("4.6  安全与可控性", 2),
    ("4.7  成本控制与录制回放", 2),
    ("五  核心功能实现", 1),
    ("5.1  主工作台", 2),
    ("5.3  自动测试与失败回环", 2),
    ("5.4  辅助开发工作台", 2),
    ("5.5  主控 Agent 与多文档", 2),
    ("六  测试与部署", 1),
    ("6.1  测试策略", 2),
    ("6.4  部署方式", 2),
    ("6.6  已知问题", 2),
    ("七  创新点说明", 1),
    ("7.1  技术创新点", 2),
    ("7.2  应用创新点", 2),
    ("八  总结与展望", 1),
    ("8.1  项目总结", 2),
    ("8.2  不足与反思", 2),
]


def build():
    b = Builder()
    b.cover()
    b.page_break()
    b.toc(TOC_ENTRIES)

    b.h1("一  项目概述")
    b.h2("1.1  项目背景与问题")
    b.body("大模型正在把软件开发从“补全代码”推向“自主执行任务”。但在真实的长任务里，用户面对的往往不是一个更聪明的聊天框，而是一个失控的黑盒：任务跑到第几步、正在改哪个文件、失败了没有、花了多少钱，用户都不知道。")
    b.body("现有对话式编程工具通常要求用户持续陪着走：补上下文、纠正方向、在失败后重开一轮。对于“有想法但缺少工程时间”的学生和独立开发者，这种交互把工程负担转移给了最不熟悉工程的人。")
    b.body("NexusHub 要解决的不是“少打几个字”，而是让长任务可控：", bold_prefix="NexusHub 要解决的不是")
    b.bullet("过程可见：每一道工序、每一个任务、每一段代码都有对应事件。", bold_prefix="过程可见：")
    b.bullet("失败可解释：测试失败会带回真实错误，回到开发阶段修复，而不是只显示一句“出错了”。", bold_prefix="失败可解释：")
    b.bullet("成本可核算：按模型与 token 记账，单次运行有成本上限。", bold_prefix="成本可核算：")
    b.bullet("结果可验收：最终交付不是一段代码文本，而是能启动、能被 HTTP 测试的工程。", bold_prefix="结果可验收：")
    b.body("项目把“需求分析—架构设计—自主开发—集成装配—自动测试—验收交付”固化成六道工序：外层是确定性的状态机，内层由模型完成规划、生成与检查。这样既保留 Agent 的自主性，又让流程边界、失败位置和成本可以被定位。")

    b.h2("1.2  目标用户与使用场景")
    b.body("第一类用户是计算机相关专业的学生和独立开发者：他们有明确的小型软件需求，能判断结果对不对，但缺少把需求拆成工程、写测试、部署和修错的时间。第二类用户是正在学习软件工程的学生：他们需要看见一个需求如何变成模块、文件和测试，而不是只拿到最终代码。")
    b.body("典型使用路径如下：")
    b.bullet("在项目页输入一句话需求，选择“自动开发”。", bold_prefix="自动开发：")
    b.bullet("在工作台看六道工序推进；需要确认时通过门禁回答问题；随时可以暂停或取消。", bold_prefix="过程介入：")
    b.bullet("在代码面板看文件逐个生成，在预览页打开产物，在验收页看测试结果。", bold_prefix="结果检查：")
    b.bullet("已有项目可以进入辅助开发工作台，由 AI 按六阶段陪跑，而不是重新生成一个项目。", bold_prefix="辅助开发：")
    b.body("项目不面向大型企业的多租户协作，也不承诺“任何需求都能一键生成”。当前定位是可观察、可验收的中小型 Web 软件交付，尤其是带 CRUD、接口和简单页面的任务。")

    b.h2("1.3  产品定位")
    b.body("NexusHub 的定位是“一个网页里的软件工厂”，而不是另一个代码聊天工具。它把软件工程中最重要的四个动作——拆解、实现、验证、交付——做成一条可观察的流水线，并让用户在任何一步都能看见证据。")
    b.table(
        ["能力", "当前实现", "说明"],
        [
            ["可观测", "已实现", "SSE 事件、任务树、代码流、费用、检索依据"],
            ["可预算", "已实现", "按 token 记账，运行级成本上限"],
            ["可干预", "部分实现", "暂停、取消、人工门禁；任意节点改指令尚未开放"],
            ["可恢复", "部分实现", "刷新恢复草稿与浏览状态；崩溃后续跑仍是后续工作"],
        ],
        [3.0, 3.0, 9.8],
        "表 1  产品能力与当前完成度",
    )
    b.body("这种定位带来的直接差异是：用户不需要理解每一步的 prompt，也不需要一直盯着；但需要判断时，界面会把“为什么这样做、依据是什么、失败了什么”摆出来。")

    b.h2("1.4  项目成果概览")
    b.body("当前版本已经打通一条真实链路：登录、创建运行、六道工序、SSE 实时事件、产物落库、真实进程预览、自动测试与失败回环、项目历史。前端完成 9 个页面的 Vue 3 + TypeScript 迁移，主工作台和辅助工作台都采用组件 + composable 的状态驱动结构。")
    b.table(
        ["成果项", "结果"],
        [
            ["前端", "Vue 3.5 + Vite 8 + TypeScript 5.9；src 下无 .js 文件；vue-tsc 零错误"],
            ["页面", "登录、注册、项目、设置、记忆、辅助列表、辅助工作台、欢迎、主工作台"],
            ["主链路", "六道工序、任务事件、SSE、代码流、门禁、测试回环、预览、验收"],
            ["AI 能力", "DeepSeek 调用、结构化输出、RAG、Function Calling 工具、成本台账、录制回放"],
            ["验证", "类型检查、构建、9 页控制台检查、27 张视觉截图、接口冒烟与手工路径"],
        ],
        [3.2, 12.6],
        "表 2  当前成果概览",
    )

    b.h1("二  需求分析")
    b.h2("2.1  用户需求分析")
    b.body("需求调研来自团队对身边同学与独立开发者的访谈，以及当前 AI 编程工具的使用观察。用户并不缺“生成一段代码”的能力，真正缺的是把一段代码变成一个可运行工程的确定性。")
    b.table(
        ["用户痛点", "具体表现", "对应设计"],
        [
            ["不知道该做什么", "一句话需求很模糊，生成结果经常偏题", "需求分析阶段先产出验收标准，再进入设计与开发"],
            ["过程不可见", "长任务跑到一半不知道在干什么", "SSE 事件 + 任务树 + 代码流 + 费用面板"],
            ["失败后重来", "测试失败只看到一句报错，用户自己修", "测试阶段读取真实错误，回环到开发阶段修复"],
            ["成本不可控", "不知道一次运行花多少钱", "token 记账、单价表、运行成本上限"],
            ["结果不可验证", "生成的代码没有启动过", "真实进程启动、OpenAPI 发现、HTTP/页面测试"],
        ],
        [3.2, 5.4, 7.2],
        "表 3  用户痛点与设计对应",
    )
    b.body("访谈中得到的一个关键反馈是：用户并不排斥 AI 自主执行，排斥的是“没有证据的自主”。因此界面优先展示证据：任务状态、文件内容、测试结果、检索来源和费用，而不是只展示一个“AI 正在思考”的动画。")

    b.h2("2.2  功能需求")
    b.body("按“创建—执行—观察—验收—复用”五段拆解功能需求：")
    b.table(
        ["编号", "功能", "验收口径"],
        [
            ["FR-01", "账号与项目", "注册/登录可用；项目能创建、筛选、删除；数据落 MySQL"],
            ["FR-02", "创建运行", "一句话需求创建真实运行；空需求返回错误而不是假运行"],
            ["FR-03", "六道工序", "每道工序产生任务、状态、耗时和失败原因；可从事件流恢复"],
            ["FR-04", "实时观察", "SSE 推送任务、文件、推理、检索、费用、门禁、验收事件"],
            ["FR-05", "人工门禁", "运行可暂停；问题可回答；回答后继续；取消后不再产生事件"],
            ["FR-06", "自动测试", "真实启动产物；生成 HTTP/页面用例；失败回环最多 2 轮"],
            ["FR-07", "产物预览", "预览地址可打开；进程可回收；失败有明确错误"],
            ["FR-08", "辅助开发", "已有项目按六阶段陪跑；工具调用轨迹可见；AI 记忆可引用"],
            ["FR-09", "主控新建任务", "可输入需求、上传多份文本文档、下载测试用例；开始后只读"],
            ["FR-10", "刷新恢复", "草稿、树布局、聚焦、展开、文件、页签、滚动位置可恢复"],
        ],
        [1.4, 4.0, 10.4],
        "表 4  功能需求清单",
    )

    b.h2("2.3  非功能需求")
    b.table(
        ["维度", "要求", "实现方式"],
        [
            ["可维护性", "前后端边界清晰；类型可检查；模块可替换", "FastAPI 分层 + Vue 组件/composable；strict TS；接口类型集中"],
            ["可观测性", "关键路径都有事件和日志", "SSE 事件表、运行/任务/文件/费用记录"],
            ["安全性", "密钥不落库明文；用户只能访问自己的运行", "环境变量 / 用户设置；所有权校验；路径校验"],
            ["可靠性", "模型失败、测试失败、进程退出都有兜底", "重试、超时、回环上限、失败事件、进程回收"],
            ["性能", "首屏不加载所有页面；长列表不阻塞", "Vite 多页入口、动态 import、按需渲染"],
            ["可部署性", "单机可起；不依赖外部消息队列", "FastAPI 静态托管 + MySQL + 本机进程运行时"],
        ],
        [2.4, 5.8, 7.6],
        "表 5  非功能需求",
    )
    b.body("当前版本优先保证“真实链路可解释”，没有为高并发做过度设计。单机进程运行时适合比赛演示和小规模使用，不是生产级多租户沙箱；这一边界在 6.6 节明确说明。")

    b.h2("2.4  范围与边界")
    b.body("本期明确不做以下内容，避免把未完成能力包装成卖点：")
    b.bullet("不做多模态输入：没有图片、语音、视频理解。", bold_prefix="不做多模态输入：")
    b.bullet("不做 MCP 协议：只有 Function Calling 工具；mcp_server.py 是未实现占位。", bold_prefix="不做 MCP 协议：")
    b.bullet("不做强隔离沙箱：产物在本机进程运行，已有路径/语法/超时检查，但没有容器级网络隔离。", bold_prefix="不做强隔离沙箱：")
    b.bullet("不做通用并行 Multi-Agent：主链路按依赖顺序生成文件，避免把“阶段角色”说成“并行智能体”。", bold_prefix="不做通用并行 Multi-Agent：")
    b.bullet("不做生产级集群：没有消息队列、分布式锁、跨机调度。", bold_prefix="不做生产级集群：")

    b.h1("三  系统架构设计")
    b.h2("3.1  总体架构")
    b.body("系统采用前后端分离、同源部署的结构。浏览器负责页面、交互和 SSE 渲染；FastAPI 负责认证、运行编排、模型调用、RAG、工具执行、进程预览和持久化；MySQL 保存运行、事件、任务、产物和记忆。")
    b.image(ASSETS / "architecture.png", 16.0, "图 1  NexusHub 总体架构")
    b.body("选择同源部署而不是两个独立服务，是为了减少比赛环境中的跨域、Cookie 和 SSE 配置成本。FastAPI 在挂载 API 后，按页面路径托管 Vite 构建产物；开发阶段仍可单独构建前端，最终由后端统一提供页面与接口。")

    b.h2("3.2  技术选型")
    b.table(
        ["层次", "选型", "选择理由"],
        [
            ["前端框架", "Vue 3.5", "组件化与响应式适合工作台；团队熟悉；多页构建简单"],
            ["构建", "Vite 8", "多页面入口、按页拆包、构建快；产物可直接静态托管"],
            ["语言", "TypeScript 5.9", "strict 模式约束 API、事件和组件 props；前端零 JS"],
            ["后端", "FastAPI", "类型化路由、SSE、静态托管一体化；Python 生态适合模型与进程操作"],
            ["数据库", "MySQL 8", "运行/事件/任务关系清晰；事务与索引成熟；比赛环境易部署"],
            ["实时", "SSE", "服务端单向事件足够；比 WebSocket 简单，断线重连成本低"],
            ["模型", "DeepSeek Chat", "中文与代码能力好、价格低、OpenAI 兼容接口；支持 JSON 输出"],
            ["编辑器", "CodeMirror", "轻量、可控、适合只读代码浏览与高亮"],
        ],
        [2.4, 3.6, 9.8],
        "表 6  技术选型",
    )
    b.body("没有引入 LangChain、LlamaIndex 等编排框架：本项目的核心是固定的六道工序和可验证的结构化产物，直接用 HTTP + Pydantic 更容易控制超时、重试、成本和事件。框架的抽象会增加调试成本，而当前链路的价值在“可控”，不在“支持尽可能多的链”。")

    b.h2("3.3  后端模块划分")
    b.table(
        ["模块", "职责", "关键文件"],
        [
            ["api/auth", "注册、登录、会话", "app/api/auth"],
            ["api/projects", "项目 CRUD 与所有权", "app/api/projects"],
            ["api/runs", "创建运行、事件查询、暂停/取消", "app/api/runs"],
            ["api/pipeline", "六道工序编排、事件记录、门禁", "app/api/pipeline"],
            ["api/ai", "模型客户端、结构化输出、RAG、成本", "app/api/ai"],
            ["api/assist", "辅助项目、文件、检查、教练、记忆", "app/api/assist"],
            ["api/runtime", "产物进程启动、健康检查、回收", "app/api/runtime"],
            ["api/tools", "产物文件读写与路径校验", "app/api/tools"],
            ["db / migrations", "ORM 模型与 Alembic 迁移", "app/db, migrations"],
        ],
        [3.4, 7.8, 5.6],
        "表 7  后端模块",
    )

    b.h2("3.4  前端架构")
    b.body("前端是 9 个页面的多页 Vite 应用，而不是把所有页面塞进一个 SPA。每个页面有独立入口，欢迎页和工作台脚本按需动态加载；工作台内部再按“状态—数据—视图”拆分。")
    b.table(
        ["层", "职责", "代表文件"],
        [
            ["页面壳", "挂载 Vue 应用、页面级布局", "src/*/main.ts, WorkbenchApp.vue"],
            ["状态", "运行、任务、文件、门禁、依据、页签", "useWorkbenchStore.ts"],
            ["数据", "SSE、事件去重、速度队列、run 快照", "useWorkbenchRun.ts"],
            ["模型", "任务/文件/代码流、阶段、费用", "workbenchModel.ts"],
            ["布局", "树节点、SVG 路径、聚焦/排布", "useWorkbenchTree.ts, CanvasPanel.vue"],
            ["组件", "任务、代码、详情、门禁、主控对话框", "src/workbench/components/*"],
        ],
        [2.4, 8.2, 6.2],
        "表 8  前端分层",
    )
    b.body("主工作台的关键边界是：UI 只消费 store，不直接拼 DOM；SSE 数据层只写 store 和模型，不操作视图；树布局是纯函数。这样刷新、重播和测试都可以复用同一份状态。")

    b.h2("3.5  数据与事件模型")
    b.body("运行是聚合根。一次运行包含六道工序、多个任务、多个产物文件、事件流和费用记录。事件是前端恢复现场的唯一事实来源：页面刷新后，先读运行快照，再重放历史事件，最后订阅新的 SSE。")
    b.table(
        ["对象", "关键字段", "用途"],
        [
            ["Run", "id, prompt, stage, status, totalCostCny", "运行快照与项目列表"],
            ["Task", "id, stage, title, state, file, ms", "任务树与详情"],
            ["Artifact/File", "path, lang, content/lines", "代码面板与产物预览"],
            ["RunEvent", "seq, kind, payload, createdAt", "SSE、回放、恢复"],
            ["Memory", "content, source, citations", "辅助开发的长期上下文"],
        ],
        [3.0, 7.8, 5.8],
        "表 9  核心数据对象",
    )
    b.body("事件类型覆盖运行的关键动作：")
    b.table(
        ["事件", "作用"],
        [
            ["phase / reasoning / text", "阶段变化、模型思考摘要、文本增量"],
            ["task", "任务创建、开始、完成、失败"],
            ["file", "文件增量、完成、路径与语言"],
            ["retrieval", "RAG 查询与命中来源"],
            ["cost / usage", "费用与模型调用次数"],
            ["gate / gate.answered", "人工门禁与回答"],
            ["check / verdict", "测试结果与验收汇总"],
            ["artifact / error", "产物生成与失败原因"],
        ],
        [4.2, 12.4],
        "表 10  事件类型",
    )

    b.h2("3.6  关键业务流程")
    b.body("一次自动开发运行的完整时序如下：用户在项目页提交一句话需求；后端创建 Run 并交给编排器；编排器依次执行 spec、design、build、assemble、test、deliver；每道工序写任务和事件；前端通过 SSE 增量消费。测试阶段启动产物进程，读取 OpenAPI，生成并执行用例；失败时把错误带回 build 阶段修复，再复测，最多 2 轮。")
    b.image(ASSETS / "pipeline.png", 16.0, "图 2  六道工序与测试回环")

    b.h1("四  AI 技术方案")
    b.body("本章按比赛要求，重点说明 AI 技术的选型理由、集成方式和优化策略。所有描述对应仓库中的真实实现；没有实现的能力会在 4.8 节明确列出。")

    b.h2("4.1  模型选型与理由")
    b.body("当前默认模型是 DeepSeek Chat。选择它有三个直接原因：第一，中文需求理解和代码生成质量稳定，适合“中文一句话 → 结构化规格/代码”的场景；第二，价格低，适合比赛演示和多次回环；第三，接口兼容 OpenAI 风格，模型客户端可以在不改业务代码的情况下替换 base_url 和 model。")
    b.body("模型层没有把供应商写死在业务里：app/api/ai/factory.py 根据阶段返回模型名，build_client() 统一创建客户端；MODEL_DECIDE 与 MODEL_EXECUTE 可分别配置。需要说明的是，当前默认两者都是 deepseek-chat，这不是“双模型路由”，只是保留了按阶段替换模型的接口。")
    b.table(
        ["选型问题", "选择", "理由与代价"],
        [
            ["为什么不用多模型", "当前单供应商", "减少密钥与账单复杂度；代价是缺少跨模型对比数据"],
            ["为什么不用本地模型", "云端 API", "代码生成质量与速度更稳；代价是依赖网络和费用"],
            ["为什么保留用户 Key", "用户设置可覆盖", "评审/演示可用自己的额度；代价是密钥管理需谨慎"],
            ["为什么不用 LangChain", "直接 HTTP + Pydantic", "控制超时、重试、结构化校验和事件更直接"],
        ],
        [4.4, 4.2, 8.0],
        "表 11  模型与框架选型",
    )

    b.h2("4.2  模型集成方式")
    b.body("模型集成分为四层：Prompt 组装、结构化输出、调用记录、错误处理。业务阶段只描述“输入什么、要什么结构”，不直接拼接供应商协议。")
    b.body("Prompt 组装由阶段 system prompt、技能块、上游结构化产物和用户需求组成。spec 阶段输出验收标准，design 阶段读取 spec 并输出模块/文件契约，build 阶段按依赖顺序逐文件生成。每一层都限制上下文长度，避免把整个工程反复塞进模型。")
    b.body("结构化输出使用 Pydantic 模型和 JSON 解析。模型返回不符合 schema 时，客户端抛出可读错误；阶段可以重试一次。build 阶段还做确定性校验：Python 语法、SQL 可执行性、HTML 结构、Markdown 围栏、TODO 占位和全角竖线。只有通过校验的文件才写入产物目录。")
    b.code('{\n  "modules": [\n    {"id": "api", "responsibility": "任务接口", "files": ["api/main.py"],\n     "depends_on": ["db"], "covers": ["a1", "a2"]}\n  ],\n  "entry": "api/main.py"\n}')
    b.caption("代码 1  架构阶段的结构化产物示意（节选）")

    b.h2("4.3  Agent 与工作流设计")
    b.body("主链路采用“确定性外层 + 概率性内层”的结构：外层是纯代码状态机，决定下一道工序、是否回环、是否停止；内层由模型完成规划、生成和检查。这样做的原因是，软件交付的步骤和验收边界相对稳定，不需要让模型每一步都重新决定“下一步做什么”；而具体实现又必须允许模型自主。")
    b.table(
        ["工序", "输入", "模型任务", "输出/校验"],
        [
            ["01 需求分析", "用户 prompt + RAG 规范", "澄清边界、生成验收标准", "SpecV2；验收项可枚举"],
            ["02 架构设计", "SpecV2 + RAG 规范", "拆模块、文件、依赖", "ArchV2；模块覆盖验收项"],
            ["03 自主开发", "模块契约 + 已有文件", "逐文件生成完整内容", "FILE 格式；语法/SQL/HTML 校验"],
            ["04 集成装配", "文件清单 + 入口", "补入口、依赖、运行配置", "可启动工程；端口与入口"],
            ["05 自动测试", "验收标准 + 真实路由", "生成 HTTP/页面用例", "启动产物；执行；失败回环"],
            ["06 验收交付", "测试结果 + 产物", "汇总与交付说明", "Verdict、预览地址、摘要"],
        ],
        [2.6, 4.0, 4.8, 5.2],
        "表 12  六道工序的输入输出",
    )
    b.body("任务层把每道工序拆成可观察的节点：任务创建、开始、完成、失败都有事件，前端按事件渲染任务树。文件是一个独立任务节点，流式增量通过 file 事件发送；前端只追加增量，不重新请求整个文件。")
    b.body("辅助开发侧另有一个真正的工具调用循环：模型可以选择 list_files、read_file、check_syntax、search_knowledge，读取结果后再决定是否继续调用；最多 6 步，工具轨迹回传前端。这不是主链路的“固定六阶段”，而是面向已有项目的分析 Agent。")

    b.h2("4.4  RAG 技术应用")
    b.body("RAG 用于 spec 和 design 两个阶段，目标不是让模型“知道更多事实”，而是把团队的开发规范带进规划：验收标准怎么写、API 契约怎么定、模块怎么拆、页面如何 fetch、SQL schema 如何设计、测试如何交付。")
    b.body("检索实现是本地混合检索：把中文按 2-gram/3-gram 哈希到 256 维向量，再做余弦相似度；同时计算字符 n-gram 的词面重合。最终分数为 0.65 × 向量相似度 + 0.35 × 词面匹配，取 top 4。这个方案不依赖外部 embedding API，向量可复现，适合比赛环境的离线与低成本要求。")
    b.body("语料位于 源码/RAG-knowledge/，当前 8 篇 Markdown，覆盖验收标准、API 契约、前端 fetch、模块拆分、SQL schema、测试交付等主题。命中结果通过 retrieval 事件写入运行记录，工作台显示来源、摘要和命中条数。")
    b.quote("当前边界：RAG 链路真实存在，但还没有建立人工标注的评测集，因此本文不宣称 hit@3 或召回率提升；这是下一阶段要补的实验。")

    b.h2("4.5  工具调用与 MCP 边界")
    b.body("工具集成使用模型的原生 Function Calling：辅助 Agent 可读取项目文件、检查语法、检索开发规范，工具结果作为 tool message 回填，再由模型决定下一步。前端展示每次工具调用的参数、结果和耗时，避免“AI 说它看了文件”但没有证据。")
    b.body("本项目没有实现 MCP 协议。backend/mcp_server.py 是一个明确返回失败的占位文件，而不是假装启动的服务。比赛文档把“Function Calling 工具”与“MCP”分开写，避免把前者冒充后者。")

    b.h2("4.6  安全与可控性")
    b.body("AI 安全分四层：输入边界、输出校验、执行边界、人工兜底。当前实现覆盖了其中大部分基础项，但不是生产级沙箱。")
    b.table(
        ["层次", "已实现", "尚未实现"],
        [
            ["输入边界", "用户/项目所有权校验；Prompt 中区分系统指令与用户需求", "提示注入检测、文档内容隔离策略"],
            ["输出校验", "Pydantic schema；Python 语法；SQL 执行；HTML 结构；TODO/围栏检查", "更完整的静态安全扫描、依赖漏洞扫描"],
            ["执行边界", "固定工作区、路径校验、进程超时/终止、端口动态分配", "容器级网络隔离、CPU/内存配额、系统调用限制"],
            ["人工兜底", "暂停、取消、人工门禁；回环上限 2 轮；失败事件", "任意节点改指令、从节点重跑"],
        ],
        [2.6, 7.2, 6.8],
        "表 13  AI 安全与可控性",
    )
    b.body("这些边界是有意暴露的：比赛评审可以看到哪些是工程约束，哪些是尚未完成。把“没有沙箱”写成“安全可控”会失去可信度。")

    b.h2("4.7  成本控制与录制回放")
    b.body("成本控制由三部分组成：单价表、token 记账、运行级上限。单价按 DeepSeek 公开价估算，区分峰谷；金额单位是元/百万 token。每次模型调用记录 prompt/completion token 和费用，累计到运行。RUN_COST_LIMIT_CNY 默认 5 元，超过上限抛出预算错误，避免长任务无限烧钱。")
    b.table(
        ["模型", "输入（峰/谷）", "输出（峰/谷）", "用途"],
        [
            ["deepseek-chat", "2 / 1 元·百万 token", "8 / 4 元·百万 token", "当前默认规划与执行"],
            ["deepseek-reasoner", "4 / 2 元·百万 token", "16 / 8 元·百万 token", "预留，未默认启用"],
        ],
        [3.8, 4.2, 4.2, 5.0],
        "表 14  成本单价（估算，实际以厂商账单为准）",
    )
    b.body("录制回放用于稳定演示与回归：模型客户端支持 off / record / replay 三种模式，回放读取 backend/data/cassettes 中按请求哈希命名的 JSON。它让同一输入可以重复得到同一模型输出，便于排查是编排问题还是模型波动；回放内容来自真实录制，不是手写假数据。")

    b.h2("4.8  优化策略与当前限制")
    b.body("已采用的优化策略：")
    b.bullet("阶段化 Prompt：只给当前阶段需要的信息，减少上下文膨胀。", bold_prefix="阶段化 Prompt：")
    b.bullet("结构化契约：用 schema 约束下游输入，减少“看起来对、拼不起来”。", bold_prefix="结构化契约：")
    b.bullet("确定性校验：语法、SQL、HTML、TODO、围栏在写盘前拦截。", bold_prefix="确定性校验：")
    b.bullet("回环上限：测试失败最多修 2 轮，超过就失败，不无限重试。", bold_prefix="回环上限：")
    b.bullet("本地 RAG：不依赖外部 embedding，降低费用与网络抖动。", bold_prefix="本地 RAG：")
    b.bullet("按需加载：前端多页入口，工作台脚本动态 import。", bold_prefix="按需加载：")
    b.body("当前明确没有做的能力：多模态输入、MCP 协议、强隔离沙箱、并行 Multi-Agent、RAG 量化评测、完整后端测试套件。这些限制在第六、八章继续展开。")

    b.h1("五  核心功能实现")
    b.h2("5.1  主工作台")
    b.body("主工作台把一次运行拆成四个区域：左侧任务清单，中间任务树，右侧代码/预览/验收，底部事件与费用。任务树不是装饰图，它的节点来自真实任务与文件事件；点击阶段可以聚焦，点击任务可以打开详情，点击文件可以切换代码。")
    b.image(ASSETS / "workbench-crop.png", 16.0, "图 3  主工作台：任务树、代码流、费用与事件")
    b.body("工作台的状态由 useWorkbenchStore 集中管理，SSE 由 useWorkbenchRun 消费，树布局由 useWorkbenchTree 的纯函数计算。刷新时先加载 run 快照，再重放历史事件，最后恢复用户的树布局、聚焦、展开、当前文件和页签。")

    b.h2("5.2  实时事件与代码流")
    b.body("SSE 使用标准 text/event-stream，事件按 seq 递增。前端对重复事件去重，并按播放速度排队；速度只影响呈现，不影响后端。代码事件按 400 字符分片，前端逐行追加并高亮，文件写完时标记任务完成。")
    b.body("回放分为“全部重播”和“单文件重播”：全部重播会清空任务与文件，再按历史事件重放；单文件重播只重置一个文件。这个能力让演示不必现场等一次完整生成，也方便排查某次生成的中间状态。")

    b.h2("5.3  自动测试与失败回环")
    b.body("测试阶段不是让模型“声称测试通过”。它会真实启动产物进程，等待 HTTP 可用，读取 /openapi.json 获取真实路由和字段，再生成 http/page 用例并执行。断言以状态码和 JSON 字段为主，避免模型编造路径。")
    b.body("失败时，测试阶段把真实错误、失败用例和修复建议带回 build 阶段；build 重新生成相关文件，assemble 重新装配，test 再跑。回环最多 2 轮，超过上限就产出明确的失败结果，不把失败包装成成功。")

    b.h2("5.4  辅助开发工作台")
    b.body("辅助开发面向“用户自己写代码，AI 陪跑”的场景。它有自己的六阶段、项目文件、代码检查、AI 教练、测试用例和记忆。AI 教练通过工具读取项目文件、检查语法、检索知识，再给出结论和下一步；工具轨迹在前端可见。")
    b.image(ASSETS / "assist-workspace.png", 15.6, "图 4  辅助开发工作台：阶段、代码与 AI 教练")
    b.body("记忆只在辅助开发注入，不进入主工作流。这样做的原因是：主工作流的产物需要可复现，个人偏好不应悄悄改变规格；辅助开发更需要“记住上次的约定”。这是有意的产品边界，不是遗漏。")

    b.h2("5.5  主控 Agent 与多文档")
    b.body("点击主工作台的“主控 Agent”节点会打开新建任务对话框。用户可以输入需求、一次选择或拖入多份文本/代码文档；文档在浏览器内读取正文，按 ===== 文档：文件名 ===== 边界合并进 prompt。对话框还内置一份可下载的全流程测试用例，下载后自动加入文档列表。")
    b.image(ASSETS / "main-agent-dialog.png", 15.6, "图 5  主控 Agent：需求、文档与内置测试用例")
    b.body("任务开始后，主控对话框变为只读：只展示已提交的需求和文档，不允许编辑或再次创建。未提交的草稿写入 localStorage，刷新或关闭后可恢复；创建成功后清除草稿。已提交内容随 Run.prompt 落库。")

    b.h2("5.6  项目、记忆与设置")
    b.body("项目页展示运行历史、状态、成本与产物入口；设置页管理模型 Key、主题和运行参数；记忆页展示 AI 沉淀的偏好与引用次数。登录使用 argon2id 哈希和 7 天会话，所有运行接口校验用户所有权。")

    b.h1("六  测试与部署")
    b.h2("6.1  测试策略")
    b.body("测试分四层：类型与构建、页面级视觉回归、接口冒烟、真实场景手工路径。当前没有把后端 pytest 套件补齐，因此本文不写“全部测试通过”；只写实际执行过的检查。")

    b.h2("6.2  前端验证")
    b.table(
        ["检查", "方法", "结果"],
        [
            ["类型检查", "pnpm typecheck（vue-tsc --noEmit，strict）", "0 errors"],
            ["构建", "pnpm build（Vite 多页）", "成功，产物写入 web/vue-dist"],
            ["页面控制台", "headless Edge 逐页打开 9 个页面", "0 异常，无 404/500"],
            ["视觉回归", "1440/1920/390 三尺寸截图与基线比对", "27 张同尺寸；迁移期 26 张字节一致"],
            ["关键交互", "工作台/辅助工作台手工路径", "树聚焦、文件切换、门禁、主控对话框通过"],
        ],
        [3.0, 7.8, 5.4],
        "表 15  前端验证",
    )
    b.body("唯一已知视觉差异是欢迎页 1920 的卡片动画帧；工作台树垂直居中是后续有意调整，因此不把旧基线当作当前像素承诺。")

    b.h2("6.3  接口与场景验证")
    b.table(
        ["路径", "验证内容", "结果"],
        [
            ["登录", "管理员登录、Cookie 会话", "通过"],
            ["创建运行", "真实 prompt 创建 Run，返回 id", "通过"],
            ["事件读取", "历史事件按 seq 返回", "通过"],
            ["主控创建", "对话框提交后创建运行并跳转", "通过（测试运行已清理）"],
            ["多文档", "两份文档合并进 prompt，边界保留", "通过"],
            ["暂停/取消", "运行状态切换、取消后停止", "通过"],
            ["预览/门禁", "页面层手工检查；未做完整自动化", "部分覆盖"],
        ],
        [3.2, 8.4, 4.6],
        "表 16  接口与场景验证",
    )

    b.h2("6.4  部署方式")
    b.body("本地部署只需要 MySQL 8、Python 3.12 和可选的 Node.js。后端通过 .env 配置数据库与模型密钥，执行 alembic upgrade head 建表，uvicorn app.main:app 启动；前端构建产物由 FastAPI 在 / 托管。")
    b.body("产物运行时使用本机进程：动态端口、固定工作区、日志写入 _runtime.log、健康检查失败或任务结束后终止。该方式适合比赛演示，但不是强隔离方案；生产部署应替换为容器或受限进程，并加网络与资源限制。")

    b.h2("6.5  性能与可靠性")
    b.body("前端采用多页入口和动态 import，首页不加载工作台与欢迎页脚本；工作台代码按文件增量渲染，不做全量重绘。当前没有做 Lighthouse、首屏时间或并发压测，因此不给出未经验证的性能数字。")
    b.body("可靠性主要靠四道兜底：模型调用超时与重试、阶段校验失败重试、测试回环上限、进程超时终止。失败会写入 error 事件并在界面展示，而不是静默卡住。")

    b.h2("6.6  已知问题")
    b.bullet("后端 pytest 套件未补齐，当前以接口冒烟和手工路径为主。", bold_prefix="后端 pytest 套件未补齐：")
    b.bullet("没有公网部署、在线演示地址与评审专用账号。", bold_prefix="没有公网部署：")
    b.bullet("没有多模态、MCP、强隔离沙箱与并行 Multi-Agent。", bold_prefix="能力边界：")
    b.bullet("RAG 没有 hit@3 评测，成本数据来自估算而非完整账单。", bold_prefix="缺少量化：")
    b.bullet("长任务在浏览器断网/后端重启后的续跑尚未完成。", bold_prefix="恢复能力有限：")

    b.h2("6.7  验证结论")
    b.body("从现有验证看，核心链路已经可运行：可以创建真实运行、接收事件、展示文件与费用、执行测试并在失败时回环；前端可以构建、类型检查通过，9 个页面无控制台异常。它还不是生产级系统，但已经具备可演示、可排查、可继续迭代的完整骨架。")
    b.body("更重要的是边界已经说清楚：哪些能力是真实实现，哪些仍是占位或后续工作，都能在代码、事件和文档中找到对应。对参赛作品而言，这种可核对性比“功能列表看起来很多”更有价值。")
    b.table(
        ["结论", "依据"],
        [
            ["核心链路可运行", "创建运行、SSE 事件、测试回环、预览与项目历史均已走通"],
            ["前端可维护", "src 下无 JS、vue-tsc 零错误、组件/composable 分层、多页构建"],
            ["边界清楚", "多模态、MCP、强隔离沙箱、RAG 评测未完成的地方均明确标注"],
        ],
        [4.2, 11.6],
        "表 17  验证结论",
    )
    b.body("后续最需要补的不是界面，而是可复现证据：一条完整运行、一组后端测试、一份 RAG 评测和公网演示。这些证据会同时提升实用性、技术深度和答辩可信度。")

    b.h1("七  创新点说明")
    b.body("本章按比赛要求，明确区分技术创新点与应用创新点。创新点均对应仓库中的真实机制；没有把常规工程实践包装成“首创”。")
    b.h2("7.1  技术创新点")
    b.body("技术创新点一：确定性外层 + 概率性内层的软件交付状态机。", bold_prefix="技术创新点一：")
    b.body("把六道工序固化成可验证的状态机，每道工序只暴露结构化契约；模型在工序内部自主规划、生成和检查。与“让 Agent 自由决定下一步”相比，这种结构让失败位置可定位、成本可预算、下游可校验，也让前端能够稳定地画出任务树。")
    b.body("技术创新点二：真实进程 + OpenAPI 驱动的测试回环。", bold_prefix="技术创新点二：")
    b.body("测试不是模型自评，而是启动产物、读取真实 OpenAPI、生成 http/page 用例并执行；失败错误回流到开发阶段修复。它把“生成代码”推进到“生成可运行、被验证的工程”，并用真实错误而不是模型猜测驱动下一轮。")
    b.body("技术创新点三：全过程事件化与可回放。", bold_prefix="技术创新点三：")
    b.body("任务、文件、推理、检索、费用、门禁、验收都进入同一事件流；前端可以实时消费，也可以从历史事件恢复/回放。事件既是 UI 数据源，也是调试与验收证据。")
    b.body("技术创新点四：本地混合 RAG 与阶段契约结合。", bold_prefix="技术创新点四：")
    b.body("用本地 2/3-gram 哈希向量 + 词面匹配做可复现检索，把开发规范注入 spec/design；检索命中作为事件进入工作台。它不是“外挂知识库”，而是影响阶段产物的上下文。")

    b.h2("7.2  应用创新点")
    b.body("应用创新点一：把 AI 的过程做成可操作的工作台。", bold_prefix="应用创新点一：")
    b.body("用户看到的不是一条聊天记录，而是任务树、代码流、参考依据、费用、门禁和验收页。可以聚焦某道工序、打开某个任务、回看某个文件；这让“AI 在做什么”从叙述变成可检查的界面。")
    b.body("应用创新点二：自动开发 + 辅助开发的双模式。", bold_prefix="应用创新点二：")
    b.body("自动模式面向“从零交付”，辅助模式面向“已有项目陪跑”。两者共享六阶段语言和证据展示，但上下文、工具和记忆注入不同。用户不必在“全自动”与“纯聊天”之间二选一。")
    b.body("应用创新点三：降低冷启动成本的主控入口。", bold_prefix="应用创新点三：")
    b.body("主控 Agent 支持多文档、可下载测试用例、草稿恢复和开始后只读。没有现成需求的用户可以直接下载测试用例跑通全流程；有开发文档的用户可以把文档一起提交。它把“第一次使用”从写一段好 prompt 变成一次可完成的操作。")

    b.h2("7.3  与同类产品的差异")
    b.table(
        ["维度", "对话式编程工具", "通用工作流平台", "NexusHub"],
        [
            ["主要交互", "聊天/补全", "拖拽编排", "任务树 + 代码流 + 门禁"],
            ["交付物", "代码片段/补丁", "可配置流程", "可启动、被测试的工程"],
            ["失败处理", "用户自己读错误", "由用户配置", "真实错误回流修复，最多 2 轮"],
            ["过程证据", "以对话为主", "以节点日志为主", "任务/文件/检索/费用/验收同一事件流"],
            ["使用门槛", "需要会写 prompt", "需要会搭流程", "一句话或一份文档即可开始"],
        ],
        [3.0, 4.6, 4.4, 5.0],
        "表 18  差异化对比",
    )
    b.body("这不是说同类产品做不到这些能力，而是本项目的取舍更偏向“可观察的软件交付”，而不是“尽可能自由的 Agent”或“尽可能通用的流程编排”。")

    b.h1("八  总结与展望")
    b.h2("8.1  项目总结")
    b.body("NexusHub 已经完成一条可运行的真实链路：从一句话需求创建运行，六道工序推进，SSE 实时展示任务与代码，自动测试并在失败时回环修复，最终给出可预览的产物。前端完成 9 页 Vue 3 + TypeScript 迁移，工作台状态化、可恢复；后端完成运行、门禁、RAG、工具、成本和预览。")
    b.body("项目最大的价值不是“AI 会写代码”，而是把 AI 写代码的过程变成可观察、可验收、可解释的工程流程。它让用户知道 AI 做到了哪一步、依据是什么、失败在哪里，而不是只拿到一个看起来能跑的答案。")

    b.h2("8.2  不足与反思")
    b.body("当前最明显的不足是能力覆盖不均衡：Agent 工作流、RAG、工具调用和前端体验已经比较完整，但多模态、MCP、强隔离沙箱和 RAG 量化评测仍然缺失；后端测试套件没有补齐，公网演示和提交材料也还未完成。")
    b.body("另一个反思是“通用”与“可验收”的矛盾。把定位收窄到中小型 Web 软件交付后，流程和测试更容易做实；但用户仍会拿更复杂的项目来试。下一步需要在“扩大适用范围”和“保持可验收”之间继续取舍，而不是简单增加功能。")

    b.h2("8.3  后续规划")
    b.table(
        ["优先级", "方向", "目标"],
        [
            ["P0", "公网部署与演示数据", "评审可打开完整运行；提供体验账号"],
            ["P0", "后端测试与 RAG 评测", "pytest 覆盖核心路径；hit@3 对比表"],
            ["P1", "沙箱与安全", "容器/受限进程、网络与资源限制、注入防护"],
            ["P1", "MCP 适配", "把文件/检查/预览工具暴露为 MCP 服务"],
            ["P2", "多模态", "截图/设计稿输入，生成页面结构"],
            ["P2", "并行与恢复", "独立模块并行生成；断点续跑"],
        ],
        [2.0, 5.0, 9.2],
        "表 19  后续规划",
    )
    b.body("短期最重要的不是再增加一个 AI 功能，而是把已有能力变成可复现的证据：一条完整运行、一组测试结果、一份 RAG 评测、一段可演示的视频。技术文档和创新点只有在这些证据成立时才有说服力。")

    b.h1("附录 A  评分维度对应")
    b.table(
        ["评分维度", "本项目对应证据", "当前状态"],
        [
            ["大模型集成 8%", "DeepSeek 调用、结构化输出、成本台账、录制回放、用户 Key", "已实现"],
            ["Agent/工作流 8%", "六道工序、任务事件、门禁、测试回环、辅助工具循环", "已实现，顺序流水线"],
            ["RAG 6%", "本地混合检索、8 篇规范、retrieval 事件、参考依据", "已实现，未评测"],
            ["多模态 5%", "无图片/语音/视频输入", "未实现"],
            ["AI 安全 4%", "门禁、schema、路径/语法/SQL 检查、回环上限", "部分实现"],
            ["MCP/工具 4%", "Function Calling 工具与轨迹；无 MCP", "部分实现"],
            ["创新性 25%", "过程可见、真实回环、双模式、主控入口", "有差异化，需数据"],
            ["前端工程 10%", "Vue3 + TS strict、组件/composable、多页按需加载", "已实现"],
            ["实用性 10%", "一句话到可运行产物；真实测试与预览", "已实现，缺公网演示"],
            ["用户体验 10%", "任务树、代码流、门禁、依据、草稿/刷新恢复", "已实现"],
            ["社会/商业 10%", "降低学生/独立开发者交付门槛", "方向明确，缺量化"],
        ],
        [3.8, 9.8, 4.0],
        "表 20  评分维度对应",
    )

    b.h1("附录 B  关键事件与接口")
    b.table(
        ["接口/事件", "说明"],
        [
            ["POST /api/runs", "创建运行，返回 run id"],
            ["GET /api/runs/{id}/stream", "SSE 事件流"],
            ["GET /api/runs/{id}/events", "历史事件"],
            ["POST /api/runs/{id}/pause|resume|cancel", "暂停、继续、取消"],
            ["GET/POST /api/runs/{id}/gate", "读取/回答人工门禁"],
            ["GET /api/runs/{id}/runtime", "产物预览地址"],
            ["GET /api/runs/{id}/verdict", "验收结果"],
            ["file 事件", "path, lang, delta, done, replace"],
            ["retrieval 事件", "query, hits[{source,snippet,score}]"],
            ["gate 事件", "round, questions[{id,text,type,options}]"],
        ],
        [7.2, 10.0],
        "表 21  关键接口与事件",
    )

    b.save()
    print(f"saved {OUT}")
    print(f"outline entries {len(OUTLINE)}")


if __name__ == "__main__":
    build()