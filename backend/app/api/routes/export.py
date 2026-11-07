"""Export an answer as a PDF (selectable text, boxed code blocks, tables, numbered sources)."""
from __future__ import annotations

import asyncio
import html
import io
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/export", tags=["export"])


class PdfCitation(BaseModel):
    index: int
    title: str = ""
    source: str = ""
    locator: str | None = None


class PdfRequest(BaseModel):
    title: str = Field(default="Answer", max_length=300)
    question: str | None = Field(default=None, max_length=8000)
    markdown: str = Field(min_length=1, max_length=200_000)
    citations: list[PdfCitation] = []
    model: str | None = Field(default=None, max_length=200)


CSS = """
* { font-family: serif; }
body { font-size: 11pt; line-height: 1.5; color: #111111; }
h1.doc-title { font-family: sans-serif; font-size: 18pt; font-weight: bold; margin: 0 0 4pt 0; }
p.meta { font-family: sans-serif; font-size: 8.5pt; color: #6e6e6e; margin: 0 0 14pt 0; }
div.question { font-family: sans-serif; font-size: 10pt; background-color: #f0f0f0; padding: 8pt 10pt;
               margin: 0 0 14pt 0; border: 0.5pt solid #e0e0e0; }
div.question b { font-family: sans-serif; font-size: 7.5pt; color: #6e6e6e; }
h1, h2, h3, h4 { font-family: sans-serif; font-weight: bold; margin: 12pt 0 4pt 0; }
h1 { font-size: 14pt; } h2 { font-size: 12.5pt; } h3 { font-size: 11.5pt; } h4 { font-size: 11pt; }
p { margin: 0 0 7pt 0; }
ul, ol { margin: 0 0 7pt 0; }
li { margin: 0 0 3pt 0; }
code { font-family: monospace; font-size: 9pt; background-color: #f2f2f2; }
pre { font-family: monospace; font-size: 8.5pt; line-height: 1.35; background-color: #f6f6f6;
      border: 0.75pt solid #d9d9d9; padding: 8pt; margin: 4pt 0 10pt 0; white-space: pre-wrap; }
pre code { background-color: #f6f6f6; }
div.code { margin: 6pt 0 10pt 0; }
div.code pre { margin: 0; }
div.code-label { font-family: sans-serif; font-size: 7.5pt; color: #6e6e6e; background-color: #ebebeb;
                 border: 0.75pt solid #d9d9d9; border-bottom: 0; padding: 3pt 8pt; margin: 0; }
table { border-collapse: collapse; margin: 4pt 0 10pt 0; width: 100%; }
th, td { border: 0.75pt solid #d0d0d0; padding: 4pt 6pt; font-size: 9.5pt; text-align: left; }
th { font-family: sans-serif; font-weight: bold; background-color: #f0f0f0; }
blockquote { color: #555555; border-left: 2pt solid #cccccc; padding-left: 8pt; margin: 0 0 7pt 0; }
sup.cite { font-family: sans-serif; font-size: 7pt; color: #555555; }
div.sources { margin-top: 16pt; border-top: 0.75pt solid #d0d0d0; padding-top: 8pt; }
div.sources h2 { font-size: 11pt; margin-top: 0; }
div.sources p { font-family: sans-serif; font-size: 8.5pt; margin: 0 0 4pt 0; }
span.src { color: #6e6e6e; }
"""


def _markdown_to_html(text: str) -> str:
    from markdown_it import MarkdownIt

    md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable(["table", "strikethrough"])

    # Label fenced code blocks with their language, like the on-screen code boxes.
    def fence(_renderer, tokens, idx, _options, _env):
        tok = tokens[idx]
        lang = (tok.info or "").strip().split(" ")[0]
        label = f'<div class="code-label">{html.escape(lang)}</div>' if lang else ""
        return f'<div class="code">{label}<pre><code>{html.escape(tok.content)}</code></pre></div>\n'

    md.add_render_rule("fence", fence)
    out = md.render(text)
    # [n] citation markers -> superscripts (only outside code; code was escaped into <pre>).
    parts = re.split(r"(<pre>.*?</pre>)", out, flags=re.S)
    parts = [p if p.startswith("<pre>") else re.sub(r"\[(\d{1,3})\]", r'<sup class="cite">[\1]</sup>', p) for p in parts]
    return "".join(parts)


def render_pdf(req: PdfRequest) -> bytes:
    try:
        import pymupdf as fitz
    except ImportError:  # older PyMuPDF releases only ship the `fitz` name
        import fitz

    when = datetime.now().strftime("%d %b %Y, %H:%M")
    meta = " · ".join(x for x in ["Agentic RAG", when, req.model] if x)
    body = [f'<h1 class="doc-title">{html.escape(req.title)}</h1>', f'<p class="meta">{html.escape(meta)}</p>']
    if req.question:
        body.append(f'<div class="question"><b>QUESTION</b><br/>{html.escape(req.question)}</div>')
    body.append(_markdown_to_html(req.markdown))
    if req.citations:
        rows = []
        for c in sorted(req.citations, key=lambda c: c.index):
            where = " · ".join(x for x in [c.source, c.locator or ""] if x)
            rows.append(f"<p><b>[{c.index}]</b> {html.escape(c.title)}"
                        f'{" — <span class=src>" + html.escape(where) + "</span>" if where else ""}</p>')
        body.append('<div class="sources"><h2>Sources</h2>' + "".join(rows) + "</div>")

    story = fitz.Story(html="<body>" + "".join(body) + "</body>", user_css=CSS)
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    page = fitz.paper_rect("a4")
    frame = page + (56, 56, -56, -64)
    more = True
    while more:
        dev = writer.begin_page(page)
        more, _ = story.place(frame)
        story.draw(dev)
        writer.end_page()
    writer.close()

    # Footer: title + page numbers.
    doc = fitz.open("pdf", buf.getvalue())
    n = doc.page_count
    short = req.title if len(req.title) <= 70 else req.title[:67] + "…"
    for i, pg in enumerate(doc):
        pg.insert_text((56, page.height - 32), short, fontsize=7.5, fontname="helv", color=(0.45, 0.45, 0.45))
        label = f"{i + 1} / {n}"
        w = fitz.get_text_length(label, fontname="helv", fontsize=7.5)
        pg.insert_text((page.width - 56 - w, page.height - 32), label, fontsize=7.5, fontname="helv", color=(0.45, 0.45, 0.45))
    doc.set_metadata({"title": req.title, "creator": "Agentic RAG", "producer": "Agentic RAG"})
    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return out


@router.post("/pdf")
async def export_pdf(req: PdfRequest):
    try:
        pdf = await asyncio.to_thread(render_pdf, req)
    except ImportError as e:
        raise HTTPException(501, f"PDF export needs PyMuPDF and markdown-it-py installed: {e}") from e
    safe = re.sub(r"[^A-Za-z0-9 _.-]+", "", req.title).strip()[:60] or "answer"
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'})
