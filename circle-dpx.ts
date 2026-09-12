/**
 * DPX + Circle Developer Controlled Wallets Integration
 *
 * Demonstrates a Circle-custodied programmable wallet using DPX as its
 * settlement and compliance rail. Circle handles the wallet layer;
 * DPX handles discovery, pricing, compliance, and settlement.
 *
 * DPX is sender-funded: POST /settle authorizes and returns execution
 * params (router address, token, amount, quoteId, ABI) but never
 * broadcasts anything itself — the caller executes approve() +
 * router.settle() with their own wallet. For a Circle-custodied wallet,
 * that means Circle's createContractExecutionTransaction (raw callData,
 * since Circle's abiParameters typing doesn't cleanly cover this ABI),
 * polled via getTransaction's built-in waitForState until CONFIRMED.
 *
 * Required env vars:
 *   CIRCLE_API_KEY       — from app-sandbox.circle.com → Developer → API Keys
 *   CIRCLE_ENTITY_SECRET — generated during Circle wallet setup
 *
 * Optional:
 *   CIRCLE_WALLET_SET_ID — reuse an existing wallet set (created on first run)
 *   AMOUNT_USD           — settlement amount (default: 50000)
 *   RECIPIENT_ADDRESS    — counterparty wallet address
 *   SANDBOX              — true = no on-chain tx (default), false = live mainnet
 *   FORCE_ORACLE         — true = bypass oracle check for sandbox testing
 *
 * Run with: npm run circle
 */

import 'dotenv/config';
import * as CircleSDK from '@circle-fin/developer-controlled-wallets';
const { initiateDeveloperControlledWalletsClient } = CircleSDK as any;
import { createSigner, wrapFetchWithPayment } from 'x402-fetch';
import { encodeFunctionData } from 'viem';

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

// Hardcoded rather than parsed from execution.abi at runtime — parseAbi() on
// a widened `string[]` (as opposed to a const tuple of literal strings)
// loses the literal-type information encodeFunctionData's generic needs to
// infer functionName/args, which silently collapses to `never` and fails
// to typecheck. The router's settle() signature is fixed; DPX's own
// settlement-agent source confirms this exact string every time.
const ROUTER_SETTLE_ABI = [{
  name: 'settle', type: 'function', stateMutability: 'nonpayable',
  inputs: [
    { name: 'recipient', type: 'address' },
    { name: 'grossAmount', type: 'uint256' },
    { name: 'isCrossCurrency', type: 'bool' },
    { name: 'quoteId', type: 'bytes32' },
    { name: 'tokenAddress', type: 'address' },
  ],
  outputs: [{ name: 'netAmount', type: 'uint256' }],
}] as const;

/**
 * Signs and broadcasts approve() + router.settle() via Circle's
 * createContractExecutionTransaction, using this wallet's Circle-custodied
 * key (never exported, never touches this process). Each call is polled to
 * CONFIRMED via getTransaction's built-in waitForState before proceeding —
 * settle() will revert if approve() hasn't landed yet.
 */
