/**
 * DPX Agent — full settlement loop
 *
 * DEMO mode (no wallet needed):
 *   npm start
 *   Runs oracle, compliance, and quote against live endpoints.
 *   x402 payments and settlement are simulated — nothing moves on-chain.
 *
 * LIVE mode:
 *   Set PRIVATE_KEY and RECIPIENT_ADDRESS in .env, set SANDBOX=false.
 *   x402 payments use real USDC on Base mainnet. DPX is sender-funded —
 *   /settle authorizes and returns execution params but never broadcasts
 *   anything itself, so this file signs and sends approve() +
 *   router.settle() with PRIVATE_KEY's own wallet. Needs USDC (the
 *   settlement amount) and a small amount of ETH on Base for gas
 *   (~$0.002/settlement).
 */

import 'dotenv/config';
import { createWalletClient, createPublicClient, http, encodeFunctionData, parseAbi } from 'viem';
import { base } from 'viem/chains';

interface SettlementExecution {
  routerAddress: string;
  tokenAddress: string;
  grossAmountRaw: string;
  grossAmountUsd?: number;
  recipient: string;
  isCrossCurrency: boolean;
  quoteIdBytes32: string;
  abi: string[];
}

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

/** Signs and broadcasts approve() + router.settle() with PRIVATE_KEY's own wallet. */
async function executeSettlementOnChain(
  privateKey: `0x${string}`,
  execution: SettlementExecution,
): Promise<{ approveTxHash: string; settleTxHash: string }> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account      = privateKeyToAccount(privateKey);
  const walletClient  = createWalletClient({ account, chain: base, transport: http() });
  const publicClient  = createPublicClient({ chain: base, transport: http() });

  const approveTxHash = await walletClient.sendTransaction({
    to:   execution.tokenAddress as `0x${string}`,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI, functionName: 'approve',
      args: [execution.routerAddress as `0x${string}`, BigInt(execution.grossAmountRaw)],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });

  const settleTxHash = await walletClient.sendTransaction({
    to:   execution.routerAddress as `0x${string}`,
    data: encodeFunctionData({
      abi: parseAbi(execution.abi as [string, ...string[]]), functionName: 'settle',
      args: [
        execution.recipient as `0x${string}`,
        BigInt(execution.grossAmountRaw),
        execution.isCrossCurrency,
        execution.quoteIdBytes32 as `0x${string}`,
        execution.tokenAddress as `0x${string}`,
      ],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: settleTxHash });

  return { approveTxHash, settleTxHash };
}

const DEMO        = !process.env.PRIVATE_KEY;
const SANDBOX     = process.env.SANDBOX !== 'false';
const AMOUNT      = Number(process.env.AMOUNT_USD ?? 50_000);
const RECIPIENT   = process.env.RECIPIENT_ADDRESS ?? '0x1234567890123456789012345678901234567890';
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;

// x402-aware fetch — in demo mode, simulates the payment and returns mock intel
async function x402Fetch(url: string, init?: RequestInit): Promise<any> {
  if (DEMO) {
    // Simulate 402 → payment → retry flow without a real wallet
    return simulateX402(url);
  }
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createSigner, wrapFetchWithPayment } = await import('x402-fetch');
  const signer    = await createSigner('base', PRIVATE_KEY!);
  const fetchX402 = wrapFetchWithPayment(fetch, signer, BigInt(1 * 10 ** 6));
  return fetchX402(url, init).then(r => r.json());
}

function simulateX402(url: string): any {
  if (url.includes('macro-stress')) {
    return { score: 14, reasoning: '[demo] Low systemic stress. Credit spreads tight, liquidity normal.' };
  }
  if (url.includes('vop/verify')) {
    return { result: 'NOT_REGISTERED', proceedSafe: true, message: '[demo] Wallet not in registry — no issue flagged.' };
  }
  return {};
}

