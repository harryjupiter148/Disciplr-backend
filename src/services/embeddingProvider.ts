const EMBEDDING_DIMENSIONS = 768

export interface EmbeddingProvider {
  readonly modelVersion: string
  embed(text: string): Promise<number[]>
}

/**
 * Deterministic, network-free embedding provider used as the default so the
 * reindex job and its tests never depend on a real embedding API. Two calls
 * with the same text always produce the same vector, which is what makes the
 * backfill idempotent.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly modelVersion: string) {}

  async embed(text: string): Promise<number[]> {
    let seed = hashString(`${this.modelVersion}:${text}`)
    const vector: number[] = []
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff
      vector.push((seed & 0xffff) / 0xffff - 0.5)
    }
    const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0))
    return norm === 0 ? vector : vector.map((value) => value / norm)
  }
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

export const CURRENT_EMBEDDING_MODEL_VERSION = process.env.EMBEDDING_MODEL_VERSION ?? 'deterministic-v1'

export const createEmbeddingProvider = (
  modelVersion: string = CURRENT_EMBEDDING_MODEL_VERSION,
): EmbeddingProvider => new DeterministicEmbeddingProvider(modelVersion)
