"""Common vector-store interface with FAISS (local) and Qdrant (production) backends."""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np


class VectorStore(ABC):
    @abstractmethod
    def add(self, ids: list[str], vectors: np.ndarray, payloads: list[dict]) -> None: ...
    @abstractmethod
    def search(self, vector: np.ndarray, k: int, allowed_ids: set[str] | None = None) -> list[tuple[str, float]]: ...
    @abstractmethod
    def delete(self, ids: list[str]) -> None: ...
    @abstractmethod
    def count(self) -> int: ...
    def persist(self) -> None:  # noqa: B027
        pass


class FaissStore(VectorStore):
    """Inner-product over L2-normalized vectors == cosine similarity."""

    def __init__(self, path: Path, dim: int):
        import faiss

        self.faiss = faiss
        self.path = path
        self.path.mkdir(parents=True, exist_ok=True)
        self.index_file = path / "faiss.index"
        self.map_file = path / "faiss_ids.json"
        if self.index_file.exists():
            self.index = faiss.read_index(str(self.index_file))
            m = json.loads(self.map_file.read_text())
            self.str2int = m["str2int"]
            self.next_id = m["next_id"]
        else:
            self.index = faiss.IndexIDMap2(faiss.IndexFlatIP(dim))
            self.str2int, self.next_id = {}, 1
        self.int2str = {v: k for k, v in self.str2int.items()}

    def add(self, ids, vectors, payloads):
        int_ids = []
        for sid in ids:
            self.str2int[sid] = self.next_id
            self.int2str[self.next_id] = sid
            int_ids.append(self.next_id)
            self.next_id += 1
        self.index.add_with_ids(vectors.astype("float32"), np.array(int_ids, dtype="int64"))

    def search(self, vector, k, allowed_ids=None):
        if self.index.ntotal == 0:
            return []
        params = None
        if allowed_ids is not None:
            allowed = np.array([self.str2int[i] for i in allowed_ids if i in self.str2int], dtype="int64")
            if allowed.size == 0:
                return []
            params = self.faiss.SearchParameters(sel=self.faiss.IDSelectorArray(allowed))
        scores, idx = self.index.search(vector.reshape(1, -1).astype("float32"), min(k, self.index.ntotal),
                                        params=params)
        return [(self.int2str[int(i)], float(s)) for s, i in zip(scores[0], idx[0]) if i != -1]

    def delete(self, ids):
        ints = [self.str2int.pop(i) for i in ids if i in self.str2int]
        for n in ints:
            self.int2str.pop(n, None)
        if ints:
            self.index.remove_ids(np.array(ints, dtype="int64"))

    def count(self):
        return int(self.index.ntotal)

    def persist(self):
        self.faiss.write_index(self.index, str(self.index_file))
        self.map_file.write_text(json.dumps({"str2int": self.str2int, "next_id": self.next_id}))


class QdrantStore(VectorStore):
    def __init__(self, collection: str, dim: int, url: str, api_key: str | None = None):
        from qdrant_client import QdrantClient, models

        self.models = models
        self.client = QdrantClient(url=url, api_key=api_key)
        self.collection = collection
        if not self.client.collection_exists(collection):
            self.client.create_collection(
                collection, vectors_config=models.VectorParams(size=dim, distance=models.Distance.COSINE))

    @staticmethod
    def _pid(sid: str) -> str:
        import uuid
        return str(uuid.uuid5(uuid.NAMESPACE_URL, sid))

    def add(self, ids, vectors, payloads):
        pts = [self.models.PointStruct(id=self._pid(i), vector=v.tolist(), payload={**p, "chunk_id": i})
               for i, v, p in zip(ids, vectors, payloads)]
        for b in range(0, len(pts), 256):
            self.client.upsert(self.collection, pts[b:b + 256])

    def search(self, vector, k, allowed_ids=None):
        flt = None
        if allowed_ids is not None:
            flt = self.models.Filter(must=[self.models.FieldCondition(
                key="chunk_id", match=self.models.MatchAny(any=list(allowed_ids)))])
        res = self.client.query_points(self.collection, query=vector.tolist(), limit=k, query_filter=flt).points
        return [(p.payload["chunk_id"], float(p.score)) for p in res]

    def delete(self, ids):
        if ids:
            self.client.delete(self.collection, points_selector=self.models.PointIdsList(
                points=[self._pid(i) for i in ids]))

    def count(self):
        return self.client.count(self.collection).count
