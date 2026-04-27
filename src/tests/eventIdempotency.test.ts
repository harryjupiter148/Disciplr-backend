import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import knex, { Knex } from 'knex'
import { EventProcessor } from '../services/eventProcessor.js'
import { CheckpointStore } from '../services/checkpointStore.js'
import { ParsedEvent } from '../types/horizonSync.js'

// ── DB setup ──────────────────────────────────────────────────────────────────

let db: Knex
let processor: EventProcessor
let checkpointStore: CheckpointStore

const DB_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'

beforeAll(async () => {
  db = knex({ client: 'pg', connection: DB_URL })
  await db.migrate.latest()
  processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 10 })
  checkpointStore = new CheckpointStore(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await db('horizon_checkpoints').del()
  await db('validations').del()
  await db('milestones').del()
  await db('vaults').del()
  await db('processed_events').del()
  await db('failed_events').del()
})

// ── helpers ───────────────────────────────────────────────────────────────────

function vaultCreatedEvent(id: string, ledger = 100): ParsedEvent {
  return {
    eventId: `tx-${id}:0`,
    transactionHash: `tx-${id}`,
    eventIndex: 0,
    ledgerNumber: ledger,
    eventType: 'vault_created',
    payload: {
      vaultId: id,
      creator: 'GCREATOR',
      amount: '100',
      startTimestamp: new Date(),
      endTimestamp: new Date(Date.now() + 100_000),
      successDestination: 'GSUCCESS',
      failureDestination: 'GFAIL',
      status: 'active',
    },
  }
}

// ── Event Processor Idempotency ───────────────────────────────────────────────

describe('Event Processor Idempotency', () => {
  it('should process a vault_created event and ignore duplicates', async () => {
    const event = vaultCreatedEvent('vault-unique-1')

    const result1 = await processor.processEvent(event)
    expect(result1.success).toBe(true)

    const count1 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as n').first()
    expect(Number(count1?.n)).toBe(1)

    // Duplicate processing
    const result2 = await processor.processEvent(event)
    expect(result2.success).toBe(true)

    const count2 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as n').first()
    expect(Number(count2?.n)).toBe(1) // still 1 — no duplicate inserted

    const processedCount = await db('processed_events')
      .where({ event_id: `tx-vault-unique-1:0` })
      .count('* as n')
      .first()
    expect(Number(processedCount?.n)).toBe(1)
  })

  it('should maintain idempotency for milestone creation', async () => {
    await db('vaults').insert({
      id: 'vault-m',
      creator: 'GCREATOR',
      amount: '100',
      start_timestamp: new Date(),
      end_timestamp: new Date(Date.now() + 100_000),
      success_destination: 'GSUCCESS',
      failure_destination: 'GFAIL',
      status: 'active',
      created_at: new Date(),
    })

    const event: ParsedEvent = {
      eventId: 'tx2:op1',
      transactionHash: 'tx2',
      eventIndex: 1,
      ledgerNumber: 101,
      eventType: 'milestone_created',
      payload: {
        milestoneId: 'ms-unique-1',
        vaultId: 'vault-m',
        title: 'Milestone 1',
        description: 'First milestone',
        targetAmount: '50',
        deadline: new Date(),
      },
    }

    await processor.processEvent(event)
    await processor.processEvent(event) // duplicate

    const count = await db('milestones').where({ id: 'ms-unique-1' }).count('* as n').first()
    expect(Number(count?.n)).toBe(1)
  })

  it('should handle concurrent processing attempts gracefully', async () => {
    const event = vaultCreatedEvent('vault-concurrent', 102)

    const [res1, res2] = await Promise.all([
      processor.processEvent(event),
      processor.processEvent(event),
    ])

    expect(res1.success).toBe(true)
    expect(res2.success).toBe(true)

    const count = await db('vaults').where({ id: 'vault-concurrent' }).count('* as n').first()
    expect(Number(count?.n)).toBe(1)
  })
})

// ── CheckpointStore Integration ───────────────────────────────────────────────

