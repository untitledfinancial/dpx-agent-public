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

## Quickstart

```bash
git clone https://github.com/untitledfinancial/dpx-agent
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
