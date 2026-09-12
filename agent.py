"""
DPX Agent — full settlement loop (Python)

Every run:
  · x402 micropayment → live macro-stress intelligence  (real USDC on Base)
  · x402 micropayment → counterparty VoP check          (real USDC on Base)
  · Settlement in sandbox by default (set SANDBOX=false to go live)

pip install httpx python-dotenv eth-account
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


def _sign_x402(payment_details: dict) -> str:
    """Sign an EIP-3009 transferWithAuthorization for x402 payment."""
    from eth_account import Account
    from eth_account.messages import encode_defunct
    import time, secrets

    account  = Account.from_key(PRIVATE_KEY)
    valid_after  = int(time.time()) - 10
    valid_before = int(time.time()) + 300
    nonce = "0x" + secrets.token_hex(32)

    # EIP-3009 transferWithAuthorization
    accepts = payment_details.get("accepts", [{}])[0]
    domain = {
        "name":              accepts.get("extra", {}).get("name", "USD Coin"),
        "version":           accepts.get("extra", {}).get("version", "2"),
        "chainId":           8453,  # Base mainnet
        "verifyingContract": accepts.get("asset"),
    }
    message = {
        "from":         account.address,
        "to":           accepts.get("payTo"),
        "value":        int(accepts.get("maxAmountRequired", "1000")),
        "validAfter":   valid_after,
        "validBefore":  valid_before,
        "nonce":        nonce,
    }
    # Encode and sign
    structured = {
        "types": {
            "EIP712Domain": [
                {"name": "name",              "type": "string"},
                {"name": "version",           "type": "string"},
                {"name": "chainId",           "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from",        "type": "address"},
                {"name": "to",         "type": "address"},
                {"name": "value",      "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore","type": "uint256"},
                {"name": "nonce",      "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": domain,
        "message": message,
    }
    signed = Account.sign_typed_data(account.key, full_message=structured)
    payload = {
        "x402Version": 1,
        "scheme":      "exact",
        "network":     "base",
        "payload": {
            "signature":   signed.signature.hex(),
            "authorization": {
                "from":        account.address,
                "to":          accepts.get("payTo"),
                "value":       str(int(accepts.get("maxAmountRequired", "1000"))),
                "validAfter":  str(valid_after),
                "validBefore": str(valid_before),
                "nonce":       nonce,
            },
        },
    }
    import json, base64
    return base64.b64encode(json.dumps(payload).encode()).decode()


def x402_get(url: str) -> dict:
    resp = httpx.get(url, timeout=15)
    if resp.status_code == 402:
        if not PRIVATE_KEY:
            print(f"[demo] x402 payment required for {url} — skipping (no PRIVATE_KEY)")
            return {}
        token = _sign_x402(resp.json())
        resp  = httpx.get(url, headers={"X-PAYMENT": token}, timeout=15)
    resp.raise_for_status()
    return resp.json()


def x402_post(url: str, body: dict) -> dict:
    resp = httpx.post(url, json=body, timeout=15)
    if resp.status_code == 402:
        if not PRIVATE_KEY:
            print(f"[demo] x402 payment required for {url} — skipping (no PRIVATE_KEY)")
            return {"result": "NOT_REGISTERED", "proceedSafe": True, "message": "[demo] skipped"}
        token = _sign_x402(resp.json())
        resp  = httpx.post(url, json=body, headers={"X-PAYMENT": token}, timeout=15)
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
