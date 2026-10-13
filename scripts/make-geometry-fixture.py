#!/usr/bin/env python3
"""
生成「三段 × 三行」的真实 PDF，并导出 pymupdf 的行级 bbox。

用途：给 `scripts/verify-text-layer-geometry.mjs` 提供**真实**的几何输入。
手写矩形测不出坐标系换算的错，也测不出「pdf.js 的文本项粒度」与
「pymupdf 的行粒度」是否真的对得上 —— 而后者正是切段正确的前提。

版式刻意做成「段间距 > 行间距」，这样任何按行距猜段落的启发式都可能出错；
真算法（行 bbox 中心点命中）则应当稳。

输出：
  /tmp/marker-check/three-paras.pdf
  /tmp/marker-check/lines.json   —— [{ "text": ..., "rect": {...} }]，每 block 一组
"""
import json
import os

import fitz

OUT_DIR = "/tmp/marker-check"
PDF_PATH = os.path.join(OUT_DIR, "three-paras.pdf")
LINES_PATH = os.path.join(OUT_DIR, "lines.json")

PARAGRAPHS = [
    [
        "Alpha paragraph one line one with enough words to span.",
        "Alpha paragraph one line two continues the same thought.",
        "Alpha paragraph one line three ends this first paragraph.",
    ],
    [
        "Bravo paragraph two line one starts a brand new block.",
        "Bravo paragraph two line two has different content here.",
        "Bravo paragraph two line three closes the second one.",
    ],
    [
        "Charlie paragraph three line one is the third distinct unit.",
        "Charlie paragraph three line two also belongs to third.",
        "Charlie paragraph three line three is the very last line.",
    ],
]

PAGE_WIDTH = 595
PAGE_HEIGHT = 842
LEFT = 60
FONT_SIZE = 11
LINE_GAP = 14
PARA_EXTRA_GAP = 22


def build_pdf() -> fitz.Document:
    doc = fitz.open()
    page = doc.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    y = 100
    for paragraph in PARAGRAPHS:
        for line in paragraph:
            page.insert_text((LEFT, y), line, fontsize=FONT_SIZE)
            y += LINE_GAP
        # 段间距：让最后一行与下一段首行之间留出更大的空白。
        y += PARA_EXTRA_GAP - LINE_GAP
    doc.save(PDF_PATH)
    return doc


def export_lines() -> list:
    """导出每个 block 的行级 bbox，按 block 分组。

    分组是必须的：`PdfReadingBlock.lines` 就是「一个 block 的所有行」，
    验证端要按 block 逐个调用切段函数，才能验出「段落 = block」这条性质。
    """
    doc = fitz.open(PDF_PATH)
    page = doc[0]
    page_width = page.rect.width
    page_height = page.rect.height
    blocks = []
    for block in page.get_text("dict")["blocks"]:
        lines = []
        for line in block.get("lines", []):
            x0, y0, x1, y1 = (float(v) for v in line["bbox"])
            text = "".join(span["text"] for span in line.get("spans", []))
            lines.append(
                {
                    "text": text,
                    # 归一化到 0–1，与 PdfReadingLine.rect 同一坐标系。
                    "rect": {
                        "x": x0 / page_width,
                        "y": y0 / page_height,
                        "width": (x1 - x0) / page_width,
                        "height": (y1 - y0) / page_height,
                    },
                }
            )
        if lines:
            blocks.append(lines)
    doc.close()
    return blocks


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    build_pdf().close()
    blocks = export_lines()
    with open(LINES_PATH, "w", encoding="utf-8") as handle:
        json.dump(blocks, handle, ensure_ascii=False, indent=2)
    total_lines = sum(len(block) for block in blocks)
    print(f"PDF: {PDF_PATH}")
    print(f"行级 bbox: {LINES_PATH}（{len(blocks)} 个 block / {total_lines} 行）")


if __name__ == "__main__":
    main()
