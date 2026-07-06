#!/usr/bin/env -S node --experimental-strip-types
// acp-verify — re-derive an ACP job's verdict from finalized chain state and print it.
//
//   acp-verify <chainId> <jobId> [--min-conf=5] [--rpc=<url>]
//
// Needs an ACP agent identity with access to the job (to read the delivered blob):
//   ACP_WALLET_ADDRESS, ACP_WALLET_ID, ACP_SIGNER_PRIVATE_KEY  (Privy triple)
// The verdict it prints is independently checkable by anyone from the delivered tx it reports.
import { buildAgent, loadJobView, CHAINS, type AcpTriple } from './acp.ts'
import { makeLiveAcpReader, recomputeAcpEval } from './recompute.ts'

function requiredTriple(): AcpTriple {
  const walletAddress = process.env.ACP_WALLET_ADDRESS
  const walletId = process.env.ACP_WALLET_ID
  const signerPrivateKey = process.env.ACP_SIGNER_PRIVATE_KEY
  if (!walletAddress || !walletId || !signerPrivateKey) {
    throw new Error(
      'set ACP_WALLET_ADDRESS / ACP_WALLET_ID / ACP_SIGNER_PRIVATE_KEY — an ACP agent identity with access to the job',
    )
  }
  return { walletAddress, walletId, signerPrivateKey }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const positional = args.filter((a) => !a.startsWith('--'))
  const chainId = Number(positional[0])
  const jobId = positional[1]
  if (!chainId || !jobId) {
    console.error('usage: acp-verify <chainId> <jobId> [--min-conf=5] [--rpc=<url>]')
    process.exit(1)
  }
  const chain = CHAINS[chainId]
  if (!chain) {
    console.error(`unsupported chainId ${chainId} (supported: ${Object.keys(CHAINS).join(', ')})`)
    process.exit(1)
  }
  const minConfArg = args.find((a) => a.startsWith('--min-conf='))
  const minConfirmations = minConfArg ? Number(minConfArg.split('=')[1]) : 5
  const rpcArg = args.find((a) => a.startsWith('--rpc='))
  const rpcUrl = rpcArg ? rpcArg.split('=')[1]! : (process.env.RPC_URL ?? chain.rpcUrls.default.http[0])

  const agent = await buildAgent(requiredTriple(), chainId)
  try {
    const view = await loadJobView(agent, chainId, jobId)
    if (!view) {
      console.error(`// job ${jobId} not found on chain ${chainId}`)
      process.exit(2)
    }
    const v = await recomputeAcpEval(view, makeLiveAcpReader(chain, rpcUrl), { minConfirmations })

    console.log('')
    console.log(`  // acp-verify · chain ${chainId} · job ${jobId}`)
    console.log(`  provider         : ${view.providerAddress}`)
    console.log(`  evaluator        : ${view.evaluatorAddress}`)
    console.log(`  verdict          : ${v.verdict.toUpperCase()}`)
    console.log(`  tx checked       : ${v.tx_hash ?? '(no on-chain action in deliverable)'}`)
    console.log(`  sampled block    : ${v.sampled_block}`)
    console.log(`  poa_hash         : ${v.poa_hash}`)
    console.log(`  deliverable_hash : ${v.deliverable_hash}`)
    console.log(`  detail           : ${v.detail}`)
    console.log('')
    console.log(
      JSON.stringify({
        chainId,
        jobId,
        verdict: v.verdict,
        tx_hash: v.tx_hash,
        sampled_block: v.sampled_block.toString(),
        poa_hash: v.poa_hash,
        deliverable_hash: v.deliverable_hash,
      }),
    )
  } finally {
    await agent.stop().catch(() => {})
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
