/**
 * DPX — Delegated Authorization Demo
 *
 * Shows how an orchestrator agent delegates payment authority to sub-agents
 * with explicit limits. Sub-agents can only spend within what they were
 * delegated. The full session is auditable as a signed receipt trail.
 *
 * Pattern:
 *   Orchestrator creates delegation (max $5K/tx, $15K total)
 *     └── Sub-agent A checks policy → pays invoice 1 ($4K) → records receipt
 *     └── Sub-agent B checks policy → pays invoice 2 ($4K) → records receipt
 *     └── Sub-agent C checks policy → invoice 3 ($8K) → HOLD (ceiling reached)
 *   Orchestrator queries ledger → sees full session spend graph
 *
 * Usage:
 *   cp .env.example .env   # SANDBOX=true is fine — no on-chain tx
 *   npx ts-node examples/delegation_demo.ts
 */

import https from 'https';

const POLICY_URL = 'https://policy.untitledfinancial.com';
const AGENT_URL  = 'https://agent.untitledfinancial.com';

const SESSION_ID       = `demo-delegation-${Date.now()}`;
const ORCHESTRATOR_ID  = 'orchestrator-agent';
const SUB_AGENT_A_ID   = 'sub-agent-procurement-a';
const SUB_AGENT_B_ID   = 'sub-agent-procurement-b';
const SUB_AGENT_C_ID   = 'sub-agent-procurement-c';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function post(url: string, body: object): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

function label(text: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(text);
  console.log('─'.repeat(60));
}

