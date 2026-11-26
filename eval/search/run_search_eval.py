"""Spike 1: compare Japanese keyword search methods on the same corpus.

Methods
  gbrain        : gbrain keyword search (PGLite, no embedding key = default no-API setup)
  fts_simple    : PostgreSQL full-text search with the 'simple' config
  trgm          : pg_trgm word_similarity
  bigm          : pg_bigm bigrams, IDF-weighted overlap score
  bigm_norm     : bigm + our normalization (NFKC, 万円/comma numbers, project aliases)

Scores per query: rank of the "primary" document (the one a correct answer must rest on).
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import unicodedata

import psycopg

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
QUERIES = json.loads((ROOT / "eval" / "search" / "queries.json").read_text())
DSN = "host=/tmp port=5433 user=postgres dbname=postgres"

ALIASES = {"株式会社エー": "A社", "エー社": "A社"}


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    for alias, canon in ALIASES.items():
        t = t.replace(alias, canon)
    t = re.sub(r"(?<=\d),(?=\d{3})", "", t)  # 120,000 -> 120000

    def man(m):
        return str(int(float(m.group(1)) * 10000)) + "円"

    t = re.sub(r"(\d+(?:\.\d+)?)万円", man, t)  # 12万円 -> 120000円
    return t


def load_docs():
    docs = []
    for path in sorted(CORPUS.rglob("*.md")):
        raw = path.read_text()
        body = raw.split("---", 2)[2] if raw.startswith("---") else raw
        docs.append({"id": path.stem, "project": path.parent.name, "body": body.strip()})
    return docs


def setup_pg(conn, docs):
    with conn.cursor() as cur:
        cur.execute("drop table if exists docs")
        cur.execute("create table docs (id text primary key, project text, body text, body_norm text)")
        for d in docs:
            cur.execute("insert into docs values (%s,%s,%s,%s)", (d["id"], d["project"], d["body"], normalize(d["body"])))
        cur.execute("create index on docs using gin (body gin_bigm_ops)")
        cur.execute("create index on docs using gin (body_norm gin_bigm_ops)")
    conn.commit()


BIGM_SQL = """
with qb as (select distinct b from unnest(show_bigm(%(q)s)) b where b !~ ' '),
n as (select count(*)::float n from docs where project = any(%(scope)s)),
df as (
  select qb.b, count(d.id) df from qb
  left join docs d on strpos(d.{col}, qb.b) > 0 and d.project = any(%(scope)s)
  group by qb.b
),
w as (select b, ln((n.n + 1.0) / (df.df + 0.5)) w from df, n)
select d.id,
  coalesce(sum(case when strpos(d.{col}, w.b) > 0 then w.w else 0 end) / nullif((select sum(w) from w), 0), 0) s
from docs d cross join w
where d.project = any(%(scope)s)
group by d.id having sum(case when strpos(d.{col}, w.b) > 0 then 1 else 0 end) > 0
order by s desc, d.id limit 5
"""


def run_pg(conn, method, q, scope):
    with conn.cursor() as cur:
        if method == "fts_simple":
            cur.execute(
                """select id from docs where project = any(%s)
                   and to_tsvector('simple', body) @@ plainto_tsquery('simple', %s)
                   order by ts_rank(to_tsvector('simple', body), plainto_tsquery('simple', %s)) desc limit 5""",
                (scope, q, q),
            )
        elif method == "trgm":
            cur.execute(
                """select id from docs where project = any(%s) and word_similarity(%s, body) > 0.1
                   order by word_similarity(%s, body) desc limit 5""",
                (scope, q, q),
            )
        elif method == "bigm":
            cur.execute(BIGM_SQL.format(col="body"), {"q": q, "scope": scope})
        elif method == "bigm_norm":
            cur.execute(BIGM_SQL.format(col="body_norm"), {"q": normalize(q), "scope": scope})
        return [r[0] for r in cur.fetchall()]


def run_gbrain(q, scope=None):
    cmd = ["gbrain", "search", q, "--json", "--limit", "5"]
    if scope:
        cmd += ["--where", "project=" + ",".join(scope)]
    out = subprocess.run(cmd, capture_output=True, text=True, env=os.environ, timeout=120)
    try:
        rows = json.loads(out.stdout)
    except json.JSONDecodeError:
        return []
    ids = []
    for r in rows:
        stem = r["slug"].split("/")[-1]
        if stem not in ids:
            ids.append(stem)
    return ids[:5]


def rank_of(ids, target):
    return ids.index(target) + 1 if target in ids else None


def main():
    docs = load_docs()
    conn = psycopg.connect(DSN)
    setup_pg(conn, docs)
    all_projects = sorted({d["project"] for d in docs})
    methods = ["gbrain", "fts_simple", "trgm", "bigm", "bigm_norm"]
    results = []
    for item in QUERIES:
        row = {"id": item["id"], "query": item["query"], "category": item["category"], "primary": item["primary"]}
        for m in methods:
            ids = run_gbrain(item["query"]) if m == "gbrain" else run_pg(conn, m, item["query"], all_projects)
            row[m] = {"top": ids, "rank": rank_of(ids, item["primary"])}
        results.append(row)

    # Permission scoping: a user who may only see A社 asks about B社.
    scope_checks = []
    for m in methods:
        q = "B社の見積額"
        ids = run_gbrain(q, ["a-sha"]) if m == "gbrain" else run_pg(conn, m, q, ["a-sha"])
        leaked = [i for i in ids if "-b-" in i]
        scope_checks.append({"method": m, "query": q, "scope": ["a-sha"], "returned": ids, "leaked_b": leaked})

    summary = {}
    for m in methods:
        ranks = [r[m]["rank"] for r in results]
        summary[m] = {
            "top1": sum(1 for x in ranks if x == 1),
            "top3": sum(1 for x in ranks if x is not None and x <= 3),
            "zero_hit": sum(1 for r in results if not r[m]["top"]),
            "n": len(ranks),
        }
    report = {"results": results, "summary": summary, "scope_checks": scope_checks}
    (ROOT / "eval" / "search" / "search_results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"{'id':4} {'category':10} " + " ".join(f"{m:>10}" for m in methods) + "  query")
    for r in results:
        cells = []
        for m in methods:
            rk = r[m]["rank"]
            cells.append(f"{('#'+str(rk)) if rk else ('0件' if not r[m]['top'] else '圏外'):>10}")
        print(f"{r['id']:4} {r['category']:10} " + " ".join(cells) + "  " + r["query"])
    print()
    for m, s in summary.items():
        print(f"{m:10} top1={s['top1']}/{s['n']} top3={s['top3']}/{s['n']} zero_hit={s['zero_hit']}")
    print()
    for c in scope_checks:
        print(f"scope {c['method']:10} returned={c['returned']} leaked_b={c['leaked_b']}")


if __name__ == "__main__":
    sys.exit(main())
