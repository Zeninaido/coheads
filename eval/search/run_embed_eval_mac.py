"""Run on the Mac that has Ollama: compare bigram keyword search, embedding search, and the hybrid.

  ollama pull qwen3-embedding:0.6b      # once, if not already pulled
  python3 eval/search/run_embed_eval_mac.py    # standard library only

Env:
  OLLAMA_URL          default http://localhost:11434
  OLLAMA_EMBED_MODEL  default qwen3-embedding:0.6b
"""
import json
import math
import os
import pathlib
import re
import unicodedata
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
QUERIES = json.loads((ROOT / "eval" / "search" / "queries.json").read_text(encoding="utf-8"))
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
ALIASES = {"株式会社エー": "A社", "エー社": "A社"}
# Qwen3-Embedding expects an instruction on the query side only.
QUERY_INSTRUCTION = "Instruct: 社内の業務文書から、質問に答える根拠となる文書を探す\nQuery: "


def normalize(text):
    t = unicodedata.normalize("NFKC", text)
    for a in sorted(ALIASES, key=len, reverse=True):
        t = t.replace(a, ALIASES[a])
    t = re.sub(r"(?<=\d),(?=\d{3})", "", t)
    t = re.sub(r"(\d+(?:\.\d+)?)万円", lambda m: str(int(float(m.group(1)) * 10000)) + "円", t)
    return t


def load_docs():
    docs = []
    for p in sorted(CORPUS.rglob("*.md")):
        raw = p.read_text(encoding="utf-8")
        body = raw.split("---", 2)[2].strip() if raw.startswith("---") else raw
        docs.append({"id": p.stem, "project": p.parent.name, "body": body, "norm": normalize(body)})
    return docs


def bigrams(s):
    s = re.sub(r"\s+", " ", s)
    return {s[i:i + 2] for i in range(len(s) - 1) if " " not in s[i:i + 2]}


def bigram_rank(q, docs):
    qb = bigrams(normalize(q))
    n = len(docs)
    w = {b: math.log((n + 1.0) / (sum(1 for d in docs if b in d["norm"]) + 0.5)) for b in qb}
    total = sum(w.values()) or 1.0
    scored = []
    for d in docs:
        hits = [b for b in qb if b in d["norm"]]
        if hits:
            scored.append((sum(w[b] for b in hits) / total, d["id"]))
    return [i for _, i in sorted(scored, key=lambda x: (-x[0], x[1]))]


def embed(texts):
    req = urllib.request.Request(
        f"{OLLAMA}/api/embed",
        data=json.dumps({"model": MODEL, "input": texts}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["embeddings"]


def cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)) or 1.0)


def rrf(*rankings, k=60):
    score = {}
    for r in rankings:
        for i, doc in enumerate(r):
            score[doc] = score.get(doc, 0) + 1.0 / (k + i + 1)
    return [d for d, _ in sorted(score.items(), key=lambda x: -x[1])]


def main():
    docs = load_docs()
    doc_vecs = embed([d["body"] for d in docs])
    q_vecs = embed([QUERY_INSTRUCTION + q["query"] for q in QUERIES])
    print(f"model={MODEL} dims={len(doc_vecs[0])}")
    methods = ["bigm_norm", "embedding", "hybrid"]
    summary = {m: [0, 0] for m in methods}
    print(f"{'id':4} {'category':10} " + " ".join(f"{m:>10}" for m in methods) + "  query")
    rows = []
    for q, qv in zip(QUERIES, q_vecs):
        kw = bigram_rank(q["query"], docs)
        emb = [d["id"] for _, d in sorted(((cos(qv, v), d) for v, d in zip(doc_vecs, docs)), key=lambda x: -x[0])]
        res = {"bigm_norm": kw[:5], "embedding": emb[:5], "hybrid": rrf(kw, emb)[:5]}
        cells = []
        for m in methods:
            rk = res[m].index(q["primary"]) + 1 if q["primary"] in res[m] else None
            summary[m][0] += rk == 1
            summary[m][1] += rk is not None and rk <= 3
            cells.append(f"{('#' + str(rk)) if rk else '圏外':>10}")
        rows.append({"id": q["id"], "query": q["query"], **res})
        print(f"{q['id']:4} {q['category']:10} " + " ".join(cells) + "  " + q["query"])
    print()
    for m, (t1, t3) in summary.items():
        print(f"{m:10} top1={t1}/{len(QUERIES)} top3={t3}/{len(QUERIES)}")
    (ROOT / "eval" / "search" / "embed_results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
