#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

import fitz


TEXT_RE = re.compile(r"<text[\s>]", re.IGNORECASE)
PATH_RE = re.compile(r"<path[\s>]", re.IGNORECASE)
IMAGE_RE = re.compile(r"<image[\s>]", re.IGNORECASE)
SHAPE_RE = re.compile(r"<(rect|circle|ellipse|polygon|polyline|line)[\s>]", re.IGNORECASE)


@dataclass
class PageMetric:
    pdf: str
    page_no: int
    output_svg: str
    text_count: int
    path_count: int
    shape_count: int
    image_count: int
    vector_count: int
    vector_ratio: float
    raster_area_ratio: float
    weighted_vector_ratio: float
    grade: str
    weighted_grade: str
    svg_size_bytes: int


def grade_from_ratio(vector_ratio: float) -> str:
    if vector_ratio >= 0.95:
        return "A"
    if vector_ratio >= 0.75:
        return "B"
    if vector_ratio >= 0.45:
        return "C"
    return "D"


def analyze_svg(svg: str) -> tuple[int, int, int, int, int, float, str]:
    text_count = len(TEXT_RE.findall(svg))
    path_count = len(PATH_RE.findall(svg))
    shape_count = len(SHAPE_RE.findall(svg))
    image_count = len(IMAGE_RE.findall(svg))
    vector_count = text_count + path_count + shape_count
    total = vector_count + image_count
    ratio = (vector_count / total) if total else 1.0
    return text_count, path_count, shape_count, image_count, vector_count, ratio, grade_from_ratio(ratio)


FLOAT_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _parse_float(value: str | None, default: float = 0.0) -> float:
    if not value:
        return default
    match = FLOAT_RE.search(value)
    if not match:
        return default
    try:
        return float(match.group(0))
    except ValueError:
        return default


def estimate_raster_area_ratio(svg: str) -> float:
    try:
        root = ET.fromstring(svg)
    except ET.ParseError:
        return 0.0

    view_box = root.attrib.get("viewBox", "")
    vb_numbers = [float(v) for v in FLOAT_RE.findall(view_box)] if view_box else []
    if len(vb_numbers) >= 4 and vb_numbers[2] > 0 and vb_numbers[3] > 0:
        page_width = vb_numbers[2]
        page_height = vb_numbers[3]
    else:
        page_width = _parse_float(root.attrib.get("width"), 0.0)
        page_height = _parse_float(root.attrib.get("height"), 0.0)

    if page_width <= 0 or page_height <= 0:
        return 0.0

    page_area = page_width * page_height
    image_area = 0.0
    for node in root.iter():
        if node.tag.lower().endswith("image"):
            width = _parse_float(node.attrib.get("width"), 0.0)
            height = _parse_float(node.attrib.get("height"), 0.0)
            if width > 0 and height > 0:
                image_area += width * height

    ratio = image_area / page_area if page_area > 0 else 0.0
    return max(0.0, min(1.0, ratio))


def create_synthetic_input_pdfs(output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []

    vector_pdf = output_dir / "synthetic-vector.pdf"
    doc = fitz.open()
    page = doc.new_page(width=900, height=1200)
    page.insert_text((70, 90), "r0nix SVG quality experiment - vector page", fontsize=24)
    page.insert_text((70, 130), "This page is generated with text/path primitives only.", fontsize=14)
    for idx in range(1, 16):
        y = 170 + idx * 55
        page.draw_rect(fitz.Rect(70, y, 440, y + 38), color=(0.12, 0.33, 0.78), width=1.2)
        page.insert_text((82, y + 25), f"Vector row #{idx}", fontsize=12)
        page.draw_line(fitz.Point(470, y), fitz.Point(820, y + 38), color=(0.08, 0.45, 0.25), width=1.2)
    doc.save(vector_pdf)
    doc.close()
    created.append(vector_pdf)

    mixed_pdf = output_dir / "synthetic-mixed.pdf"
    base_doc = fitz.open(vector_pdf)
    base_page = base_doc[0]
    pix = base_page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6))
    mix_doc = fitz.open()
    mix_page = mix_doc.new_page(width=900, height=1200)
    mix_page.insert_text((70, 80), "r0nix SVG quality experiment - mixed page", fontsize=24)
    mix_page.insert_text((70, 118), "Raster + vector mixed content", fontsize=14)
    mix_page.insert_image(fitz.Rect(70, 170, 830, 760), pixmap=pix)
    mix_page.draw_rect(fitz.Rect(66, 166, 834, 764), color=(0.15, 0.37, 0.8), width=2)
    mix_page.insert_text((70, 810), "Footer vector note", fontsize=13)
    mix_doc.save(mixed_pdf)
    mix_doc.close()
    base_doc.close()
    created.append(mixed_pdf)

    raster_pdf = output_dir / "synthetic-raster-heavy.pdf"
    raster_doc = fitz.open()
    r_page = raster_doc.new_page(width=900, height=1200)
    r_page.insert_text((70, 80), "r0nix SVG quality experiment - raster heavy", fontsize=24)
    r_page.insert_text((70, 118), "Mostly bitmap content", fontsize=14)
    r_page.insert_image(fitz.Rect(70, 150, 830, 1090), pixmap=pix)
    raster_doc.save(raster_pdf)
    raster_doc.close()
    created.append(raster_pdf)

    return created


def find_real_pdf_fallback(repo_root: Path) -> list[Path]:
    candidates = sorted(repo_root.rglob("zlib.3.pdf"))
    return [path for path in candidates if path.is_file()]