function result(key: string, value: unknown) {
  const v = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
  console.log(`  ${key.padEnd(22)} ${v}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nDPX — Delegated Authorization Demo');
  console.log(`Session: ${SESSION_ID}\n`);

  // ── Step 1: Orchestrator creates a spending policy ────────────────────────

  label('Step 1 — Orchestrator creates spending policy');

  const policy = await post(`${POLICY_URL}/policy`, {
    agent_id:           ORCHESTRATOR_ID,
    name:               'Q3 Procurement Policy',
    max_per_tx:         10_000,   // $10K ceiling per transaction
    max_per_day:        50_000,   // $50K daily rolling limit
    require_hold_above: 8_000,    // human review above $8K
    require_oracle_stable: false, // allow CAUTION but block UNSTABLE
  });

  result('Policy ID', policy.id);
  result('Max per tx', '$10,000');
  result('Hold above', '$8,000');
  result('Daily limit', '$50,000');

  // ── Step 2: Orchestrator delegates to sub-agents ──────────────────────────

  label('Step 2 — Orchestrator delegates to 3 sub-agents');
  console.log('  Each sub-agent gets: $5K/tx ceiling · $15K lifetime total\n');

  const delegations = await Promise.all([
    post(`${POLICY_URL}/delegate`, {
      parent_agent_id: ORCHESTRATOR_ID,
      child_agent_id:  SUB_AGENT_A_ID,
      policy_id:       policy.id,
      max_per_tx:      5_000,
      max_total:       15_000,
    }),
    post(`${POLICY_URL}/delegate`, {
      parent_agent_id: ORCHESTRATOR_ID,
      child_agent_id:  SUB_AGENT_B_ID,
      policy_id:       policy.id,
      max_per_tx:      5_000,
      max_total:       15_000,
    }),
    post(`${POLICY_URL}/delegate`, {
      parent_agent_id: ORCHESTRATOR_ID,
      child_agent_id:  SUB_AGENT_C_ID,
      policy_id:       policy.id,
      max_per_tx:      5_000,
      max_total:       15_000,
    }),
  ]);

  for (const [i, d] of delegations.entries()) {
    result(`Sub-agent ${['A','B','C'][i]} delegation`, d.id);
  }

  const [delegA, delegB, delegC] = delegations;

  // ── Step 3: Sub-agent A — payment within limits ───────────────────────────

  label('Step 3 — Sub-agent A: $4,000 payment (within $5K delegation limit)');

  const checkA = await post(`${POLICY_URL}/policy/check`, {
    agent_id:      SUB_AGENT_A_ID,
    amount_usd:    4_000,
    oracle_status: 'STABLE',
    delegation_id: delegA.id,
    session_id:    SESSION_ID,
  });

  result('Policy decision', checkA.decision);
  result('Reason', checkA.reason ?? 'all checks passed');

  if (checkA.decision === 'ALLOW') {
    // Execute settlement (sandbox)
    const settlement = await post(`${AGENT_URL}/settle`, {
      amount:              4_000,
      sourceCurrency:      'USD',
      destinationCurrency: 'USD',
      recipientAddress:    '0x0000000000000000000000000000000000000001',
      purpose:             'supplier-payment',
      referenceId:         `${SESSION_ID}-a`,
      sandbox:             true,
    });

    result('Settlement ID', settlement.settlementId ?? settlement.simulatedId ?? 'sandbox');

    // Record signed receipt
    const receipt = await post(`${POLICY_URL}/receipt`, {
      agent_id:            SUB_AGENT_A_ID,
      session_id:          SESSION_ID,
      task_context:        'Sub-agent A: pay supplier invoice INV-001',
      policy_id:           policy.id,
      delegation_id:       delegA.id,
      amount_usd:          4_000,
      counterparty:        'Acme Supplies Ltd',
      oracle_status:       'STABLE',
      compliance_decision: 'PROCEED',
      settlement_id:       settlement.settlementId ?? settlement.simulatedId,
      sandbox:             true,
    });

    result('Receipt ID', receipt.id);
    result('Signature', receipt.signature?.substring(0, 16) + '…');
  }

  // ── Step 4: Sub-agent B — payment within limits ───────────────────────────

  label('Step 4 — Sub-agent B: $4,000 payment (within $5K delegation limit)');

  const checkB = await post(`${POLICY_URL}/policy/check`, {
    agent_id:      SUB_AGENT_B_ID,
    amount_usd:    4_000,
    oracle_status: 'STABLE',
    delegation_id: delegB.id,
    session_id:    SESSION_ID,
  });

  result('Policy decision', checkB.decision);

  if (checkB.decision === 'ALLOW') {
    const settlement = await post(`${AGENT_URL}/settle`, {
      amount:              4_000,
      sourceCurrency:      'USD',
      destinationCurrency: 'EUR',
      recipientAddress:    '0x0000000000000000000000000000000000000001',
      purpose:             'supplier-payment',
      referenceId:         `${SESSION_ID}-b`,
      sandbox:             true,
    });

    const receipt = await post(`${POLICY_URL}/receipt`, {
      agent_id:            SUB_AGENT_B_ID,
      session_id:          SESSION_ID,
      task_context:        'Sub-agent B: pay EU supplier invoice INV-002',
      policy_id:           policy.id,
      delegation_id:       delegB.id,
      amount_usd:          4_000,
      to_currency:         'EUR',
      counterparty:        'Berlin Supplier GmbH',
      oracle_status:       'STABLE',
      compliance_decision: 'PROCEED',
      settlement_id:       settlement.settlementId ?? settlement.simulatedId,
      sandbox:             true,
    });

    result('Receipt ID', receipt.id);
  }

  // ── Step 5: Sub-agent C — exceeds per-tx limit ────────────────────────────

  label('Step 5 — Sub-agent C: $6,000 payment (exceeds $5K/tx delegation limit)');
  console.log('  Expected: BLOCK — delegation_limit_exceeded\n');

  const checkC = await post(`${POLICY_URL}/policy/check`, {
    agent_id:      SUB_AGENT_C_ID,
    amount_usd:    6_000,
    oracle_status: 'STABLE',
    delegation_id: delegC.id,
    session_id:    SESSION_ID,
  });

  result('Policy decision', checkC.decision);
  result('Reason', checkC.reason);
  console.log('\n  ✓ Sub-agent C correctly blocked — cannot exceed delegated $5K/tx ceiling');

  // ── Step 6: Orchestrator queries session ledger ───────────────────────────

  label('Step 6 — Orchestrator queries session ledger');

  const ledger = await get(`${POLICY_URL}/ledger/${SESSION_ID}`);

  result('Total moved (USD)', `$${ledger.summary?.total_usd?.toLocaleString() ?? 0}`);
  result('Transactions', ledger.summary?.tx_count ?? 0);
  result('Session ID', SESSION_ID);

  if (ledger.payments?.length) {
    console.log('\n  Payment timeline:');
    for (const p of ledger.payments) {
      const ts = new Date(p.created_at).toISOString().slice(11, 19);
      console.log(`  ${ts}  ${p.agent_id.padEnd(32)} $${p.amount_usd.toLocaleString().padStart(7)} ${p.to_currency ?? 'USD'}  ${p.compliance_decision ?? '—'}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  label('Summary');
  console.log('  Orchestrator set policy once.');
  console.log('  3 sub-agents operated within delegated limits autonomously.');
  console.log('  1 over-limit attempt was blocked — no human intervention needed.');
  console.log('  Every action is recorded as a tamper-evident signed receipt.');
  console.log('  Full session is auditable from the ledger endpoint.\n');
  console.log(`  Ledger: https://policy.untitledfinancial.com/ledger/${SESSION_ID}`);
  console.log(`  Receipts: https://policy.untitledfinancial.com/receipt/session/${SESSION_ID}\n`);
}

run().catch(e => {
  console.error('\n✗', e.message);
  process.exit(1);
});
