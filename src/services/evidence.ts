import { prisma } from '../lib/prisma.js'

export class EvidenceReferenceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceReferenceValidationError'
  }
}

export interface EvidenceReference {
  id: string
  verificationId: string
  evidenceHash: string
  referenceUrl: string
  expiresAt: string
  createdAt: string
}

const EVIDENCE_HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

function normalizeEvidenceHash(input: unknown): string {
  if (typeof input !== 'string') {
    throw new EvidenceReferenceValidationError('evidenceHash must be a string')
  }

  const hash = input.trim()
  if (!EVIDENCE_HASH_PATTERN.test(hash)) {
    throw new EvidenceReferenceValidationError('evidenceHash must be a valid reference hash')
  }

  return hash
}

function parseAwsDate(dateString: string): Date {
  const normalized = dateString.toUpperCase()
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(normalized)) {
    throw new EvidenceReferenceValidationError('Invalid AWS signed URL date format')
  }

  const year = Number(normalized.slice(0, 4))
  const month = Number(normalized.slice(4, 6))
  const day = Number(normalized.slice(6, 8))
  const hour = Number(normalized.slice(9, 11))
  const minute = Number(normalized.slice(11, 13))
  const second = Number(normalized.slice(13, 15))
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

function parseExpiryParam(value: string): Date {
  const normalized = value.trim()
  if (normalized === '') {
    throw new EvidenceReferenceValidationError('Signed URL expiry parameter is empty')
  }

  const epoch = Number(normalized)
  if (Number.isFinite(epoch) && epoch > 0) {
    // Support epoch seconds and milliseconds
    const millis = epoch > 1e11 ? epoch : epoch * 1000
    return new Date(millis)
  }

  throw new EvidenceReferenceValidationError('Signed URL expiry parameter must be a valid numeric timestamp')
}

function getSignedUrlExpiry(referenceUrl: string): Date {
  let url: URL
  try {
    url = new URL(referenceUrl)
  } catch (error) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must be a valid URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must use http or https')
  }

  const params = url.searchParams
  const rawXAmzExpires = params.get('X-Amz-Expires')
  const rawExpires = params.get('Expires')
  const rawExpiresAlternate = params.get('expires')

  if (rawXAmzExpires) {
    const signedDate = params.get('X-Amz-Date')
    if (!signedDate) {
      throw new EvidenceReferenceValidationError('Missing X-Amz-Date for signed object-storage URL')
    }

    const baseDate = parseAwsDate(signedDate)
    const expirySeconds = Number(rawXAmzExpires)
    if (!Number.isFinite(expirySeconds) || expirySeconds < 0) {
      throw new EvidenceReferenceValidationError('Invalid X-Amz-Expires value')
    }

    return new Date(baseDate.getTime() + expirySeconds * 1000)
  }

  if (rawExpires) {
    return parseExpiryParam(rawExpires)
  }

  if (rawExpiresAlternate) {
    return parseExpiryParam(rawExpiresAlternate)
  }

  throw new EvidenceReferenceValidationError('Signed object-storage URL missing expiry parameter')
}

export function validateSignedObjectStorageUrl(referenceUrl: string): Date {
  const expiry = getSignedUrlExpiry(referenceUrl)
  if (expiry.getTime() <= Date.now()) {
    throw new EvidenceReferenceValidationError('Signed object-storage URL has already expired')
  }
  return expiry
}

export async function createEvidenceReference(
  verificationId: string,
  evidenceHash: string,
  evidenceReferenceUrl: string,
): Promise<EvidenceReference> {
  const normalizedHash = normalizeEvidenceHash(evidenceHash)
  const expiresAt = validateSignedObjectStorageUrl(evidenceReferenceUrl.trim())
  const now = new Date()

  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      verification_id: string
      evidence_hash: string
      reference_url: string
      expires_at: Date
      created_at: Date
    }>
  >`
    INSERT INTO evidence_references (
      verification_id,
      evidence_hash,
      reference_url,
      expires_at,
      created_at
    ) VALUES (
      ${verificationId},
      ${normalizedHash},
      ${evidenceReferenceUrl.trim()},
      ${expiresAt},
      ${now}
    )
    ON CONFLICT (verification_id)
    DO UPDATE SET
      evidence_hash = excluded.evidence_hash,
      reference_url = excluded.reference_url,
      expires_at = excluded.expires_at
    RETURNING id, verification_id, evidence_hash, reference_url, expires_at, created_at
  `

  const [row] = rows
  if (!row) {
    throw new Error('Failed to persist evidence reference')
  }

  return {
    id: row.id,
    verificationId: row.verification_id,
    evidenceHash: row.evidence_hash,
    referenceUrl: row.reference_url,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }
}

export interface SimilarEvidenceResult {
  milestoneId: string
  evidenceHash: string
  referenceUrl: string
  vectorDistance: number
  keywordDistance: number
  fusedScore: number
}

export interface FindSimilarOptions {
  limit?: number
  vectorWeight?: number
  keywordWeight?: number
}

export async function findSimilar(
  milestoneId: string,
  options: FindSimilarOptions = {},
): Promise<SimilarEvidenceResult[]> {
  const limit = options.limit ?? 5
  const vectorWeight = options.vectorWeight ?? 0.5
  const keywordWeight = options.keywordWeight ?? 0.5

  // Fetch the query milestone's embedding and evidence text
  const queryRows = await prisma.$queryRaw<
    Array<{
      embedding: string
      reference_url: string
      evidence_hash: string
    }>
  >`
    SELECT
      me.embedding::text AS embedding,
      er.reference_url,
      er.evidence_hash
    FROM milestone_embeddings me
    JOIN verifications v ON v.target_id = me.milestone_id
    JOIN evidence_references er ON er.verification_id = v.id
    WHERE me.milestone_id = ${milestoneId}
    LIMIT 1
  `

  const queryRow = queryRows[0]
  if (!queryRow) {
    return []
  }

  // We cast to vector explicitly here and calculate distances.
  const results = await prisma.$queryRaw<
    Array<{
      milestone_id: string
      evidence_hash: string
      reference_url: string
      vector_distance: number
      keyword_distance: number
      fused_score: number
    }>
  >`
    SELECT
      me.milestone_id,
      er.evidence_hash,
      er.reference_url,
      (me.embedding <=> ${queryRow.embedding}::vector) AS vector_distance,
      LEAST(
        (er.reference_url <-> ${queryRow.reference_url}),
        (er.evidence_hash <-> ${queryRow.evidence_hash})
      ) AS keyword_distance,
      (
        ((me.embedding <=> ${queryRow.embedding}::vector) * ${vectorWeight}) +
        (LEAST(
          (er.reference_url <-> ${queryRow.reference_url}),
          (er.evidence_hash <-> ${queryRow.evidence_hash})
        ) * ${keywordWeight})
      ) AS fused_score
    FROM milestone_embeddings me
    JOIN verifications v ON v.target_id = me.milestone_id
    JOIN evidence_references er ON er.verification_id = v.id
    WHERE me.milestone_id != ${milestoneId}
    ORDER BY fused_score ASC
    LIMIT ${limit}
  `

  return results.map((r) => ({
    milestoneId: r.milestone_id,
    evidenceHash: r.evidence_hash,
    referenceUrl: r.reference_url,
    vectorDistance: Number(r.vector_distance),
    keywordDistance: Number(r.keyword_distance),
    fusedScore: Number(r.fused_score),
  }))
}
