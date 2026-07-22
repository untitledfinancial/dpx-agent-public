"""
DPX × CrewAI — Autonomous Invoice Settlement Agent
===================================================
A two-agent crew that handles the full settlement lifecycle via a single
/flow-check pre-flight call (compliance + ESG + stablecoin routing in one
request) before executing settlement.

  Flow Check Agent   — calls /flow-check; halts on BLOCKED/HOLD
  Settlement Agent   — executes settlement using the route from flow-check

Usage:
    pip install crewai dpx-sdk
    python crewai_settlement_agent.py

Set SANDBOX=false in your env to execute on Base mainnet (requires an
on-chain approve + settle from a funded wallet — DPX never holds funds).
"""

from __future__ import annotations

import os
from crewai import Agent, Task, Crew, Process
from crewai.tools import BaseTool
from pydantic import BaseModel
import httpx

# ── DPX endpoints ──────────────────────────────────────────────────────────────
AGENT_URL = "https://agent.untitledfinancial.com"

SANDBOX = os.environ.get("SANDBOX", "true").lower() != "false"

# ── Sample invoice ─────────────────────────────────────────────────────────────
INVOICE = {
    "id":                   "INV-2026-07-001",
    "amount":               85_000,
    "source_currency":      "USD",
    "destination_currency": "EUR",
    "recipient_address":    "0x0000000000000000000000000000000000000001",
    "counterparty_name":    "Berlin Supplier GmbH",
    "counterparty_lei":     "EXAMPLE_LEI_00000000000",
}


# ── CrewAI tools ───────────────────────────────────────────────────────────────

class FlowCheckInput(BaseModel):
    amount: float
    from_currency: str
    to_currency: str
    recipient_address: str
    lei: str | None = None

class FlowCheckTool(BaseTool):
    name: str = "flow_check"
    description: str = (
        "Single pre-flight call that runs AML/sanctions screening, ESG scoring, "
        "oracle stability check, and stablecoin routing in parallel. "
        "Returns status (PROCEED / HOLD / BLOCKED), block reason if applicable, "
        "and a ready-to-use settle body if PROCEED."
    )
    args_schema: type[BaseModel] = FlowCheckInput

    def _run(
        self,
        amount: float,
        from_currency: str,
        to_currency: str,
        recipient_address: str,
        lei: str | None = None,
    ) -> dict:
        params: dict = {
            "amount":           amount,
            "from":             from_currency,
            "to":               to_currency,
            "recipientAddress": recipient_address,
        }
        if lei:
            params["lei"] = lei
        r = httpx.get(f"{AGENT_URL}/flow-check", params=params, timeout=20)
        r.raise_for_status()
        return r.json()


class ExecuteSettlementInput(BaseModel):
    amount: float
    source_currency: str
    destination_currency: str
    recipient_address: str
    token: str
    sandbox: bool = True

class ExecuteSettlementTool(BaseTool):
    name: str = "execute_settlement"
    description: str = (
        "Execute a DPX settlement. In sandbox mode returns a simulated receipt. "
        "In live mode returns execution params (routerAddress, tokenAddress, "
        "grossAmountRaw, quoteIdBytes32) — the caller must approve + call "
        "router.settle() on-chain. DPX never holds funds."
    )
    args_schema: type[BaseModel] = ExecuteSettlementInput

    def _run(
        self,
        amount: float,
        source_currency: str,
        destination_currency: str,
        recipient_address: str,
        token: str,
        sandbox: bool = True,
    ) -> dict:
        body = {
            "amount":               amount,
            "sourceCurrency":       source_currency,
            "destinationCurrency":  destination_currency,
            "recipientAddress":     recipient_address,
            "token":                token,
            "sandbox":              sandbox,
        }
        r = httpx.post(f"{AGENT_URL}/settle", json=body, timeout=30)
        if r.status_code == 402:
            return {"status": "x402_required", "payment_required": r.json()}
        r.raise_for_status()
        return r.json()


# ── Agents ─────────────────────────────────────────────────────────────────────

