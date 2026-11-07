from app.evaluation import metrics as M
from app.ingestion.chunking import parent_child, recursive_split, sliding_window
from app.retrieval.bm25 import BM25Index, tokenize
from app.retrieval.fusion import reciprocal_rank_fusion, weighted_score_fusion


def test_rrf_prefers_items_ranked_high_in_many_lists():
    fused = reciprocal_rank_fusion([["a", "b", "c"], ["b", "a", "d"], ["b", "e"]])
    assert fused[0][0] == "b"
    assert {x for x, _ in fused} == {"a", "b", "c", "d", "e"}


def test_weighted_fusion_normalizes():
    out = weighted_score_fusion([[("a", 10), ("b", 0)], [("b", 1.0), ("a", 0.5)]], [0.5, 0.5])
    assert out[0][0] in {"a", "b"} and len(out) == 2


def test_recursive_split_respects_size_and_keeps_text():
    text = "\n\n".join(f"Paragraph {i}. " + "word " * 60 for i in range(10))
    chunks = recursive_split(text, 400, 50)
    assert all(len(c) <= 450 for c in chunks)
    assert "Paragraph 9" in " ".join(chunks)


def test_parent_child_structure():
    text = " ".join(f"Sentence number {i} about retrieval." for i in range(300))
    pairs = parent_child(text, 2000, 400, 40, "recursive")
    assert len(pairs) > 1
    for parent, children in pairs:
        assert len(parent) <= 2000 and children
        assert all(c.split()[0] in parent for c in children)


def test_sliding_window_overlaps():
    w = sliding_window(" ".join(str(i) for i in range(500)), 300, 120)
    assert len(w) > 2 and set(w[0].split()) & set(w[1].split())


def test_bm25_matches_identifiers():
    assert "max_retries" in tokenize("set max_retries=3") and "retries" in tokenize("set max_retries=3")
    idx = BM25Index()
    idx.build(["1", "2", "3"], ["configure max_retries in client.yaml", "the weather is nice",
                                "retries and backoff policy"])
    hits = idx.search("max_retries", 2)
    assert hits[0][0] == "1"
    assert idx.search("max_retries", 2, allowed_ids={"3"})[0][0] == "3"


def test_ranking_metrics():
    ret, rel = ["x", "a", "y", "b"], {"a", "b"}
    assert M.recall_at_k(ret, rel, 2) == 0.5
    assert M.precision_at_k(ret, rel, 4) == 0.5
    assert M.mrr(ret, rel) == 0.5
    assert 0 < M.ndcg_at_k(ret, rel, 4) < 1
    assert M.ndcg_at_k(["a", "b"], rel, 2) == 1.0
    assert M.citation_correctness(["a", "z"], rel) == 0.5
    assert abs(M.context_precision(ret, rel) - (0.5 + 0.5) / 2) < 1e-9
