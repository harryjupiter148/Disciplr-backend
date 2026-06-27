import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { TransactionETLService } from '../services/transactionETL.js'
import { setSorobanClient, resetSorobanClient, type SorobanClient, type OnChainVaultState, getSorobanConfig } from '../services/soroban.js'
import { logVaultDriftAnomaly } from '../security/abuse-monitor.js'
import db from '../db/index.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const stellar = (): string => `G${'A'.repeat(55)}`

const makeVault = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `vault-${crypto.randomUUID()}`,
  status: 'active',
  amount: '1000',
  verifier: stellar(),
  success_destination: stellar(),
  failure_destination: stellar(),
  ...overrides,
})

const makeOnChainVault = (overrides: Partial<OnChainVaultState> = {}): OnChainVaultState => ({
  vault_id: `vault-${crypto.randomUUID()}`,
  amount: '1000',
  verifier: stellar(),
  success_destination: stellar(),
  failure_destination: stellar(),
  status: 'active',
  ...overrides,
})

// ─── Env helpers ─────────────────────────────────────────────────────────────

const FULL_ENV = {
  SOROBAN_CONTRACT_ID: 'CABCDEF1234567890',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SOROBAN_SOURCE_ACCOUNT: stellar(),
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  SOROBAN_SECRET_KEY: 'SCZANGBA5YHTNYVVV3C7CAZMCLPVAR3LXKLHEADMPROMU3QAHZGOSN6A',
}

const savedEnv: Record<string, string | undefined> = {}

const setEnv = (vars: Record<string, string>): void => {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
}

const clearSorobanEnv = (): void => {
  for (const key of Object.keys(FULL_ENV)) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
}

const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

// ─── Mock client factory ─────────────────────────────────────────────────────