async function executeSettlementOnChain(
  circleClient: ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  walletId: string,
  execution: SettlementExecution,
): Promise<{ approveTxHash: string; settleTxHash: string }> {
  const approveCreate = await circleClient.createContractExecutionTransaction({
    walletId,
    contractAddress: execution.tokenAddress,
    callData: encodeFunctionData({
      abi: ERC20_APPROVE_ABI, functionName: 'approve',
      args: [execution.routerAddress as `0x${string}`, BigInt(execution.grossAmountRaw)],
    }),
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const approveConfirmed = await circleClient.getTransaction({
    id: approveCreate.data.id, waitForState: 'CONFIRMED',
  });

  const settleCreate = await circleClient.createContractExecutionTransaction({
    walletId,
    contractAddress: execution.routerAddress,
    callData: encodeFunctionData({
      abi: ROUTER_SETTLE_ABI, functionName: 'settle',
      args: [
        execution.recipient as `0x${string}`,
        BigInt(execution.grossAmountRaw),
        execution.isCrossCurrency,
        execution.quoteIdBytes32 as `0x${string}`,
        execution.tokenAddress as `0x${string}`,
      ],
    }),
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  const settleConfirmed = await circleClient.getTransaction({
    id: settleCreate.data.id, waitForState: 'CONFIRMED',
  });

  return {
    approveTxHash: approveConfirmed.data.transaction?.txHash ?? approveCreate.data.id,
    settleTxHash:  settleConfirmed.data.transaction?.txHash ?? settleCreate.data.id,
  };
}

const CIRCLE_API_KEY      = process.env.CIRCLE_API_KEY;
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const SANDBOX             = process.env.SANDBOX !== 'false';
const FORCE_ORACLE        = process.env.FORCE_ORACLE === 'true';
const AMOUNT              = Number(process.env.AMOUNT_USD ?? 50_000);
const RECIPIENT           = process.env.RECIPIENT_ADDRESS;
const PRIVATE_KEY         = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const HAS_CIRCLE          = !!(CIRCLE_API_KEY && CIRCLE_ENTITY_SECRET);

async function run() {
  console.log('══════════════════════════════════════════════');
  console.log('  DPX + Circle Developer Wallets — Settlement Demo');
  console.log('══════════════════════════════════════════════\n');

  if (!HAS_CIRCLE) {
    console.log('ℹ  No Circle credentials — running discovery + oracle + quote only.');
    console.log('   To enable Circle wallet mode, add to .env:');
    console.log('   CIRCLE_API_KEY=<key>');
    console.log('   CIRCLE_ENTITY_SECRET=<secret>');
    console.log();
  }

  console.log(`Wallet mode  ${HAS_CIRCLE ? 'Circle Developer Controlled Wallet' : 'none — discovery only'}`);
  console.log(`Settlement   ${SANDBOX ? 'Sandbox (oracle + compliance live, no on-chain tx)' : 'Live mainnet'}`);
  console.log();

  // ── Step 1: Initialize Circle wallet client ──────────────────────────────
  let circleClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | undefined;
  let walletAddress: string | undefined;
  let walletId: string | undefined;

  if (HAS_CIRCLE) {
    circleClient = initiateDeveloperControlledWalletsClient({
      apiKey:       CIRCLE_API_KEY!,
      entitySecret: CIRCLE_ENTITY_SECRET!,
    });

    // ── Step 2: Create or retrieve a wallet set ────────────────────────────
    let walletSetId = process.env.CIRCLE_WALLET_SET_ID;

    if (!walletSetId) {
      const setResp = await circleClient.createWalletSet({
        name:             'dpx-integration-test',
        idempotencyKey:   `dpx-wallet-set-${Date.now()}`,
      });
      walletSetId = setResp.data?.walletSet?.id;
      console.log(`Wallet Set   ${walletSetId}  (save as CIRCLE_WALLET_SET_ID to reuse)`);
    } else {
      console.log(`Wallet Set   ${walletSetId}  (reusing)`);
    }

    // ── Step 3: Create a wallet on Base ───────────────────────────────────
    const walletResp = await circleClient.createWallets({
      idempotencyKey: `dpx-wallet-${Date.now()}`,
      blockchains:    ['BASE' as any],
      count:          1,
      walletSetId:    walletSetId!,
    });

    const wallet = walletResp.data?.wallets?.[0];
    walletId     = wallet?.id;
    walletAddress = wallet?.address;
    console.log(`Circle Wallet  ${walletAddress}`);
    console.log(`Wallet ID    ${walletId}`);
    console.log('Circle SDK   initialized ✓\n');
  }

  // ── Step 4: Discover DPX capabilities via manifest ───────────────────────
  const manifest = await fetch('https://agent.untitledfinancial.com/manifest').then(r => r.json()) as any;
  console.log('── Discovery ─────────────────────────────────');
  console.log(`Name         ${manifest.name}`);
  console.log(`Version      ${manifest.version}`);
  console.log(`Network      ${manifest.network}`);
  console.log(`Assets       ${(manifest.supportedAssets ?? []).join(', ')}`);
  console.log(`Capabilities ${(manifest.capabilities ?? []).join(', ')}`);
  console.log();

  // ── Step 5: Check stability oracle ───────────────────────────────────────
  const oracle = await fetch('https://stability.untitledfinancial.com/reliability').then(r => r.json()) as any;
  const oracleStatus = oracle.stability?.latestStatus ?? oracle.status ?? 'UNKNOWN';
  const oracleScore  = oracle.stability?.currentScore ?? oracle.stabilityScore?.overall ?? 'n/a';
  console.log('── Stability Oracle ──────────────────────────');
  console.log(`Status       ${oracleStatus}  (score: ${oracleScore}/100)`);
  if (oracle.message) console.log(`             ${oracle.message}`);
  console.log();

  if (oracleStatus === 'UNSTABLE') {
    if (FORCE_ORACLE) {
      console.log('⚠  Oracle UNSTABLE — FORCE_ORACLE=true, continuing for sandbox validation.');
    } else {
      console.log('⚠  Oracle UNSTABLE — holding. Retry when conditions improve.');
      process.exit(0);
    }
  }

  // ── Step 6: Get binding quote ─────────────────────────────────────────────
  const quoteResp = await fetch(
    `https://agent.untitledfinancial.com/quote?amountUsd=${AMOUNT}&hasFx=false`
  ).then(r => r.json()) as any;
  const quote = quoteResp.quote;
  console.log('── Quote ─────────────────────────────────────');
  console.log(`Amount       $${AMOUNT.toLocaleString()} gross`);
  console.log(`Fees         ${quote.totalFeeBps} bps`);
  console.log(`Net          $${quote.netAmount?.toLocaleString()}`);
  console.log(`Quote ID     ${quote.quoteId}  (valid 300s)`);
  console.log();

  if (!HAS_CIRCLE) {
    console.log('\n══════════════════════════════════════════════');
    console.log('  Discovery + Oracle validated ✓  (wallet-free)');
    console.log('──────────────────────────────────────────────');
    console.log(`  Manifest:    discovered cold ✓`);
    console.log(`  Oracle:      ${oracleStatus} (${oracleScore}/100) ✓`);
    console.log(`  Quote:       ${quote.quoteId} ✓`);
    console.log('  Circle:      — add CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET to enable');
    console.log('  Settlement:  — add credentials to enable');
    console.log('══════════════════════════════════════════════\n');
    return;
  }

  // ── Step 7: Pay for macro intelligence via x402 ───────────────────────────
  console.log('── Intelligence (x402 micropayment) ──────────');
  let fetchX402: typeof fetch | undefined;
  if (PRIVATE_KEY) {
    const signer = await createSigner('base', PRIVATE_KEY);
    fetchX402 = wrapFetchWithPayment(fetch, signer, BigInt(1 * 10 ** 6)) as typeof fetch;

    const intel = await fetchX402(
      'https://intelligence.untitledfinancial.com/v1/intelligence/macro-stress'
    ).then(r => r.json()) as any;
    console.log(`Macro stress ${intel.score ?? intel.macroStressScore ?? 'n/a'}/100`);
    if (intel.summary)   console.log(`Summary      ${intel.summary}`);
    if (intel.reasoning) console.log(`Reasoning    ${intel.reasoning}`);
  } else {
    console.log(`Skipped      (no PRIVATE_KEY for x402 signing — add to .env to enable)`);
  }
  console.log();

  // ── Step 8: VoP counterparty check ───────────────────────────────────────
  if (RECIPIENT) {
    console.log('── Verification of Payee ─────────────────────');
    const vopFetch = fetchX402 ?? fetch;
    const vop = await vopFetch('https://compliance.untitledfinancial.com/vop/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: RECIPIENT,
        submittedName: process.env.RECIPIENT_NAME ?? 'Unknown',
      }),
    }).then(r => r.json()) as any;
    console.log(`VoP result   ${vop.result} · safe: ${vop.proceedSafe}`);
    if (vop.message) console.log(`             ${vop.message}`);
    console.log();

    if (!vop.proceedSafe) {
      console.log('⚠  VoP blocked settlement — counterparty failed verification.');
      process.exit(1);
    }
  }

  // ── Step 9: Execute settlement via DPX ───────────────────────────────────
  if (RECIPIENT && walletAddress) {
    console.log('── Settlement ────────────────────────────────');
    const referenceId = `circle-dpx-${Date.now()}`;

    const settled = await fetch('https://agent.untitledfinancial.com/settle', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:              AMOUNT,
        sourceCurrency:      'USD',
        destinationCurrency: 'USD',
        recipientAddress:    RECIPIENT,
        senderAddress:       walletAddress,
        purpose:             'circle-dpx-integration',
        referenceId,
        quoteId:             quote.quoteId,
        sandbox:             SANDBOX,
      }),
    }).then(r => r.json()) as any;

    console.log(`Status       ${settled.status}`);
    console.log(`Oracle       ${settled.oracleStatus} (score: ${settled.oracleScore})`);
    console.log(`Reference    ${referenceId}`);
    if (settled.settlementId) console.log(`Settlement   ${settled.settlementId}`);

    // DPX is sender-funded: /settle authorizes but never broadcasts anything
    // itself. status === 'authorized' + a real execution object means it's
    // now on us to execute approve() + router.settle() via Circle.
    if (settled.status === 'authorized' && settled.execution) {
      console.log(`             Authorized — executing on-chain via Circle...`);
      try {
        const { approveTxHash, settleTxHash } = await executeSettlementOnChain(
          circleClient!, walletId!, settled.execution as SettlementExecution,
        );
        console.log(`approve()    https://base.blockscout.com/tx/${approveTxHash}`);
        console.log(`settle()     https://base.blockscout.com/tx/${settleTxHash}`);
      } catch (e) {
        console.log(`✗ On-chain execution failed: ${(e as Error).message}`);
        console.log(`  Common causes: wallet lacks USDC on Base mainnet, or Circle fee config rejected.`);
      }
    } else if (settled.status === 'sandbox') {
      console.log(`             Sandbox — no on-chain tx`);
    } else {
      console.log(`             Not authorized — ${settled.reasoning ?? 'see full response for details'}`);
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════');
  console.log('  Integration validated ✓');
  console.log('──────────────────────────────────────────────');
  console.log(`  Wallet:      Circle Developer Controlled (${walletAddress?.slice(0, 10)}...)`);
  console.log(`  Circle SDK:  initialized ✓`);
  console.log(`  Manifest:    discovered cold ✓`);
  console.log(`  Oracle:      ${oracleStatus} (${oracleScore}/100) ✓`);
  console.log(`  x402:        ${PRIVATE_KEY ? 'macro-stress paid ✓' : 'skipped (add PRIVATE_KEY to enable)'}`);
  console.log(`  Settlement:  ${RECIPIENT ? 'executed ✓' : 'skipped (no RECIPIENT_ADDRESS)'}`);
  console.log('══════════════════════════════════════════════\n');
}

run().catch(e => { console.error('\n✗', e.message); process.exit(1); });
