-- Run this in your Supabase SQL Editor to enable pgvector and create the documents table
create extension if not exists vector;

create table documents (
  id uuid primary key,
  slug text not null,
  text text not null,
  metadata jsonb,
  embedding vector(384) -- 384 dimensions for bge-small-en-v1.5
);

create index on documents using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

-- RPC for semantic search
create or replace function match_documents (
  query_embedding vector(384),
  match_slug text,
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  text text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    id,
    text,
    metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where slug = match_slug
    and 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
