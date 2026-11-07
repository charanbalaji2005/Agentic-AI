"""Claim extraction and support scoring on a markdown answer shaped like real model output."""
import pytest

from app.core.schemas import Evidence, SourceKind
from app.generation.validator import extract_claims, lexical_support, validate

FILLER = "Notebook output cell. " * 120  # pushes the facts past the first 2,000 characters

SRC1 = FILLER + ("Selected features by |corr| > 0.2: oldpeak 0.438, exang 0.437966, cp 0.434854. "
                 "Excluded: trestbps 0.138772, chol 0.099966. X shape after filter: (1025, 9)")
SRC2 = FILLER + ("RangeIndex: 1025 entries, 0 to 1024. Data columns (total 14 columns). dtypes: float64(1), int64(13). "
                 "Missing values per column: 0. df.shape (1025, 14). target mean 0.513171")

ANSWER = """Based on the provided sources, the PDFs contain a machine learning laboratory report.

Here is an elaboration of the contents found in each document:

**Machine Learning Laboratory Report (ML Lab-12.pdf)**

### Data Overview and Preprocessing:

- **Dataset Structure:** The dataset contains **1,025 entries** (rows) and **14 columns** (features) [2].
- **Missing Values:** The analysis confirms that there are **no missing values** in any of the columns. Consequently, the shape of the dataframe remained `(1025, 14)` [2].
- **Target Distribution:** The mean of the target is approximately **0.513**, a balanced dataset [2].

The selected features are:

1. `oldpeak` (|corr| ≈ 0.438)
2. `exang` (|corr| ≈ 0.438)
- **Excluded Features:** `trestbps` (|corr| ≈ 0.139) and `chol` (|corr| ≈ 0.100) were excluded [1].
- **Resulting Shape:** After filtering, the feature matrix `X` was reduced to a shape of **(1025, 9)** [1].
- **Wrong Shape:** After filtering, the feature matrix `X` was reduced to a shape of (1025, 12) [1].
- **Phantom:** This sentence cites a source that does not exist at all [9].
"""


class ZeroReranker:
    """Worst case for numeric facts: the cross-encoder sees no relevance at all."""
    model = object()

    def score(self, q, passages, batch_size=16):
        return [0.0] * len(passages)


@pytest.fixture
def checks(monkeypatch):
    from app.models.manager import get_models
    monkeypatch.setattr(get_models(), "reranker", ZeroReranker())
    ev = [Evidence(kind=SourceKind.local, content=c, title=f"s{i}", source=f"s{i}.pdf", agent="local_rag")
          for i, c in enumerate((SRC1, SRC2), 1)]
    out, citations, stats = validate(ANSWER, ev)
    return {c.sentence: c for c in out}, citations, stats


def find(checks, prefix):
    return next(c for s, c in checks.items() if s.startswith(prefix))


def test_markdown_is_stripped_from_claims(checks):
    by_text, _, _ = checks
    assert not any("**" in s or "`" in s for s in by_text)
    assert any(s.startswith("Dataset Structure: The dataset contains 1,025 entries") for s in by_text)


def test_headings_and_lead_in_lines_are_not_claims(checks):
    texts = list(checks[0])
    for skipped in ("Here is an elaboration", "Machine Learning Laboratory Report", "Data Overview",
                    "The selected features are"):
        assert not any(t.startswith(skipped) for t in texts), skipped


def test_uncited_sentence_inherits_its_bullets_citation(checks):
    c = find(checks[0], "Missing Values:")
    assert c.cited == [2] and c.inherited  # checked against [2]; no numbers, so support is the cross-encoder's call


def test_list_items_inherit_from_their_section(checks):
    c = find(checks[0], "oldpeak (|corr| ≈ 0.438)")
    assert c.cited == [1] and c.inherited and c.supported  # 0.438 is in source 1


def test_numeric_fact_deep_in_source_is_supported(checks):
    c = find(checks[0], "Resulting Shape:")
    assert c.supported and c.support_score >= 0.5 and not c.inherited


def test_rounded_numbers_match(checks):
    assert find(checks[0], "Excluded Features:").supported  # 0.139 ≈ 0.138772, 0.100 ≈ 0.099966
    assert find(checks[0], "Target Distribution:").supported  # 0.513 ≈ 0.513171


def test_wrong_number_is_not_supported(checks):
    c = find(checks[0], "Wrong Shape:")
    assert not c.supported and c.support_score == 0.0


def test_invalid_citation_and_uncited_intro_are_reported(checks):
    by_text, citations, stats = checks
    assert stats["invalid_citations"] == [9]
    assert find(by_text, "Phantom:").cited == [9] and not find(by_text, "Phantom:").supported
    assert find(by_text, "Based on the provided sources").cited == []  # genuinely uncited
    assert [c.index for c in citations] == [1, 2]


def test_answer_without_any_citations_is_checked_against_all_sources(monkeypatch):
    from app.models.manager import get_models
    monkeypatch.setattr(get_models(), "reranker", ZeroReranker())
    ev = [Evidence(kind=SourceKind.local, content=c, title=f"s{i}", source=f"s{i}.pdf", agent="local_rag")
          for i, c in enumerate((SRC1, SRC2), 1)]
    answer = ("| Column | Info |\n|---|---|\n| df.shape | (1025, 14) after dropping nothing |\n"
              "After filtering, X has the shape (1025, 9).\nThe dataset has 4000 rows in total.")
    checks, citations, stats = validate(answer, ev)
    by = {c.sentence: c for c in checks}
    row = find(by, "df.shape")
    assert row.matched and row.cited == [2] and row.supported  # table row matched to source 2
    assert find(by, "After filtering").cited == [1]
    wrong = find(by, "The dataset has 4000 rows")
    assert not wrong.supported and wrong.cited == [] and not wrong.matched
    assert stats["uncited"] == 3 and stats["supported"] == 2


def test_lexical_support_requires_every_number():
    assert lexical_support("shape (1025, 9)", "shape (1025, 9)") == 1.0
    assert lexical_support("shape (1025, 9)", "result (1025, 9)") == 0.5  # numbers match, wording doesn't
    assert lexical_support("shape (1025, 10)", "result (1025, 9)") == 0.0
    assert lexical_support("no numbers here at all", "no numbers here at all") == 0.0  # left to the cross-encoder


def test_html_breaks_in_table_cells_are_removed():
    claims = extract_claims("| a | b |\n|---|---|\n| Selected features [1] | oldpeak 0.438 <br> exang 0.437 |")
    assert claims[0].text == "Selected features · oldpeak 0.438 exang 0.437" and claims[0].own == [1]


def test_code_blocks_and_math_are_ignored():
    claims = extract_claims("Intro sentence that is long enough here [1].\n```python\nprint('not a claim at all')\n```\n"
                            "$$x = \\frac{a}{b} + something long$$")
    assert [c.text for c in claims] == ["Intro sentence that is long enough here."]
