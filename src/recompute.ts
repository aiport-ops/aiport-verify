// recompute-of-action — re-derive an ACP job's verdict from finalized chain state.
//
// Pure over an injected reader (unit-testable with fakes). Given a job's agreed terms and delivered
// blob, extract the delivered on-chain tx and re-check it: receipt success + finality depth + no
// reorg → pass|fail. If the deliverable references no on-chain-verifiable action, return
// 'unverifiable' — an honest abstention, never a fabricated pass. This does NOT re-execute the
// action; it confirms the delivered transaction actually landed and finalized.
import { createPublicClient, http, keccak256, toBytes, toHex, type Chain, type Hex } from 'viem'

export type AcpVerdictKind = 'pass' | 'fail' | 'unverifiable'

// The minimal job view the recompute needs — decoupled from any SDK so this stays pure.
export type AcpJobView = {
  jobId: string // decimal string
  chainId: number
  clientAddress: string
  providerAddress: string
  evaluatorAddress: string
  description: string // the negotiated requirement / terms
  budgetRaw: string // stringified raw budget (part of the agreed terms)
  deliverable: string | null // what the provider submitted
}

export type AcpChainReader = {
  getBlockNumber(): Promise<bigint>
  // null if the tx is unknown to the node (not yet mined / wrong chain)
  getReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex } | null>
  // canonical block hash at height — for the reorg-ghost check
  getBlockHash(blockNumber: bigint): Promise<Hex | null>
}

export type AcpVerdict = {
  verdict: AcpVerdictKind
  job_id: Hex // bytes32 (numeric jobId left-padded)
  poa_hash: Hex // keccak over the agreed terms
  deliverable_hash: Hex // keccak over the delivered blob
  sampled_block: bigint
  tx_hash: Hex | null // the on-chain action checked, if any
  detail: string // human-readable reason
}

// Deterministic keccak over a canonical (sorted-key) JSON encoding — the commitment primitive.
function digestJson(obj: Record<string, unknown>): Hex {
  const canonical = JSON.stringify(obj, Object.keys(obj).sort())
  return keccak256(toBytes(canonical))
}

// Encode the numeric ACP jobId as bytes32 (left-padded).
export function jobIdToBytes32(jobId: string): Hex {
  return toHex(BigInt(jobId), { size: 32 })
}

const TX_HASH_RE = /0x[0-9a-fA-F]{64}/

// Pull the first plausible tx hash out of a deliverable. Handles JSON deliverables with a
// txHash/tx_hash/transactionHash/hash field and bare-hash strings. Returns null if none.
export function extractTxHash(deliverable: string | null): Hex | null {
  if (!deliverable) return null
  try {
    const parsed = JSON.parse(deliverable)
    if (parsed && typeof parsed === 'object') {
      for (const k of ['txHash', 'tx_hash', 'transactionHash', 'hash']) {
        const v = (parsed as Record<string, unknown>)[k]
        if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) return v as Hex
      }
    }
  } catch {
    // not JSON — fall through to a raw scan
  }
  const m = deliverable.match(TX_HASH_RE)
  return m ? (m[0] as Hex) : null
}

export type RecomputeOpts = { minConfirmations?: number }

export async function recomputeAcpEval(
  job: AcpJobView,
  reader: AcpChainReader,
  opts: RecomputeOpts = {},
): Promise<AcpVerdict> {
  const minConf = opts.minConfirmations ?? 5
  const job_id = jobIdToBytes32(job.jobId)
  // PoA commitment: the agreed terms (never the outcome). Deterministic over the job's identity +
  // requirement + budget — what both parties committed to at negotiation.
  const poa_hash = digestJson({
    job_id: job.jobId,
    chain_id: job.chainId,
    client: job.clientAddress.toLowerCase(),
    provider: job.providerAddress.toLowerCase(),
    evaluator: job.evaluatorAddress.toLowerCase(),
    description: job.description,
    budget: job.budgetRaw,
  })
  const deliverable_hash = keccak256(toBytes(job.deliverable ?? ''))

  const head = await reader.getBlockNumber()
  const txHash = extractTxHash(job.deliverable)

  if (!txHash) {
    return { verdict: 'unverifiable', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: null,
      detail: 'deliverable has no on-chain tx reference — not an on-chain-verifiable action' }
  }

  const receipt = await reader.getReceipt(txHash)
  if (!receipt) {
    return { verdict: 'unverifiable', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: txHash,
      detail: `tx ${txHash} not found on chain ${job.chainId} — cannot verify yet` }
  }

  if (receipt.status === 'reverted') {
    return { verdict: 'fail', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: txHash,
      detail: `delivered tx ${txHash} reverted on chain` }
  }

  // Finality gate: require minConf confirmations before trusting the receipt.
  const confirmations = head - receipt.blockNumber + 1n
  if (confirmations < BigInt(minConf)) {
    return { verdict: 'unverifiable', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: txHash,
      detail: `tx ${txHash} only ${confirmations} confs (< ${minConf}) — not yet final` }
  }

  // Reorg-ghost check: the receipt's block must still be canonical at its height.
  const canonicalHash = await reader.getBlockHash(receipt.blockNumber)
  if (!canonicalHash || canonicalHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return { verdict: 'fail', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: txHash,
      detail: `delivered tx ${txHash} sits on an orphaned block (reorged out)` }
  }

  return { verdict: 'pass', job_id, poa_hash, deliverable_hash, sampled_block: head, tx_hash: txHash,
    detail: `delivered tx ${txHash} confirmed success at block ${receipt.blockNumber} (${confirmations} confs)` }
}

// Live reader over any EVM chain. Lazy client; only reads finalized state (no signing).
export function makeLiveAcpReader(chain: Chain, rpcUrl: string): AcpChainReader {
  let client: ReturnType<typeof createPublicClient> | undefined
  const get = () => (client ??= createPublicClient({ chain, transport: http(rpcUrl) }))
  return {
    async getBlockNumber() {
      return get().getBlockNumber()
    },
    async getReceipt(hash) {
      try {
        const r = await get().getTransactionReceipt({ hash })
        return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash }
      } catch {
        return null
      }
    },
    async getBlockHash(blockNumber) {
      try {
        const b = await get().getBlock({ blockNumber })
        return b.hash
      } catch {
        return null
      }
    },
  }
}
