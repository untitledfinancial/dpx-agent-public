# dpx-agent

A working agent that runs the full DPX settlement loop. Fork it, run it — every run generates real traceable calls on Base.

```
check conditions → quote → buy macro data (x402) → verify counterparty (x402) → settle
```

## What runs live on every execution

| Step | Call | Cost |
|---|---|---|
| Oracle check | Stability conditions across 10 signal layers | Free |
| Quote | Binding fee breakdown | Free |
| Buy macro-stress data | x402 micropayment → current conditions score + reasoning | USDC on Base |
| Verify counterparty | x402 micropayment → GLEIF registry check, FATF R16 | $0.075 USDC |
| Settle | Oracle-gated, compliance-screened settlement | **Sandbox by default** |

Steps 3 and 4 are live x402 payments on Base mainnet every time the agent runs.  
Step 5 is sandbox by default — real oracle checks, real compliance, nothing on-chain.

> **To go live:** set `SANDBOX=false` in `.env`. Fund the wallet with USDC on Base equal to the gross settlement amount. One line change.

## Output

```
DPX Agent  0x71C7656EC7ab88b098defB751B7401B5f6d8976F

⚠  Settlement in sandbox — oracle and compliance run live, nothing moves on-chain.

Oracle     STABLE  (score: 91)
           Yield curve normal, FX stress low. Conditions clear.

Quote      $50,000 gross · 85 bps · $49,575 net
           ID dpx_a1b2c3d4e5f6  (valid 300s)

Intel      macro stress score: 14
           Low systemic stress. Credit spreads tight, liquidity normal.

VoP        NOT_REGISTERED · proceed: true
           Wallet not in registry — no identity to verify.

Settled    executed · oracle STABLE (91)
           Sandbox — no on-chain tx.
           Set SANDBOX=false in .env to go live.
```

Steps 3 and 4 (`Intel`, `VoP`) are real USDC payments on Base mainnet — wallet signs automatically on 402 response.

---

## Quickstart

```bash
git clone https://github.com/untitledfinancial/dpx-agent-public
cd dpx-agent
npm install
cp .env.example .env
# add PRIVATE_KEY and RECIPIENT_ADDRESS to .env
npm start
```

Your wallet needs a small USDC balance on Base for the x402 calls in steps 3 and 4.

## Requirements

- Node 18+
- A Base wallet with USDC (for the live x402 payments in steps 3 and 4)

## Protocol reference

[docs.untitledfinancial.com](https://docs.untitledfinancial.com)
