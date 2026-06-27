import { Knex } from 'knex'
import { ParsedEvent } from '../types/horizonSync.js'
import { createHash } from 'node:crypto'

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key conflict') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

type StoredIdempotencyEntry = {
  hash: string
  response: unknown
  expiresAt: number
}

type PendingIdempotencyRequest = {
  hash: string
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

// In-memory store for idempotent responses (replaces DB for now)
const idempotencyStore = new Map<string, StoredIdempotencyEntry>()
const pendingIdempotencyRequests = new Map<string, PendingIdempotencyRequest>()
let idempotencyTtlMs = Number(process.env.IDEMPOTENCY_TTL_MS ?? 60 * 60 * 1000)

export function hashRequestPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(key)
    }
  }
}

export function setIdempotencyTtlMs(ttlMs: number): void {
  idempotencyTtlMs = ttlMs
}

export async function getIdempotentResponse<T>(key: string, hash: string): Promise<T | null> {
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(key)
  if (pending) {
    if (pending.hash !== hash) {
      throw new IdempotencyConflictError()
    }

    return pending.promise as Promise<T>
  }

  const entry = idempotencyStore.get(key)
  if (!entry) {
    let resolve!: (value: unknown) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })

    pendingIdempotencyRequests.set(key, { hash, promise, resolve, reject })
    return null
  }

  if (entry.hash !== hash) throw new IdempotencyConflictError()
  return entry.response as T
}

export async function saveIdempotentResponse(
  key: string,
  hash: string,
  _id: string,
  response: unknown
): Promise<void> {
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(key)
  if (pending) {
    pendingIdempotencyRequests.delete(key)
    pending.resolve(response)
  }

  idempotencyStore.set(key, { hash, response, expiresAt: Date.now() + idempotencyTtlMs })
}

export function failPendingIdempotentResponse(key: string, hash: string, error: unknown): void {
  const pending = pendingIdempotencyRequests.get(key)
  if (!pending || pending.hash !== hash) {
    return
  }

  pendingIdempotencyRequests.delete(key)
  pending.reject(error)
}

export function resetIdempotencyStore(): void {
  idempotencyStore.clear()
  pendingIdempotencyRequests.clear()
}

/**
 * Idempotency Service
 * Handles checking and recording of processed operations to ensure exactly-once execution.
 */
export class IdempotencyService {
  private db: Knex

  constructor(db: Knex) {
    this.db = db
  }

  /**
   * Check if an event has already been processed.
   * 
   * @param eventId - Unique ID of the event
   * @param trx - Optional transaction to use for the check
   * @returns Promise<boolean> - True if already processed
   */
  async isEventProcessed(eventId: string, trx?: Knex.Transaction): Promise<boolean> {
    const query = (trx || this.db)('processed_events')
      .where({ event_id: eventId })
      .first()
    
    const result = await query
    return !!result
  }

  /**
   * Mark an event as processed in the database.
   * MUST be called within a transaction that includes the business logic operations.
   * 
   * @param event - The parsed event being processed
   * @param trx - Transaction to use for recording
   */
  async markEventProcessed(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    await trx('processed_events').insert({
      event_id: event.eventId,
      transaction_hash: event.transactionHash,
      event_index: event.eventIndex,
      ledger_number: event.ledgerNumber,
      processed_at: new Date(),
      created_at: new Date()
    })
  }

  /**
   * General-purpose idempotency check for API requests.
   * Checks the idempotency_keys table.
   * 
   * @param key - The idempotency key provided by the client
   * @returns Promise<any | null> - The stored response if found, null otherwise
   */
  async getStoredResponse(key: string): Promise<any | null> {
    const record = await this.db('idempotency_keys')
      .where({ key })
      .first()
    
    return record ? record.response : null
  }

  /**
   * Store a response for a given idempotency key.
   * 
   * @param key - The idempotency key
   * @param response - The response payload to store
   * @param trx - Optional transaction
   */
  async storeResponse(key: string, response: any, trx?: Knex.Transaction): Promise<void> {
    await (trx || this.db)('idempotency_keys').insert({
      key,
      response: typeof response === 'string' ? response : JSON.stringify(response),
      created_at: new Date()
    })
  }
}
