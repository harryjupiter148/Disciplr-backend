# Disciplr Soroban Contracts

On-chain programmable, time-locked capital vaults for accountability staking,
the chain-side counterpart to the `disciplr-backend` API and Horizon listener.

## Workspace layout

```text
contracts/
├── Cargo.toml                       # workspace manifest (soroban-sdk = "23")
├── README.md
└── accountability_vault/
    ├── Cargo.toml
    └── src/
        ├── lib.rs                   # AccountabilityVault contract
        └── test.rs                  # unit tests (testutils)
```

## accountability_vault

Implements the vault lifecycle that the backend models off-chain in
`src/services/vaultTransitions.ts` and parses events for in
`src/services/eventParser.ts`:

| Function | Purpose |
|---|---|
| `init` | Initialize the deployment admin that manages instance-level policy. Must be called once before allowlist administration. |
| `set_admin` | Rotate the deployment admin. Only the current admin may call this. |
| `set_allowed_token` | Add or remove a SEP-41 token contract from the instance-level allowlist used for new vaults. |
| `is_allowed_token` | Read whether a token contract is currently allowed for new vault creation. |
| `create_vault` | Create a `Draft` vault with milestones, verifier, token, and success/failure destinations. Validates amount, deadline, milestone sums, and that the requested token is allowlisted. |
| `stake` | Creator transfers the SEP-41 token into the contract; `Draft` -> `Active`. |
| `check_in` | Designated verifier confirms a milestone before its `due_date`. |
| `slash_on_miss` | After the deadline with unverified milestones, slash funds to `failure_destination`; `Active` -> `Failed`. |
| `claim` | When all milestones are verified, release funds to `success_destination`; `Active` -> `Completed`. |
| `withdraw` | Cancel/refund an unfunded or unstarted vault to the creator; -> `Cancelled`. |
| `get_vault` | Read-only accessor for the current vault record. |
| `get_unverified_milestone_indices` | Returns `Vec<u32>` of indices for milestones that have not yet been verified, in ascending order. Used by the keeper job (`src/jobs/handlers.ts`) to determine slash targets without loading and filtering the full vault client-side. |

### Token allowlist policy

`accountability_vault` enforces a deployment-wide token allowlist at vault
creation time. The admin initializes the contract with `init`, then uses
`set_allowed_token(admin, token, true)` to permit curated SEP-41 token
contracts (for example an XLM SAC or approved USDC contract) and
`set_allowed_token(admin, token, false)` to remove them. `create_vault` checks
the selected token against the instance-level `AllowedToken(token)` storage
entry and returns `Error::TokenNotAllowed` when the token is absent or has been
removed. Removing a token only blocks future vault creation; existing vault
records retain their configured token so already-created vaults can continue
their lifecycle.

The `VaultStatus` enum (`Draft`/`Active`/`Completed`/`Failed`/`Cancelled`)
mirrors `PersistedVault.status` in `src/types/vaults.ts`. Emitted events
(`vault_created`, `vault_staked`, `milestone_checked_in`, `vault_slashed`,
`vault_completed`, `vault_cancelled`, `vault_withdrawn`) align with the topics
consumed by the backend event parser.

**Error Handling and Backend Recoverability:**
Contract read operations (like `get_vault`) and state transitions (`stake`, `check_in`, `claim`) safely return `Error::NotInitialized` rather than panicking when a `vault_id` is unset in storage. The backend's `src/middleware/errorHandler.ts` relies on this typed error mapping (specifically to `ErrorCode.NOT_FOUND` with status code 404) to gracefully recover from pre-initialization read attempts.

## Build & test

```bash
# from the contracts/ directory
stellar contract build
cargo test

# Check that the compiled contract stays within the allowed size budget
# Fails if the .wasm artifact exceeds the 100KB budget (configurable via MAX_WASM_SIZE)
bash build-size-check.sh
```

### Wasm Size Budget Configuration

To prevent accidental bloat in the smart contract, the `accountability_vault` includes a size budget check (`build-size-check.sh`) integrated into the CI pipeline.
The default limit is set to **100,000 bytes** (~100KB).

If you need to update this budget as the contract grows:

1. Temporarily increase the budget locally by exporting the variable: `export MAX_WASM_SIZE=150000`
2. Update the default value in `contracts/build-size-check.sh`
3. Push the changes to update the CI limit.

## Backend integration

`src/services/soroban.ts` calls `create_vault` via the Stellar SDK
(`@stellar/stellar-sdk` v14). The Horizon listener
(`src/services/horizonListener.ts`) and `src/services/eventParser.ts`
ingest the events emitted by these functions to keep the off-chain vault state
in sync.

## Deterministic vault address derivation

Each vault is deployed as its own contract instance. The address is derived
deterministically from the deployer address and a 32-byte salt, so
`src/services/soroban.ts` can correlate the on-chain address to the off-chain
`PersistedVault.id` **before** the deploy transaction is confirmed.

### Derivation formula

```
contract_address = sha256("contract" || deployer_bytes || salt_bytes)
```

This is Soroban's built-in CREATE2-style address scheme. It can be computed
client-side using `env.deployer().with_address(deployer, salt).deployed_address()`
in Rust tests, or via the Stellar SDK `Contract.fromAddress` / deployer helpers
in TypeScript.

### Salt convention (backend)

```
salt = sha256(vault_id)   // 32-byte hash of the off-chain UUID string
```

See `src/services/soroban.ts` → `saltFromVaultId`.

### Properties

