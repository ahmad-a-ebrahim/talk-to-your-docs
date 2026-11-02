-- pgvector adds the `vector` column type, distance operators (<=> cosine, <-> L2, <#> inner product)
-- and the HNSW / IVFFlat index types. Supabase convention: extensions live in the `extensions` schema,
-- which is on the default search_path, so `vector(384)` resolves without a schema prefix.
create extension if not exists vector with schema extensions;