def collect_input_pdfs(input_dirs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for directory in input_dirs:
        if not directory.exists():
            continue
        files.extend(sorted(p for p in directory.rglob("*.pdf") if p.is_file()))
    return files


def run_experiment(
    pdf_files: Iterable[Path],
    output_dir: Path,
    max_pages_per_pdf: int,
) -> list[PageMetric]:
    metrics: list[PageMetric] = []
    output_dir.mkdir(parents=True, exist_ok=True)

    for pdf in pdf_files:
        doc = fitz.open(pdf)
        try:
            pages = doc.page_count if max_pages_per_pdf <= 0 else min(doc.page_count, max_pages_per_pdf)
            pdf_output_dir = output_dir / pdf.stem
            pdf_output_dir.mkdir(parents=True, exist_ok=True)
            for idx in range(pages):
                page = doc.load_page(idx)
                svg = page.get_svg_image()
                text_count, path_count, shape_count, image_count, vector_count, ratio, grade = analyze_svg(svg)
                raster_area_ratio = estimate_raster_area_ratio(svg)
                weighted_vector_ratio = max(0.0, 1.0 - raster_area_ratio)
                weighted_grade = grade_from_ratio(weighted_vector_ratio)
                svg_path = pdf_output_dir / f"p{idx + 1}.svg"
                svg_path.write_text(svg, encoding="utf-8")
                metrics.append(
                    PageMetric(
                        pdf=pdf.name,
                        page_no=idx + 1,
                        output_svg=str(svg_path),
                        text_count=text_count,
                        path_count=path_count,
                        shape_count=shape_count,
                        image_count=image_count,
                        vector_count=vector_count,
                        vector_ratio=ratio,
                        raster_area_ratio=raster_area_ratio,
                        weighted_vector_ratio=weighted_vector_ratio,
                        grade=grade,
                        weighted_grade=weighted_grade,
                        svg_size_bytes=svg_path.stat().st_size,
                    )
                )
        finally:
            doc.close()

    return metrics


def write_reports(metrics: list[PageMetric], report_dir: Path) -> tuple[Path, Path]:
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    json_path = report_dir / f"svg-quality-{stamp}.json"
    md_path = report_dir / f"svg-quality-{stamp}.md"

    data = [asdict(item) for item in metrics]
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    grade_count = {"A": 0, "B": 0, "C": 0, "D": 0}
    ratios = []
    weighted_ratios = []
    for item in metrics:
        grade_count[item.grade] = grade_count.get(item.grade, 0) + 1
        ratios.append(item.vector_ratio)
        weighted_ratios.append(item.weighted_vector_ratio)

    avg_ratio = sum(ratios) / len(ratios) if ratios else 0.0
    p90_ratio = sorted(ratios)[math.ceil(len(ratios) * 0.9) - 1] if ratios else 0.0
    avg_weighted_ratio = sum(weighted_ratios) / len(weighted_ratios) if weighted_ratios else 0.0

    lines = [
        "# SVG Batch Export Quality Report",
        "",
        f"- Generated at: `{datetime.now().isoformat(timespec='seconds')}`",
        f"- Page samples: **{len(metrics)}**",
        f"- Avg vector ratio: **{avg_ratio:.2%}**",
        f"- P90 vector ratio: **{p90_ratio:.2%}**",
        f"- Avg weighted vector ratio (1 - raster area): **{avg_weighted_ratio:.2%}**",
        f"- Grade distribution: A={grade_count['A']}, B={grade_count['B']}, C={grade_count['C']}, D={grade_count['D']}",
        "",
        "## Per page result",
        "",
        "| PDF | Page | Grade | Weighted Grade | Vector Ratio | Raster Area | Image Count | SVG Size (KB) |",
        "| --- | ---: | :---: | :---: | ---: | ---: | ---: | ---: |",
    ]
    for item in metrics:
        lines.append(
            f"| {item.pdf} | {item.page_no} | {item.grade} | {item.weighted_grade} | {item.vector_ratio:.2%} | "
            f"{item.raster_area_ratio:.2%} | {item.image_count} | {item.svg_size_bytes / 1024:.1f} |"
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return json_path, md_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch SVG export quality experiment")
    parser.add_argument(
        "--input-dir",
        action="append",
        default=[],
        help="Input PDF directory (can be repeated). If omitted, built-in synthetic and fallback PDFs are used.",
    )
    parser.add_argument(
        "--max-pages-per-pdf",
        type=int,
        default=6,
        help="Maximum exported pages per PDF (<= 0 means all pages)",
    )
    parser.add_argument(
        "--output-dir",
        default="tmp/svg-quality-output",
        help="SVG output directory",
    )
    parser.add_argument(
        "--report-dir",
        default="docs/experiments",
        help="Report output directory",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    synthetic_dir = repo_root / "tmp" / "svg-quality-input"
    output_dir = (repo_root / args.output_dir).resolve()
    report_dir = (repo_root / args.report_dir).resolve()

    input_dirs = [Path(p).resolve() for p in args.input_dir]
    input_pdfs = collect_input_pdfs(input_dirs)
    if input_pdfs:
        pdf_files = input_pdfs
    else:
        synthetic_pdfs = create_synthetic_input_pdfs(synthetic_dir)
        real_pdfs = find_real_pdf_fallback(repo_root)
        pdf_files = synthetic_pdfs + real_pdfs

    if not pdf_files:
        raise RuntimeError("No PDFs found for experiment")

    metrics = run_experiment(pdf_files, output_dir, args.max_pages_per_pdf)
    json_path, md_path = write_reports(metrics, report_dir)

    print(f"[svg-exp] input pdfs: {len(pdf_files)}")
    print(f"[svg-exp] sampled pages: {len(metrics)}")
    print(f"[svg-exp] report json: {json_path}")
    print(f"[svg-exp] report md: {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