const createMockClient = (
  getVaultResult?: OnChainVaultState | null,
  getVaultError?: Error,
): SorobanClient => {
  const getVaultSpy = jest.fn<SorobanClient['getVault']>()
  if (getVaultError) {
    getVaultSpy.mockRejectedValue(getVaultError)
  } else {
    getVaultSpy.mockResolvedValue(getVaultResult ?? null)
  }

  return {
    submitVaultCreation: jest.fn().mockResolvedValue({ txHash: 'mock-tx-hash' }),
    getVault: getVaultSpy,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TransactionETLService - vault reconciliation', () => {
  let etlService: TransactionETLService

  beforeEach(() => {
    clearSorobanEnv()
    resetSorobanClient()
    jest.clearAllMocks()

    etlService = new TransactionETLService({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      batchSize: 50,
      maxRetries: 3,
    })
  })

  afterEach(() => {
    restoreEnv()
    resetSorobanClient()
  })

  // ─── Soroban not configured ───────────────────────────────────────────────

  describe('when Soroban is not configured', () => {
    it('returns zero counts and skips reconciliation', async () => {
      const result = await etlService.reconcileVaults()

      expect(result).toEqual({
        totalVaults: 0,
        checked: 0,
        driftDetected: 0,
        missingOnChain: 0,
        errors: 0,
      })
    })
  })

  // ─── Status drift detection ───────────────────────────────────────────────

  describe('status drift detection', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('detects status mismatch between DB and on-chain', async () => {
      const vaultId = 'vault-status-drift-1'
      const dbVault = makeVault({ id: vaultId, status: 'active' })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, status: 'completed' })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.driftDetected).toBe(1)
      expect(result.checked).toBe(1)
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('vault_state_drift'),
      )

      logSpy.mockRestore()
    })

    it('normalizes status for case-insensitive comparison', async () => {
      const vaultId = 'vault-status-case-1'
      const dbVault = makeVault({ id: vaultId, status: 'Active' })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, status: 'active' })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.driftDetected).toBe(0)
      expect(result.checked).toBe(1)
    })
  })

  // ─── Missing on-chain vault ────────────────────────────────────────────────

  describe('missing on-chain vault', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('detects vault that exists in DB but not on-chain', async () => {
      const vaultId = 'vault-missing-1'
      const dbVault = makeVault({ id: vaultId, status: 'active' })

      const mockClient = createMockClient(null) // Vault not found on-chain
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.missingOnChain).toBe(1)
      expect(result.checked).toBe(0)
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('vault_missing_onchain'),
      )

      logSpy.mockRestore()
    })
  })

  // ─── RPC timeout handling ─────────────────────────────────────────────────

  describe('RPC timeout handling', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('handles RPC errors gracefully and continues with other vaults', async () => {
      const vaultId1 = 'vault-error-1'
      const vaultId2 = 'vault-ok-1'
      const dbVault1 = makeVault({ id: vaultId1 })
      const dbVault2 = makeVault({ id: vaultId2 })
      const onChainVault2 = makeOnChainVault({ vault_id: vaultId2 })

      const mockClient = createMockClient(onChainVault2, new Error('RPC timeout'))
      // Make the first call fail, second succeed
      mockClient.getVault = jest.fn()
        .mockRejectedValueOnce(new Error('RPC timeout'))
        .mockResolvedValueOnce(onChainVault2)

      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault1, dbVault2]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId1, vaultId2] })

      expect(result.errors).toBe(1)
      expect(result.checked).toBe(1)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error reconciling vault'),
      )

      logSpy.mockRestore()
      errorSpy.mockRestore()
    })
  })

  // ─── Fully consistent run (zero drift) ─────────────────────────────────────

  describe('fully consistent run', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('reports zero drift when all vaults match on-chain state', async () => {
      const vaultId1 = 'vault-consistent-1'
      const vaultId2 = 'vault-consistent-2'
      const dbVault1 = makeVault({ id: vaultId1, status: 'active', amount: '1000' })
      const dbVault2 = makeVault({ id: vaultId2, status: 'completed', amount: '2000' })
      const onChainVault1 = makeOnChainVault({ vault_id: vaultId1, status: 'active', amount: '1000' })
      const onChainVault2 = makeOnChainVault({ vault_id: vaultId2, status: 'completed', amount: '2000' })

      const mockClient = createMockClient()
      mockClient.getVault = jest.fn()
        .mockResolvedValueOnce(onChainVault1)
        .mockResolvedValueOnce(onChainVault2)

      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault1, dbVault2]),
      } as never)

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId1, vaultId2] })

      expect(result.totalVaults).toBe(2)
      expect(result.checked).toBe(2)
      expect(result.driftDetected).toBe(0)
      expect(result.missingOnChain).toBe(0)
      expect(result.errors).toBe(0)
    })
  })

  // ─── Batch processing with abort signal ────────────────────────────────────

  describe('batch processing with abort signal', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('processes vaults in configurable batch sizes', async () => {
      const vaults = Array.from({ length: 10 }, (_, i) => 
        makeVault({ id: `vault-batch-${i}` })
      )
      const onChainVaults = vaults.map(v => 
        makeOnChainVault({ vault_id: v.id as string, status: 'active' })
      )

      const mockClient = createMockClient()
      mockClient.getVault = jest.fn()
        .mockImplementation((config, vaultId) => {
          const vault = onChainVaults.find(v => v.vault_id === vaultId)
          return Promise.resolve(vault || null)
        })

      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue(vaults),
      } as never)

      const result = await etlService.reconcileVaults({ batchSize: 3 })

      expect(result.checked).toBe(10)
      expect(mockClient.getVault).toHaveBeenCalledTimes(10)
    })

    it('respects abort signal and stops processing', async () => {
      const vaults = Array.from({ length: 10 }, (_, i) => 
        makeVault({ id: `vault-abort-${i}` })
      )
      const onChainVaults = vaults.map(v => 
        makeOnChainVault({ vault_id: v.id as string, status: 'active' })
      )

      const mockClient = createMockClient()
      mockClient.getVault = jest.fn()
        .mockImplementation((config, vaultId) => {
          const vault = onChainVaults.find(v => v.vault_id === vaultId)
          return Promise.resolve(vault || null)
        })

      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue(vaults),
      } as never)

      const abortController = new AbortController()
      // Abort after processing 3 vaults
      mockClient.getVault = jest.fn()
        .mockImplementation(async (config, vaultId) => {
          const callCount = mockClient.getVault.mock.calls.length
          if (callCount >= 3) {
            abortController.abort()
          }
          const vault = onChainVaults.find(v => v.vault_id === vaultId)
          return vault || null
        })

      await expect(
        etlService.reconcileVaults({ batchSize: 2, signal: abortController.signal })
      ).rejects.toThrow('ETL run aborted')
    })
  })

  // ─── Field-level drift detection ───────────────────────────────────────────

  describe('field-level drift detection', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('detects amount drift', async () => {
      const vaultId = 'vault-amount-drift-1'
      const dbVault = makeVault({ id: vaultId, amount: '1000' })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, amount: '2000' })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.driftDetected).toBe(1)
      const logCall = logSpy.mock.calls.find(c => 
        (c[0] as string).includes('vault_state_drift')
      )
      expect(logCall).toBeDefined()
      expect(logCall![0]).toContain('amount')

      logSpy.mockRestore()
    })

    it('detects verifier address drift', async () => {
      const vaultId = 'vault-verifier-drift-1'
      const dbVault = makeVault({ id: vaultId, verifier: stellar() })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, verifier: stellar() })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.driftDetected).toBe(1)
      const logCall = logSpy.mock.calls.find(c => 
        (c[0] as string).includes('vault_state_drift')
      )
      expect(logCall).toBeDefined()
      expect(logCall![0]).toContain('verifier')

      logSpy.mockRestore()
    })

    it('detects destination address drift', async () => {
      const vaultId = 'vault-dest-drift-1'
      const dbVault = makeVault({ 
        id: vaultId, 
        success_destination: stellar(),
        failure_destination: stellar(),
      })
      const onChainVault = makeOnChainVault({ 
        vault_id: vaultId, 
        success_destination: stellar(),
        failure_destination: stellar(),
      })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      const result = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result.driftDetected).toBe(1)

      logSpy.mockRestore()
    })
  })

  // ─── Integration with abuse-monitor ───────────────────────────────────────

  describe('integration with abuse-monitor', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('uses logVaultDriftAnomaly for drift reporting', async () => {
      const vaultId = 'vault-abuse-1'
      const dbVault = makeVault({ id: vaultId, status: 'active' })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, status: 'completed' })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const anomalySpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      await etlService.reconcileVaults({ vaultIds: [vaultId] })

      const anomalyCall = anomalySpy.mock.calls.find(c => 
        (c[0] as string).includes('vault.vault_state_drift')
      )
      expect(anomalyCall).toBeDefined()

      anomalySpy.mockRestore()
    })
  })

  // ─── Idempotency ────────────────────────────────────────────────────────

  describe('idempotency', () => {
    beforeEach(() => {
      setEnv(FULL_ENV)
    })

    it('produces consistent results on repeated runs', async () => {
      const vaultId = 'vault-idempotent-1'
      const dbVault = makeVault({ id: vaultId, status: 'active' })
      const onChainVault = makeOnChainVault({ vault_id: vaultId, status: 'active' })

      const mockClient = createMockClient(onChainVault)
      setSorobanClient(mockClient)

      jest.spyOn(db, 'vaults').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockResolvedValue([dbVault]),
      } as never)

      const result1 = await etlService.reconcileVaults({ vaultIds: [vaultId] })
      const result2 = await etlService.reconcileVaults({ vaultIds: [vaultId] })

      expect(result1).toEqual(result2)
      expect(result1.driftDetected).toBe(0)
      expect(result1.checked).toBe(1)
    })
  })
})
