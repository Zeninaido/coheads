# PostgreSQL 16 + pgvector + pg_bigm (built in CI: .github/workflows/ci.yml, job "postgres")
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-16-pgvector postgresql-server-dev-16 libicu-dev build-essential git ca-certificates \
  && git clone --depth 1 https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm \
  && make -C /tmp/pg_bigm USE_PGXS=1 && make -C /tmp/pg_bigm USE_PGXS=1 install \
  && apt-get purge -y build-essential git postgresql-server-dev-16 libicu-dev && apt-get autoremove -y \
  && rm -rf /tmp/pg_bigm /var/lib/apt/lists/*
