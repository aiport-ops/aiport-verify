# acp-verify

Independent verdict re-verifier for the **Agent Commerce Protocol** ([ERC-8183](https://eips.ethereum.org/EIPS/eip-8183)).

ACP releases escrow to a provider on a **single evaluator signature** — the spec has no recompute, no quorum, and no dispute path ("*No dispute resolution or arbitration; reject/expire is final*"). `acp-verify` lets you re-derive a job's verdict yourself, from finalized chain state, so an escrow release is auditable rather than taken on trust.

## What it does

Given an ACP job, `acp-verify`:

1. reads the agreed terms and the delivered blob,
2. extracts the delivered on-chain transaction,
3. re-checks that transaction against finalized state — **receipt success**, **finality depth**, and a **reorg-ghost check**,
4. returns a verdict and the two `keccak` commitments (`poa_hash` over the agreed terms, `deliverable_hash` over the delivered blob).

It does **not** re-execute the action or re-run any computation. It confirms the delivered transaction actually landed and finalized. That is a deliberately narrower, and honest, claim than "re-execution."

## Verdicts

| verdict | meaning |
|---|---|
| `pass` | the delivered tx is confirmed successful and final (≥ min confirmations, canonical block) |
| `fail` | the delivered tx reverted, or its block was reorged out |
| `unverifiable` | the deliverable references no on-chain action, or the tx is not yet final — an honest abstention, never a fabricated pass |

## Install

```bash
git clone https://github.com/aiport-ops/aiport-verify.git
cd aiport-verify
npm install
```

Requires Node 22+.

## Usage

Reading a job's delivered blob goes through the ACP job room, which the server authenticates and scopes to the job's participants. So you need an ACP agent identity (a Privy triple) with access to the job — typically its client, provider, or evaluator:

```bash
export ACP_WALLET_ADDRESS=0x...
export ACP_WALLET_ID=...
export ACP_SIGNER_PRIVATE_KEY=...   # Privy P-256 authorization key

npm run verify -- <chainId> <jobId>
# e.g.
npm run verify -- 8453 65323
```

Optional flags: `--min-conf=5` (finality depth), `--rpc=<url>` (override the RPC).

Example output:

```
  // acp-verify · chain 8453 · job 65323
  provider         : 0x654Ce91C51C2A94dbc2BCF785018Cd0021AB66F1
  evaluator        : 0xb860aC4c098a999F46E872D38e6Ac8A0EaEd11fe
  verdict          : PASS
  tx checked       : 0xb17bd923b3d23ab0e963d0627f5705776fd774f9a5afcd81195d8af43b5eb384
  sampled block    : 48263570
  poa_hash         : 0xdac152b72d14c3fe537253e37fe93e3c502c3199d0a902c6b37a373ab120c519
  deliverable_hash : 0x5c8d0ac5151c944a3e1377e1c13146c9f413e7453b6e857159b8b1d81ae07af3
  detail           : delivered tx ...b5eb384 confirmed success at block 48180492 (83079 confs)

{"chainId":8453,"jobId":"65323","verdict":"pass","tx_hash":"0xb17bd9...","sampled_block":"48263570", ... }
```

## Trusting the output

The verdict is only as trustworthy as the chain read behind it, and that read is public. Take the `tx checked` hash from any run and confirm it yourself on a block explorer or your own node: successful receipt, final, on a canonical block. `acp-verify` is a convenience over a check anyone can reproduce — not a source of authority.

## How it works

- `src/recompute.ts` — the pure verdict logic over an injected chain reader (needs only an RPC; no wallet).
- `src/acp.ts` — loads a job via the [`@virtuals-protocol/acp-node-v2`](https://github.com/Virtual-Protocol/acp-node-v2) SDK and maps it to the pure job view.
- `src/cli.ts` — the command-line entry point.

## Chains

Base mainnet (`8453`) and Base Sepolia (`84532`).

## License

MIT — built by [aiport](https://aiport.trade).
