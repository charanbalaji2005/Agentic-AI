"""File parsers that keep page numbers and headings so citations stay precise."""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from pathlib import Path

CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".cs",
            ".rb", ".php", ".kt", ".swift", ".scala", ".sql", ".sh", ".yaml", ".yml", ".toml", ".tf"}
SUPPORTED = {".pdf", ".docx", ".doc", ".txt", ".md", ".markdown", ".html", ".htm", ".csv", ".json"} | CODE_EXT


@dataclass
class Section:
    text: str
    page: int | None = None
    heading: str | None = None
    content_type: str = "text"


@dataclass
class ParsedDocument:
    title: str
    sections: list[Section] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


def parse_file(path: Path) -> ParsedDocument:
    ext = path.suffix.lower()
    if ext not in SUPPORTED:
        raise ValueError(f"Unsupported file type: {ext}")
    if ext == ".pdf":
        return _pdf(path)
    if ext in (".docx", ".doc"):
        return _docx(path)
    if ext in (".md", ".markdown"):
        return _markdown(path.read_text(errors="replace"), path.stem)
    if ext in (".html", ".htm"):
        return _html(path.read_text(errors="replace"), path.stem)
    if ext == ".csv":
        return _csv(path)
    if ext == ".json":
        data = json.loads(path.read_text(errors="replace"))
        return ParsedDocument(path.stem, [Section(json.dumps(data, indent=2), content_type="json")])
    if ext in CODE_EXT:
        return ParsedDocument(path.name, [Section(path.read_text(errors="replace"), content_type="code")],
                              {"language": ext.lstrip(".")})
    return ParsedDocument(path.stem, [Section(path.read_text(errors="replace"))])


def _pdf(path: Path) -> ParsedDocument:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    title = (reader.metadata.title if reader.metadata and reader.metadata.title else None) or path.stem
    sections = []
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            sections.append(Section(text, page=i))

    total_text = "".join(s.text for s in sections).strip()
    if not sections or len(total_text) < 20:
        # Fallback to OCR using pypdfium2 + RapidOCR
        try:
            import numpy as np
            import pypdfium2 as pdfium
            from rapidocr_onnxruntime import RapidOCR

            ocr = RapidOCR()
            pdf = pdfium.PdfDocument(str(path))
            ocr_sections = []
            for i, page in enumerate(pdf, start=1):
                img = page.render(scale=1.5).to_pil()
                res, _ = ocr(np.array(img))
                lines = [item[1] for item in res] if res else []
                page_text = "\n".join(lines).strip()
                if page_text:
                    ocr_sections.append(Section(page_text, page=i))
            if ocr_sections:
                sections = ocr_sections
        except Exception as ocr_err:
            if not sections:
                raise ValueError(f"Could not extract text or run OCR on PDF: {ocr_err}") from ocr_err

    if not sections:
        raise ValueError("PDF has no extractable text (even with OCR)")
    return ParsedDocument(title, sections, {"pages": len(reader.pages)})


def _docx(path: Path) -> ParsedDocument:
    import docx

    try:
        d = docx.Document(str(path))
        sections: list[Section] = []
        heading, buf = None, []

        def flush():
            if buf:
                sections.append(Section("\n".join(buf), heading=heading))
                buf.clear()

        for p in d.paragraphs:
            style = (p.style.name or "").lower() if p.style else ""
            if style.startswith("heading") or style == "title":
                flush()
                heading = p.text.strip() or heading
            elif p.text.strip():
                buf.append(p.text)
        flush()
        for t_i, table in enumerate(d.tables):
            rows = [" | ".join(c.text.strip() for c in r.cells) for r in table.rows]
            sections.append(Section("\n".join(rows), heading=f"Table {t_i + 1}", content_type="table"))
        title = d.core_properties.title or path.stem
        return ParsedDocument(title, sections)
    except Exception:
        raw = path.read_text(errors="replace")
        clean_text = "".join(ch for ch in raw if ch.isprintable() or ch in "\n\r\t").strip()
        if clean_text:
            return ParsedDocument(path.stem, [Section(clean_text)])
        raise


def _markdown(text: str, title: str) -> ParsedDocument:
    sections, heading, buf, in_code = [], None, [], False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
        if not in_code and line.startswith("#"):
            if buf:
                sections.append(Section("\n".join(buf).strip(), heading=heading))
                buf = []
            heading = line.lstrip("#").strip()
            if title is None or (line.startswith("# ") and not sections):
                title = heading
        else:
            buf.append(line)
    if buf and "\n".join(buf).strip():
        sections.append(Section("\n".join(buf).strip(), heading=heading))
    return ParsedDocument(title, [s for s in sections if s.text])


def _html(html: str, title: str) -> ParsedDocument:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    sections, heading, buf = [], None, []
    for el in soup.find_all(["h1", "h2", "h3", "h4", "p", "li", "pre", "td"]):
        if el.name in ("h1", "h2", "h3", "h4"):
            if buf:
                sections.append(Section("\n".join(buf), heading=heading))
                buf = []
            heading = el.get_text(" ", strip=True)
        else:
            t = el.get_text(" ", strip=True)
            if t:
                buf.append(t)
    if buf:
        sections.append(Section("\n".join(buf), heading=heading))
    return ParsedDocument(title, sections)


def _csv(path: Path) -> ParsedDocument:
    rows = list(csv.reader(io.StringIO(path.read_text(errors="replace"))))
    if not rows:
        return ParsedDocument(path.stem, [])
    header, body = rows[0], rows[1:]
    sections = []
    for i in range(0, len(body), 25):  # 25 rows per section keeps header context in every chunk
        block = [" | ".join(header)] + [" | ".join(r) for r in body[i:i + 25]]
        sections.append(Section("\n".join(block), heading=f"Rows {i + 1}-{i + len(body[i:i + 25])}",
                                content_type="table"))
    return ParsedDocument(path.stem, sections, {"columns": header, "rows": len(body)})
