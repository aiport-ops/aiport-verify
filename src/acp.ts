// acp.ts — load an ACP job by id via the acp-node-v2 SDK and map it to a pure AcpJobView.
//
// This is the credential-requiring layer. The recompute (recompute.ts) is pure and needs only an
// RPC, but reading a job's delivered blob goes through the job room's history endpoint, which the
// ACP server authenticates and scopes to the job's participants. So to load a job you need an ACP
// agent identity (a Privy triple) that has access to it — typically the job's client, provider, or
// evaluator. What it emits (verdict + the delivered tx it checked) stays independently verifiable by
// anyone straight from chain state.
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, ACP_TESTNET_SERVER_URL, TESTNET_PRIVY_APP_ID } from '@virtuals-protocol/acp-node-v2'
import { base, baseSepolia } from 'viem/chains'
import type { Chain, Hex } from 'viem'
import type { AcpJobView } from './recompute.ts'

export type AcpTriple = { walletAddress: string; walletId: string; signerPrivateKey: string }

// Supported chains. Base mainnet (8453) and Base Sepolia (84532).
export const CHAINS: Record<number, Chain> = { 8453: base, 84532: baseSepolia }

// USDC per chain — matches acp-node-v2 core/constants. AcpJob.fromOffChain sets the job budget to
// AssetToken.usdcFromRaw(rawBudget, chainId), whose .address is this; we rebuild the `rawAmount@address`
// budget form off the raw DTO so poa_hash is deterministic and reproducible.
const USDC_ADDRESSES: Record<number, string> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // base
  84532: '0xECc22a8F6fD62388498fBa19813E214605a2BDb3', // base sepolia
}

type Entry = { kind: string; from?: string; contentType?: string; content?: string }

// The delivered blob does not reliably land in the indexer's job.deliverable — it's a provider
// message in the job room. Prefer the newest provider deliverable message; fall back to null.
function deliverableFromEntries(entries: readonly Entry[], provider: string): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind !== 'message' || !e.content) continue
    if (e.from && e.from.toLowerCase() !== provider.toLowerCase()) continue
    if (e.contentType === 'deliverable' || /0x[0-9a-fA-F]{64}/.test(e.content)) return e.content
  }
  return null
}

export async function buildAgent(triple: AcpTriple, chainId: number): Promise<AcpAgent> {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`unsupported chainId ${chainId} (supported: ${Object.keys(CHAINS).join(', ')})`)
  // The SDK adapter defaults to the mainnet ACP server + mainnet Privy app; override both off-mainnet.
  const testnet = chainId !== 8453
  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    chains: [chain],
    walletAddress: triple.walletAddress as Hex,
    walletId: triple.walletId,
    signerPrivateKey: triple.signerPrivateKey,
    ...(testnet ? { serverUrl: ACP_TESTNET_SERVER_URL, privyAppId: TESTNET_PRIVY_APP_ID } : {}),
  })
  return AcpAgent.create({ provider })
}

// Fetch any job (incl. already-Completed) and map it to the pure AcpJobView the recompute consumes.
export async function loadJobView(agent: AcpAgent, chainId: number, jobId: string): Promise<AcpJobView | null> {
  const data = await agent.getApi().getJob(chainId, jobId)
  if (!data) return null
  const usdc = USDC_ADDRESSES[data.chainId]
  if (!usdc) throw new Error(`no USDC address configured for chain ${data.chainId}`)
  const entries = (await agent.getTransport().getHistory(chainId, jobId)) as Entry[]
  const deliverable = data.deliverable ?? deliverableFromEntries(entries, data.providerAddress)
  return {
    jobId: data.onChainJobId,
    chainId: data.chainId,
    clientAddress: data.clientAddress,
    providerAddress: data.providerAddress,
    evaluatorAddress: data.evaluatorAddress,
    description: data.description ?? '',
    budgetRaw: `${BigInt(data.budget ?? '0')}@${usdc.toLowerCase()}`,
    deliverable,
  }
}
