# PostgreSQL 16 + pgvector + pg_bigm (untested build recipe; verified only on Ubuntu 24.04 packages)
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-16-pgvector postgresql-server-dev-16 build-essential git ca-certificates \
  && git clone --depth 1 https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm \
  && make -C /tmp/pg_bigm USE_PGXS=1 && make -C /tmp/pg_bigm USE_PGXS=1 install \
  && apt-get purge -y build-essential git postgresql-server-dev-16 && apt-get autoremove -y \
  && rm -rf /tmp/pg_bigm /var/lib/apt/lists/*
