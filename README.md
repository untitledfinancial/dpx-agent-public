# DPX Agent

**Your AI agent, with payments.**

Fork this. Run it. Your agent will check global conditions, get a binding fee quote, pay for live intelligence via x402, verify the counterparty, and settle — all without a human in the loop.

```
oracle gate → quote → buy intel (x402) → verify counterparty → settle
```

---

## Why this exists

Most AI agents hit a wall when they need to move money. You can reason, plan, and call APIs — but the payment step breaks the loop and sends it back to a human. DPX closes that gap.

DPX is a settlement rail native to AI agents. It speaks MCP, x402, and REST. Compliance and stability checks run at the protocol level so your agent doesn't have to implement them. Every settlement is oracle-gated — the system holds automatically if global conditions are wrong.

No API key. No account. No onboarding.

---

## What runs on every execution

| Step | What happens | Cost |
|---|---|---|
| **Oracle gate** | 9-layer stability check across climate, macro, FX, geopolitical | Free |
| **Quote** | Binding fee breakdown, valid 300s | Free |
| **Buy intel** | x402 micropayment → live macro-stress score + AI reasoning | ~$0.001 USDC |
| **Verify counterparty** | x402 micropayment → legal entity registry + FATF R16 check | ~$0.001 USDC |
| **Settle** | Oracle-gated, compliance-screened settlement | Sandbox by default |

Steps 3 and 4 are live x402 payments on Base mainnet — your wallet signs automatically on the 402 response.  
Step 5 is sandbox by default. One env var change goes live.

---

## Quickstart

```bash
git clone https://github.com/untitledfinancial/dpx-agent-public
cd dpx-agent-public
npm install
cp .env.example .env
```

Edit `.env`:
```
PRIVATE_KEY=0x...         # Base wallet private key (needs small USDC balance)
RECIPIENT_ADDRESS=0x...   # Destination wallet
AMOUNT_USD=50000          # Settlement amount in USD
SANDBOX=true              # Change to false for live on-chain settlement
```

```bash
npm start
```

Output:

```
DPX Agent  0x1234567890123456789012345678901234567890

⚠  Settlement in sandbox — oracle and compliance run live, nothing moves on-chain.

Oracle     STABLE  (score: 91)
           Yield curve normal, FX stress low. Conditions clear.

Quote      $50,000 gross · 85 bps · $49,575 net
           ID dpx_a1b2c3d4e5f6  (valid 300s)

Intel      macro stress score: 14
           Low systemic stress. Credit spreads tight, liquidity normal.

VoP        NOT_REGISTERED · proceed: true
           Wallet not in registry — no identity issue flagged.

Settled    executed · oracle STABLE (91)
           Sandbox — no on-chain tx.
           Set SANDBOX=false in .env to go live.
```

**To go live:** set `SANDBOX=false`. Fund your wallet with USDC on Base equal to the gross settlement amount.

---

## Python version

Same loop, works with any Python agent framework:

```bash
pip install httpx python-dotenv
python agent.py
```

See [`examples/`](./examples/) for LangGraph and CrewAI integrations.

---

## Use it as a building block

This is a reference loop, not a finished product. Drop it into any agent that generates a payment obligation:

```typescript
import { runSettlement } from './agent';

const result = await runSettlement({
  amount: invoiceAmount,
  recipient: supplierWallet,
  sandbox: false,
});

if (result.txHash) {
  // Payment confirmed on Base mainnet
  console.log(`https://base.blockscout.com/tx/${result.txHash}`);
}
```

---

## MCP — Claude Desktop and Cursor

If you're building with Claude Desktop or Cursor, use the MCP server instead of the REST API:

```json
{
  "mcpServers": {
    "dpx": {
      "command": "npx",
      "args": ["@untitledfinancial/dpx-mcp"]
    }
  }
}
```

72 tools available natively: `settlement.quote`, `settlement.execute`, `compliance.screen`, `esg.score`, `search_docs`, and more. Your agent calls them like any other tool — no HTTP, no auth setup.

---

## What x402 is

Steps 3 and 4 use [HTTP 402](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) — the payment standard built for AI agents. When a server returns 402, the client signs a USDC transfer on Base and retries. The `x402-fetch` library handles this automatically:

```typescript
import { wrapFetchWithPayment } from 'x402-fetch';
const fetchX402 = wrapFetchWithPayment(fetch, signer);

// Pays automatically if server returns 402
const data = await fetchX402('https://intelligence.untitledfinancial.com/v1/intelligence/macro-stress');
```

No manual payment flow. No out-of-band wallet management. The agent pays for what it uses, when it uses it.

---

## Requirements

- Node 18+ (TypeScript) or Python 3.10+
- A Base wallet with a small USDC balance (~$0.01 covers many sandbox runs)
- `PRIVATE_KEY` and `RECIPIENT_ADDRESS` in `.env`

---

## Framework examples

| Framework | File |
|---|---|
| LangGraph | [`examples/langgraph_agent.py`](./examples/langgraph_agent.py) |
| CrewAI | [`examples/crewai_agent.py`](./examples/crewai_agent.py) |

---

## Docs

[docs.untitledfinancial.com](https://docs.untitledfinancial.com) · [Agent Quick Start](https://docs.untitledfinancial.com/agent-quickstart) · [x402 reference](https://docs.untitledfinancial.com/integrations/x402) · [MCP tools](https://docs.untitledfinancial.com/integrations/mcp)