async function run() {
  if (DEMO) {
    console.log('DPX Agent  [demo mode — no wallet required]');
    console.log('           Oracle, compliance, and quote run against live endpoints.');
    console.log('           x402 payments and settlement are simulated.\n');
    console.log('           To go live: add PRIVATE_KEY and RECIPIENT_ADDRESS to .env\n');
  } else {
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(PRIVATE_KEY!);
    console.log(`DPX Agent  ${account.address}\n`);
    if (SANDBOX) console.log('⚠  Settlement in sandbox — oracle and compliance run live, nothing moves on-chain.\n');
  }

  // 1 — Oracle gate (live in all modes)
  const oracle = await fetch('https://stability.untitledfinancial.com/reliability').then(r => r.json()) as any;
  console.log(`Oracle     ${oracle.status}  (score: ${oracle.score})`);
  console.log(`           ${oracle.reasoning}\n`);
  if (oracle.status === 'UNSTABLE') throw new Error('Holding — oracle UNSTABLE. Retry when conditions improve.');

  // 2 — Quote (live in all modes)
  const { quote } = await fetch(
    `https://agent.untitledfinancial.com/quote?amountUsd=${AMOUNT}&hasFx=false`
  ).then(r => r.json()) as any;
  console.log(`Quote      $${AMOUNT.toLocaleString()} gross · ${quote.fees.total.bps} bps · $${quote.settlement.netUsd.toLocaleString()} net`);
  console.log(`           ID ${quote.quoteId}  (valid 300s)\n`);

  // 3 — Compliance screen (live in all modes — flow_check handles AML + sanctions + FATF R16)
  const flowCheck = await fetch('https://agent.untitledfinancial.com/flow-check', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:           AMOUNT,
      fromCurrency:     'USD',
      toCurrency:       'USD',
      recipientAddress: RECIPIENT,
    }),
  }).then(r => r.json()) as any;
  const decision = flowCheck.decision ?? (DEMO ? 'PROCEED' : 'UNKNOWN');
  console.log(`Compliance ${decision}${flowCheck.reason ? ` — ${flowCheck.reason}` : ''}`);
  if (DEMO && decision === 'UNKNOWN') console.log('           [demo] Compliance endpoint returned unexpected shape — treating as PROCEED');
  if (decision === 'BLOCKED') throw new Error(`Compliance BLOCKED: ${flowCheck.reason}`);
  if (decision === 'HOLD')    { console.log('           Route to review queue.'); return; }
  console.log();

  // 4 — Buy live macro-stress intelligence (x402 — simulated in demo mode)
  const intel = await x402Fetch('https://intelligence.untitledfinancial.com/v1/intelligence/macro-stress');
  console.log(`Intel      macro stress score: ${intel.score ?? intel.macroStressScore}`);
  if (intel.reasoning) console.log(`           ${intel.reasoning}`);
  console.log();

  // 5 — Verify counterparty (x402 — simulated in demo mode)
  const vop = await x402Fetch('https://compliance.untitledfinancial.com/vop/verify');
  console.log(`VoP        ${vop.result} · proceed: ${vop.proceedSafe}`);
  if (vop.message) console.log(`           ${vop.message}`);
  if (!vop.proceedSafe) throw new Error(`VoP blocked — ${vop.message}`);
  console.log();

  // 6 — Settle
  if (DEMO) {
    console.log('Settled    [demo] executed · oracle STABLE');
    console.log('           Nothing moved on-chain.');
    console.log('\n           Ready to go live? Add PRIVATE_KEY + RECIPIENT_ADDRESS to .env');
    return;
  }

  const settled = await fetch('https://agent.untitledfinancial.com/settle', {
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

  // DPX is sender-funded: /settle authorizes but never broadcasts anything
  // itself. status === 'authorized' + a real execution object means it's
  // now on us to sign and send approve() + router.settle() ourselves.
  if (settled.status === 'authorized' && settled.execution) {
    console.log('           Authorized — executing on-chain with this wallet...');
    try {
      const { approveTxHash, settleTxHash } = await executeSettlementOnChain(
        PRIVATE_KEY!,
        settled.execution as SettlementExecution,
      );
      console.log(`approve()  https://base.blockscout.com/tx/${approveTxHash}`);
      console.log(`settle()   https://base.blockscout.com/tx/${settleTxHash}`);
    } catch (e) {
      console.log(`✗ On-chain execution failed: ${(e as Error).message}`);
      console.log('  Common causes: wallet lacks USDC or ETH-for-gas on Base mainnet.');
    }
  } else if (settled.status === 'sandbox') {
    console.log('           Sandbox — no on-chain tx.');
    console.log('           Set SANDBOX=false in .env to go live.');
  } else {
    console.log(`           Not authorized — ${settled.reasoning ?? 'see full response for details'}`);
  }
}

run().catch(e => { console.error('\n✗', e.message); process.exit(1); });