describe('CheckpointStore integration', () => {
  const CONTRACT_A = 'CCONTRACT_A_TEST'
  const CONTRACT_B = 'CCONTRACT_B_TEST'

  it('returns null when no checkpoint exists for a contract', async () => {
    const result = await checkpointStore.getCheckpoint(CONTRACT_A)
    expect(result).toBeNull()
  })

  it('creates a checkpoint and retrieves it', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 5000, 'tok-5000')
    const cp = await checkpointStore.getCheckpoint(CONTRACT_A)

    expect(cp).not.toBeNull()
    expect(cp!.contractAddress).toBe(CONTRACT_A)
    expect(cp!.lastLedger).toBe(5000)
    expect(cp!.lastPagingToken).toBe('tok-5000')
  })

  it('advances an existing checkpoint with upsert', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 100, 'tok-100')
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 200, 'tok-200')

    const cp = await checkpointStore.getCheckpoint(CONTRACT_A)
    expect(cp!.lastLedger).toBe(200)
    expect(cp!.lastPagingToken).toBe('tok-200')
  })

  it('stores independent checkpoints for different contracts', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 1000, 'tok-a')
    await checkpointStore.upsertCheckpoint(CONTRACT_B, 2000, 'tok-b')

    const cpA = await checkpointStore.getCheckpoint(CONTRACT_A)
    const cpB = await checkpointStore.getCheckpoint(CONTRACT_B)

    expect(cpA!.lastLedger).toBe(1000)
    expect(cpB!.lastLedger).toBe(2000)
  })

  it('getAllCheckpoints returns all rows ordered by contract_address', async () => {
    await checkpointStore.upsertCheckpoint('ZZZ_CONTRACT', 300)
    await checkpointStore.upsertCheckpoint('AAA_CONTRACT', 100)
    await checkpointStore.upsertCheckpoint('MMM_CONTRACT', 200)

    const all = await checkpointStore.getAllCheckpoints()
    const addresses = all.map((c) => c.contractAddress)

    // Should be alphabetically sorted
    expect(addresses.indexOf('AAA_CONTRACT')).toBeLessThan(addresses.indexOf('MMM_CONTRACT'))
    expect(addresses.indexOf('MMM_CONTRACT')).toBeLessThan(addresses.indexOf('ZZZ_CONTRACT'))
  })

  it('resetCheckpoint sets an arbitrary ledger (including backwards)', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 9000, 'tok-9000')
    await checkpointStore.resetCheckpoint(CONTRACT_A, 500, 'tok-reset')

    const cp = await checkpointStore.getCheckpoint(CONTRACT_A)
    expect(cp!.lastLedger).toBe(500)
    expect(cp!.lastPagingToken).toBe('tok-reset')
  })

  it('deleteCheckpoint removes the row entirely', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 1234)
    await checkpointStore.deleteCheckpoint(CONTRACT_A)

    const cp = await checkpointStore.getCheckpoint(CONTRACT_A)
    expect(cp).toBeNull()
  })

  it('deleteCheckpoint on a non-existent contract does not throw', async () => {
    await expect(checkpointStore.deleteCheckpoint('NONEXISTENT')).resolves.not.toThrow()
  })

  it('accepts a null paging token', async () => {
    await checkpointStore.upsertCheckpoint(CONTRACT_A, 777, null)
    const cp = await checkpointStore.getCheckpoint(CONTRACT_A)
    expect(cp!.lastPagingToken).toBeNull()
  })
})

// ── Restart / Resume Integration ──────────────────────────────────────────────

describe('Restart / Resume scenario', () => {
  const CONTRACT = 'CRESTART_TEST'

  it('survives a simulated restart: checkpoint persists across CheckpointStore instances', async () => {
    // First "run": write a checkpoint
    const store1 = new CheckpointStore(db)
    await store1.upsertCheckpoint(CONTRACT, 7777, 'tok-7777')

    // Simulate restart: new store instance (same underlying db)
    const store2 = new CheckpointStore(db)
    const cp = await store2.getCheckpoint(CONTRACT)

    expect(cp).not.toBeNull()
    expect(cp!.lastLedger).toBe(7777)
    expect(cp!.lastPagingToken).toBe('tok-7777')
  })

  it('replays events from the minimum checkpoint across two contracts', async () => {
    // Seed checkpoints: A is ahead, B is behind
    const store = new CheckpointStore(db)
    await store.upsertCheckpoint('CA', 10000, 'tok-10k')
    await store.upsertCheckpoint('CB', 500, 'tok-500')

    // A consumer simulating how the listener would pick the stream start:
    const cpA = await store.getCheckpoint('CA')
    const cpB = await store.getCheckpoint('CB')

    const ledgerA = cpA?.lastLedger ?? 1
    const ledgerB = cpB?.lastLedger ?? 1
    const effectiveStart = Math.min(ledgerA, ledgerB)

    expect(effectiveStart).toBe(500) // stream from the lowest confirmed ledger
  })

  it('processes an event and persists checkpoint in the same logical unit', async () => {
    // Process a vault_created event
    const event = vaultCreatedEvent('vault-resume-test', 8888)
    const result = await processor.processEvent(event)
    expect(result.success).toBe(true)

    // Simulate the listener writing the checkpoint after success
    const store = new CheckpointStore(db)
    await store.upsertCheckpoint(CONTRACT, event.ledgerNumber, 'tok-8888')

    // Verify both the vault and the checkpoint are persisted
    const vault = await db('vaults').where({ id: 'vault-resume-test' }).first()
    expect(vault).toBeDefined()

    const cp = await store.getCheckpoint(CONTRACT)
    expect(cp!.lastLedger).toBe(8888)
  })

  it('re-delivers already-processed events without side effects after restart', async () => {
    // First processing run
    const event = vaultCreatedEvent('vault-redeliver', 9000)
    await processor.processEvent(event)
    await checkpointStore.upsertCheckpoint(CONTRACT, 9000, 'tok-9000')

    // Simulate crash + restart: re-deliver the same event
    const result = await processor.processEvent(event)
    expect(result.success).toBe(true)

    // Vault must still exist exactly once
    const count = await db('vaults').where({ id: 'vault-redeliver' }).count('* as n').first()
    expect(Number(count?.n)).toBe(1)
  })

  it('upsertCheckpoint within a transaction rolls back atomically on error', async () => {
    const trx = await db.transaction()

    try {
      await checkpointStore.upsertCheckpoint(CONTRACT, 5555, 'tok-5555', trx)
      throw new Error('Simulated failure')
    } catch {
      await trx.rollback()
    }

    // Checkpoint should NOT have been persisted
    const cp = await checkpointStore.getCheckpoint(CONTRACT)
    expect(cp).toBeNull()
  })
})
