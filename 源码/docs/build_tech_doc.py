# -*- coding: utf-8 -*-
"""创建技术文档空模板。内容等用户指令后再填写。"""

from pathlib import Path

from docx import Document
from docx.shared import Cm


def main() -> None:
    target = Path(__file__).with_name("NexusHub-技术文档.docx")
    document = Document()
    section = document.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(2.54)
    section.right_margin = Cm(2.54)
    document.core_properties.title = "NexusHub 技术文档"
    document.core_properties.subject = "传智杯 AI WEB 网页开发挑战赛"
    document.save(target)
    print(target)


if __name__ == "__main__":
    main()