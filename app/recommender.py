"""Explainable TF-IDF matching between a learner's interests and Porta topics."""

from __future__ import annotations

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from app.catalog import LEARNING_PATHS

_PATH_VECTORIZER = TfidfVectorizer(ngram_range=(1, 2), strip_accents="unicode")
_PATH_VECTORS = _PATH_VECTORIZER.fit_transform(
    f"{path['title']} {path['category']} {path['description']} {path['keywords']}"
    for path in LEARNING_PATHS
)


def recommend_paths(interests: list[str], goal: str, limit: int = 3) -> list[dict]:
    """Rank learning topics by text similarity, without presenting scores as probabilities."""
    query = " ".join([*interests, goal]).strip()
    if not query:
        return []

    query_vector = _PATH_VECTORIZER.transform([query])
    if query_vector.nnz == 0:
        return []

    scores = cosine_similarity(query_vector, _PATH_VECTORS).ravel()
    ranked = sorted(enumerate(scores), key=lambda item: (-item[1], item[0]))
    return [
        {**LEARNING_PATHS[index], "relevance": round(float(score), 3)}
        for index, score in ranked[:limit]
        if score > 0
    ]
