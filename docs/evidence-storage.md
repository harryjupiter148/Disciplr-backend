# Evidence Storage Contract

This service stores signed object-storage references for verification evidence without persisting raw PII or document contents.

## What is stored

- `verification_id` — links the reference to the recorded verification decision.
- `evidence_hash` — integrity checksum for the submitted evidence payload.
- `reference_url` — signed object-storage URL (e.g. S3-compatible signed URL).
- `expires_at` — expiry timestamp extracted from the signed URL.
- `created_at` — insertion timestamp.

## What is not stored

- Raw evidence files.
- User-uploaded document contents.
- Sensitive personal data from the payload.

## Ingestion rules

- `POST /api/verifications` now accepts `evidenceHash` and `evidenceReferenceUrl`.
- `evidenceHash` must be a non-empty alphanumeric-hyphen-underscore string between 32 and 128 characters.
- `evidenceReferenceUrl` must be an HTTP/HTTPS signed object-storage URL.
- URL expiry is validated by parsing one of:
  - `X-Amz-Expires` with `X-Amz-Date`
  - `Expires`
  - `expires`
- Expired URLs are rejected.

## Persistence

A new `evidence_references` table stores evidence metadata.
This table is created by the new database migration `db/migrations/20260527000000_create_evidence_references.cjs`.

## Audit logging

Audit logs do not include the raw signed URL.
Only evidence metadata such as `evidenceHash` and the fact that evidence was attached are recorded.

## Similarity Search

To detect near-duplicate or low-effort submissions, evidence supports a hybrid similarity search combining vector embeddings and keyword/text matching.

### Hybrid Search Implementation
- **Vector Search (HNSW)**: The `milestone_embeddings` table uses an HNSW index on the `embedding` column with the `vector_cosine_ops` operator class.
  - **Tradeoffs**: HNSW provides superior recall and faster query times compared to IVFFlat, though it consumes slightly more memory and index build time.
  - **Parameters**: Built with `m = 16` and `ef_construction = 64` as standards for 768-dimensional embeddings.
- **Keyword Search (pg_trgm)**: The `evidence_references` table is indexed with GIN indexes (`gin_trgm_ops`) on `reference_url` and `evidence_hash`.
  - This acts as a fallback for evidence that shares few embedded features but has exactly or near-exactly matching URLs or hashes.
- **Scoring**: A fused score is calculated as `w1 * vector_distance + w2 * keyword_distance`. Both vector and keyword use distance metrics where `0` implies an exact match.

## Relationship to milestone embeddings

This service intentionally does **not** generate or store embeddings — see "What is not stored"
above. Similarity-search embeddings for milestones (used for near-duplicate / low-effort
submission detection) are a separate subsystem keyed by `milestone_id`, not evidence rows, and are
kept in sync by an offline reindex backfill job. See "Embedding reindex backfill job" in
`docs/milestones.md` for that job's design, resumability, and rate-limiting.