| Property | Guarantee |
|---|---|
| Same `(deployer, salt)` | Always yields the same address |
| Different `salt` | Different address (distinct vault UUIDs → distinct contracts) |
| Different `deployer` | Different address (multi-tenant safe) |

- Normal vault lifecycle (create, stake, check-in, claim, slash, withdraw)
- CEI ordering invariants: terminal state committed before token transfer
- Emergency pause/unpause: guardian blocks and re-enables settlement paths
- M-of-N verifier approvals: partial approvals, full threshold, double-approval rejection
- Allowance-based staking (`stake_from`)
- Oracle-driven milestone verification
- Joint deadline extension (`extend_deadline`)
- Disputed state: `admin_dispute` enters hold, `admin_resolve` returns to Active/Completed/Failed, `slash_on_miss` and `claim` blocked while disputed
- Gas benchmarks with hard CPU/memory bounds
- **Claim auth-chain assertions**: `env.auths()` snapshots verifying the recorded authorizer
  matches the claim caller, separately for the creator path and the verifier path

#### Auth-Chain Assertion Pattern

The `claim` function may be called by either the vault creator or any member of the verifier
set. Two dedicated tests in `test.rs` lock down this invariant using `env.auths()` snapshots
rather than a blanket `mock_all_auths`:

**Why `env.auths()`?**
`env.auths()` returns the list of `(Address, AuthorizedInvocation)` pairs that were recorded
during the most recent contract call. Asserting on this list proves that the contract called
`Address::require_auth()` for exactly the address that was passed as `caller`, and not for a
different address. This catches bugs where `require_auth()` is called on the wrong variable
or is missing entirely.

**How the tests work:**

1. Setup (`create_vault`, `stake`, `check_in`) runs under `env.mock_all_auths()` so token
   operations succeed without requiring real signatures.
2. `claim` is invoked with either `creator` or `verifier` as the caller.
3. `env.auths()` is inspected immediately after the call. The test asserts:
   - Exactly one auth entry was recorded.
   - The authorized address equals the claim caller.
   - The authorized function matches `claim(vault_id, caller)` exactly.

```rust
// After contract.claim(&vault_id, &creator):
let recorded = env.auths();
assert_eq!(recorded.len(), 1);
let (addr, invocation) = &recorded[0];
assert_eq!(addr, &creator);
assert_eq!(invocation.function, AuthorizedFunction::Contract((
    contract_id.clone(),
    Symbol::new(&env, "claim"),
    (vault_id.clone(), creator.clone()).into_val(&env),
)));
```

**Helper function:** `assert_claim_auth(env, contract_id, vault_id, caller)` encapsulates
this check and is shared by both the creator and verifier path tests, keeping each test
focused on the setup path that distinguishes them.

**What is NOT tested here:** The tests do not assert on auth entries from `stake` or
`check_in` because those calls happen in setup before the `env.auths()` snapshot is taken.
`env.auths()` only reflects the most recent invocation.

### Deployment

Deploy the contract to Soroban testnet or mainnet using the Soroban CLI:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --source <your-secret-key> \
  --network <network-passphrase>
```

### Security Considerations

1. **CEI Pattern**: All token transfers occur after state is persisted to storage.
2. **Emergency Pause**: Guardian can halt settlement paths during disputes.
3. **M-of-N Verification**: No single verifier can unilaterally release funds when
   `approval_threshold > 1`.
4. **Overflow Protection**: Milestone amount summation uses safe integer arithmetic.
5. **Input Validation**: All amounts validated for positivity; milestone amounts must sum
   exactly to the vault amount.
6. **Authorized Operations**: Creator, verifier set, guardian, and oracle roles are
   enforced via `Address::require_auth()`.

### Residual Sweep (reclaim_after_settlement)

The contract exposes `reclaim_after_settlement(token_address)` to sweep any residual token
balance (dust or rounding remainders) held by the contract back to the vault creator.

Requirements:

- Caller must be the vault `creator` (authorization enforced via `require_auth`).
- The vault must have no staked funds remaining (`staked == 0`); otherwise
  `Error::StakedRemaining` is returned.

The function queries the contract's token balance via `token::Client::balance` and performs
a `token::Client::transfer` of the full balance to the creator.

Location: `accountability_vault/src/lib.rs` — `AccountabilityVault::reclaim_after_settlement`

### License

See main repository license file.

## Accountability Vault - Key Behaviors

### Timestamp Boundary Rules
- `slash_on_miss`: 
  - `env.ledger().timestamp() <= vault.end_timestamp` → Returns `DeadlineNotReached` (exact equality is **rejected**)
  - `env.ledger().timestamp() > vault.end_timestamp` → Slash is executed
- `check_in`:
  - Exact equality (`timestamp == milestone.due_date`) is **allowed** and succeeds.

### Check-in Idempotency (#502)
- Calling `check_in` multiple times on the same milestone index returns `MilestoneAlreadyVerified` error on subsequent calls.
- This behavior is **intentional** and expected by the backend (`eventParser.ts`).

These rules are enforced through boundary and idempotency tests in `contracts/accountability_vault/src/test.rs`.
## 🔒 Soroban i128 Serialization Parity Contract

To ensure integration stability between on-chain contract telemetry and our Node.js parser (`src/services/eventParser.ts`), all values tracking asset parameters (`stake`, `claim`, `slash_on_miss`, `withdraw`) must strictly utilize native `i128` structures.

The conversion accuracy is enforced by the test configurations within `contracts/accountability_vault/src/test.rs`. If you adapt contract math or type handling, verify its compatibility against the backend `scValToNative` utility.
