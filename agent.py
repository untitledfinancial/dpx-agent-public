"""
DPX Agent — full settlement loop (Python)

Every run:
  · x402 micropayment → live macro-stress intelligence  (real USDC on Base)
  · x402 micropayment → counterparty VoP check          (real USDC on Base)
  · Settlement in sandbox by default (set SANDBOX=false to go live)

pip install httpx python-dotenv
cp .env.example .env  # add PRIVATE_KEY and RECIPIENT_ADDRESS
python agent.py
"""

import os
import json
import time
import httpx
from dotenv import load_dotenv

load_dotenv()

SANDBOX           = os.getenv("SANDBOX", "true").lower() != "false"
AMOUNT            = float(os.getenv("AMOUNT_USD", "50000"))
RECIPIENT         = os.getenv("RECIPIENT_ADDRESS", "")
RECIPIENT_NAME    = os.getenv("RECIPIENT_NAME", "Unknown")
PRIVATE_KEY       = os.getenv("PRIVATE_KEY", "")

STABILITY_URL     = "https://stability.untitledfinancial.com"
AGENT_URL         = "https://agent.untitledfinancial.com"
INTELLIGENCE_URL  = "https://intelligence.untitledfinancial.com"
COMPLIANCE_URL    = "https://compliance.untitledfinancial.com"


def x402_get(url: str) -> dict:
    """GET with x402 payment handling. Requires PRIVATE_KEY for signing."""
    # For full x402 signing, use the x402-py library or implement EIP-3009.
    # This stub shows the flow — replace with your signing implementation.
    resp = httpx.get(url, timeout=15)
    if resp.status_code == 402:
        raise NotImplementedError(
            "x402 payment required. Install x402-py or sign EIP-3009 manually.\n"
            f"Payment details: {resp.json()}"
        )
    resp.raise_for_status()
    return resp.json()


def x402_post(url: str, body: dict) -> dict:
    resp = httpx.post(url, json=body, timeout=15)
    if resp.status_code == 402:
        raise NotImplementedError(
            "x402 payment required.\n"
            f"Payment details: {resp.json()}"
        )
    resp.raise_for_status()
    return resp.json()


def run():
    if not RECIPIENT:
        raise ValueError("RECIPIENT_ADDRESS not set in .env")

    print(f"DPX Agent  {PRIVATE_KEY[:6]}...{'(sandbox)' if SANDBOX else '(live)'}\n")
    if SANDBOX:
        print("⚠  Settlement in sandbox — oracle and compliance run live, nothing moves on-chain.\n")

    # 1 — Oracle gate
    oracle = httpx.get(f"{STABILITY_URL}/reliability", timeout=10).json()
    print(f"Oracle     {oracle.get('status')}  (score: {oracle.get('score')})")
    print(f"           {oracle.get('reasoning', '')}\n")
    if oracle.get("status") == "UNSTABLE":
        raise SystemExit("Holding — oracle UNSTABLE. Retry when conditions improve.")

    # 2 — Quote
    resp = httpx.get(
        f"{AGENT_URL}/quote",
        params={"amountUsd": AMOUNT, "hasFx": "false"},
        timeout=10,
    ).json()
    quote = resp.get("quote", resp)
    quote_id  = quote.get("quoteId", "—")
    total_bps = quote.get("fees", {}).get("total", {}).get("bps", "—")
    net_usd   = quote.get("settlement", {}).get("netUsd", AMOUNT)
    print(f"Quote      ${AMOUNT:,.0f} gross · {total_bps} bps · ${net_usd:,.0f} net")
    print(f"           ID {quote_id}  (valid 300s)\n")

    # 3 — Buy macro-stress intelligence (x402)
    intel = x402_get(f"{INTELLIGENCE_URL}/v1/intelligence/macro-stress")
    score = intel.get("score") or intel.get("macroStressScore", "—")
    print(f"Intel      macro stress score: {score}")
    if intel.get("summary"):   print(f"           {intel['summary']}")
    if intel.get("reasoning"): print(f"           {intel['reasoning']}")
    print()

    # 4 — Verify counterparty (x402)
    vop = x402_post(f"{COMPLIANCE_URL}/vop/verify", {
        "walletAddress": RECIPIENT,
        "submittedName": RECIPIENT_NAME,
    })
    print(f"VoP        {vop.get('result')} · proceed: {vop.get('proceedSafe')}")
    if vop.get("message"): print(f"           {vop['message']}")
    if not vop.get("proceedSafe"):
        raise SystemExit(f"VoP blocked — {vop.get('message')}")
    print()

    # 5 — Settle
    settle_body = {
        "amount":              AMOUNT,
        "sourceCurrency":      "USD",
        "destinationCurrency": "USD",
        "recipientAddress":    RECIPIENT,
        "purpose":             "agent-payment",
        "referenceId":         f"a2a-{int(time.time())}",
        "quoteId":             quote_id,
        "sandbox":             SANDBOX,
    }
    settled = httpx.post(f"{AGENT_URL}/settle", json=settle_body, timeout=30).json()

    print(f"Settled    {settled.get('status')} · oracle {settled.get('oracleStatus')} ({settled.get('oracleScore')})")
    if settled.get("txHash"):
        print(f"On-chain   https://base.blockscout.com/tx/{settled['txHash']}")
    else:
        print("           Sandbox — no on-chain tx.")
        print("           Set SANDBOX=false in .env to go live.")


if __name__ == "__main__":
    try:
        run()
    except (KeyboardInterrupt, SystemExit) as e:
        print(f"\n✗ {e}")
    except Exception as e:
        print(f"\n✗ {e}")
        raise