flow_check_agent = Agent(
    role="Pre-Settlement Compliance & Routing Officer",
    goal=(
        "Run a single /flow-check call that covers AML screening, ESG scoring, "
        "oracle stability, and stablecoin routing in one request. "
        "If status is BLOCKED or HOLD, stop and report the reason. "
        "If PROCEED, pass the recommended token and settle body to the settlement agent."
    ),
    backstory=(
        "You are a compliance and routing officer embedded in an autonomous payment rail. "
        "Your job is to run a single pre-settlement check that combines sanctions screening, "
        "FATF greylist checks, ESG scoring, oracle stability, and stablecoin selection. "
        "You are conservative — HOLD and BLOCKED statuses halt the pipeline."
    ),
    tools=[FlowCheckTool()],
    verbose=True,
)

settlement_agent = Agent(
    role="Settlement Execution Agent",
    goal=(
        "Given a PROCEED status from flow-check, execute the settlement using the "
        "recommended token and settle body. Return a receipt with all on-chain "
        "execution parameters."
    ),
    backstory=(
        "You are a settlement execution agent for a cross-border payment rail. "
        "You receive a flow-check-cleared invoice and execute the payment via the "
        "DPX settlement router on Base mainnet."
    ),
    tools=[ExecuteSettlementTool()],
    verbose=True,
)

# ── Tasks ──────────────────────────────────────────────────────────────────────

flow_check_task = Task(
    description=f"""
    Run a pre-settlement flow check for this invoice:

    Counterparty: {INVOICE['counterparty_name']}
    Wallet address: {INVOICE['recipient_address']}
    LEI: {INVOICE['counterparty_lei']}
    Amount: {INVOICE['amount']} {INVOICE['source_currency']} → {INVOICE['destination_currency']}

    Call flow_check with the invoice details.

    If status is BLOCKED — STOP. Report the block reason and do not proceed.
    If status is HOLD — STOP. Report the hold reason and recommended delay.
    If status is PROCEED — output the recommended token and the full settle body
    for the settlement agent to use.
    """,
    expected_output=(
        "Flow check result: status (PROCEED/HOLD/BLOCKED), recommended token if PROCEED, "
        "settle body if PROCEED, or block/hold reason if not proceeding."
    ),
    agent=flow_check_agent,
)

settlement_task = Task(
    description=f"""
    Execute the settlement for this invoice (flow-check has already cleared it):

    Amount: {INVOICE['amount']} {INVOICE['source_currency']} → {INVOICE['destination_currency']}
    Recipient: {INVOICE['recipient_address']}
    Invoice ID: {INVOICE['id']}
    Sandbox mode: {SANDBOX}

    Use the recommended token and settle body from the flow-check result.
    Call execute_settlement with those parameters.

    Return the full settlement receipt including:
    - settlementId (or simulatedId in sandbox)
    - token used (USDC, EURC, or USDT)
    - net amount
    - execution parameters (routerAddress, tokenAddress, grossAmountRaw) if live
    - ESG contribution breakdown
    """,
    expected_output=(
        "Settlement receipt with: settlementId, token, gross and net amounts, "
        "execution parameters for on-chain completion, ESG contribution, and "
        "flow-check status confirmation."
    ),
    agent=settlement_agent,
    context=[flow_check_task],
)

# ── Crew ───────────────────────────────────────────────────────────────────────

crew = Crew(
    agents=[flow_check_agent, settlement_agent],
    tasks=[flow_check_task, settlement_task],
    process=Process.sequential,
    verbose=True,
)

if __name__ == "__main__":
    print(f"\n{'='*60}")
    print(f"DPX × CrewAI — Invoice Settlement Agent")
    print(f"Invoice: {INVOICE['id']}")
    print(f"Amount:  {INVOICE['amount']:,} {INVOICE['source_currency']} → {INVOICE['destination_currency']}")
    print(f"Mode:    {'SANDBOX' if SANDBOX else 'LIVE (Base mainnet)'}")
    print(f"{'='*60}\n")

    result = crew.kickoff()

    print(f"\n{'='*60}")
    print("SETTLEMENT COMPLETE")
    print(f"{'='*60}")
    print(result)
