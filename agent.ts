/**
 * DPX Agent — full settlement loop
 *
 * Every run generates real traceable calls:
 *   · x402 micropayment → intelligence data      (real USDC on Base)
 *   · x402 micropayment → VoP counterparty check (real USDC on Base)
 *
 * Settlement runs in sandbox by default.
 * Set SANDBOX=false in .env to execute live on-chain.
 *
 * npm install && cp .env.example .env && npm start
 */

import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import { createSigner, wrapFetchWithPayment } from 'x402-fetch';

const SANDBOX     = process.env.SANDBOX !== 'false';
const AMOUNT      = Number(process.env.AMOUNT_USD ?? 50_000);
const RECIPIENT   = process.env.RECIPIENT_ADDRESS!;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;

async function run() {
  const account   = privateKeyToAccount(PRIVATE_KEY);
  const signer    = await createSigner('base', PRIVATE_KEY);
  const fetchX402 = wrapFetchWithPayment(fetch, signer, BigInt(1 * 10 ** 6)); // $1 max per call

  console.log(`DPX Agent  ${account.address}\n`);
  if (SANDBOX) console.log('⚠  Settlement in sandbox — oracle and compliance run live, nothing moves on-chain.\n');

  // 1 — Oracle gate
  const oracle = await fetch('https://stability.untitledfinancial.com/reliability').then(r => r.json()) as any;
  console.log(`Oracle     ${oracle.status}  (score: ${oracle.score})`);
  console.log(`           ${oracle.reasoning}\n`);
  if (oracle.status === 'UNSTABLE') throw new Error('Holding — oracle UNSTABLE. Retry when conditions improve.');

  // 2 — Quote
  const { quote } = await fetch(
    `https://agent.untitledfinancial.com/quote?amountUsd=${AMOUNT}&hasFx=false`
  ).then(r => r.json()) as any;
  console.log(`Quote      $${AMOUNT.toLocaleString()} gross · ${quote.fees.total.bps} bps · $${quote.settlement.netUsd.toLocaleString()} net`);
  console.log(`           ID ${quote.quoteId}  (valid 300s)\n`);

  // 3 — Pay for current macro-stress conditions (real x402 USDC payment)
  const intel = await fetchX402(
    'https://intelligence.untitledfinancial.com/v1/intelligence/macro-stress'
  ).then(r => r.json()) as any;
  console.log(`Intel      macro stress score: ${intel.score ?? intel.macroStressScore}`);
  if (intel.summary)   console.log(`           ${intel.summary}`);
  if (intel.reasoning) console.log(`           ${intel.reasoning}`);
  console.log();

  // 4 — Verify counterparty before committing (real x402 USDC payment)
  const vop = await fetchX402('https://compliance.untitledfinancial.com/vop/verify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: RECIPIENT,
      submittedName: process.env.RECIPIENT_NAME ?? 'Unknown',
    }),
  }).then(r => r.json()) as any;
  console.log(`VoP        ${vop.result} · proceed: ${vop.proceedSafe}`);
  if (vop.message) console.log(`           ${vop.message}`);
  if (!vop.proceedSafe) throw new Error(`VoP blocked — ${vop.message}`);
  console.log();

  // 5 — Settle
  const settled = await (SANDBOX ? fetch : fetchX402)('https://agent.untitledfinancial.com/settle', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:              AMOUNT,
      sourceCurrency:      'USD',
      destinationCurrency: 'USD',
      recipientAddress:    RECIPIENT,
      purpose:             'agent-payment',
      referenceId:         `a2a-${Date.now()}`,
      quoteId:             quote.quoteId,
      sandbox:             SANDBOX,
    }),
  }).then(r => r.json()) as any;

  console.log(`Settled    ${settled.status} · oracle ${settled.oracleStatus} (${settled.oracleScore})`);
  if (settled.txHash) {
    console.log(`On-chain   https://base.blockscout.com/tx/${settled.txHash}`);
  } else {
    console.log(`           Sandbox — no on-chain tx.`);
    console.log(`           Set SANDBOX=false in .env to go live.`);
  }
}

run().catch(e => { console.error('\n✗', e.message); process.exit(1); });
