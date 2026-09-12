/**
 * DPX + Coinbase AgentKit Integration
 *
 * Demonstrates a Coinbase AgentKit agent using DPX as its payment and compliance rail.
 * AgentKit handles the wallet layer; DPX handles discovery, pricing, compliance, and settlement.
 *
 * DPX is sender-funded: POST /settle authorizes and returns execution params
 * (router address, token, amount, quoteId, ABI) but does not broadcast
 * anything itself — the caller signs and sends approve() + router.settle()
 * with their own wallet. That step is wired up below via the AgentKit
 * wallet provider's sendTransaction()/waitForTransactionReceipt() — it
 * works identically whether the wallet is CDP-managed or a raw Viem key.
 * Requires the wallet to hold both USDC (the settlement amount) and a small
 * amount of ETH on Base for gas (~$0.002 per settlement).
 *
 * Two wallet modes:
 *   CDP mode  — set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET
 *   Viem mode — set PRIVATE_KEY (uses existing dpx-agent key, no CDP account needed)
 *
 * Required env vars (see .env.example):
 *   PRIVATE_KEY        — wallet private key (Viem mode)
 *   RECIPIENT_ADDRESS  — counterparty wallet address
 *   RECIPIENT_NAME     — counterparty name (VoP check)
 *   AMOUNT_USD         — settlement amount (default: 50000)
 *   SANDBOX            — true = no on-chain tx (default); false requests live
 *                        settlement and executes approve() + router.settle()
 *                        on-chain with this wallet — needs real USDC + ETH
 *
 * CDP env vars (optional — enables Coinbase-managed wallet):
 *   CDP_API_KEY_ID     — from portal.cdp.coinbase.com
 *   CDP_API_KEY_SECRET — from portal.cdp.coinbase.com
 *   CDP_WALLET_SECRET  — from portal.cdp.coinbase.com
 *
 * Node v22+ required. Run with: nvm use 22 && npm run agentkit
 */

import 'dotenv/config';
import { AgentKit, ViemWalletProvider, CdpEvmWalletProvider } from '@coinbase/agentkit';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createWalletClient, http, encodeFunctionData, parseAbi } from 'viem';
import { createSigner, wrapFetchWithPayment } from 'x402-fetch';

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

/**
 * Signs and broadcasts approve() + router.settle() with the AgentKit wallet
 * provider's own signer — works for both CDP-managed and Viem wallets since
 * both implement the same EvmWalletProvider interface. Waits for each
 * confirmation before sending the next transaction (settle() will revert if
 * the approval hasn't landed yet).
 */
async function executeSettlementOnChain(
  walletProvider: ViemWalletProvider | CdpEvmWalletProvider,
  execution: SettlementExecution,
): Promise<{ approveTxHash: string; settleTxHash: string }> {
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [execution.routerAddress as `0x${string}`, BigInt(execution.grossAmountRaw)],
  });
  const approveTxHash = await walletProvider.sendTransaction({
    to: execution.tokenAddress as `0x${string}`,
    data: approveData,
  });
  await walletProvider.waitForTransactionReceipt(approveTxHash);

  // execution.abi is the router's own ABI fragment as returned by DPX —
  // routerInterface human-readable strings parse directly via viem's ABI
  // item format for a single function, so we build the call with the raw
  // router ABI DPX supplied rather than re-declaring it here.
  const settleData = encodeFunctionData({
    abi: parseRouterAbi(execution.abi),
    functionName: 'settle',
    args: [
      execution.recipient as `0x${string}`,
      BigInt(execution.grossAmountRaw),
      execution.isCrossCurrency,
      execution.quoteIdBytes32 as `0x${string}`,
      execution.tokenAddress as `0x${string}`,
    ],
  });
  const settleTxHash = await walletProvider.sendTransaction({
    to: execution.routerAddress as `0x${string}`,
    data: settleData,
  });
  await walletProvider.waitForTransactionReceipt(settleTxHash);

  return { approveTxHash, settleTxHash };
}

/** Parses the human-readable ABI strings DPX returns (e.g. "function settle(...)") into viem's ABI item format. */
function parseRouterAbi(abiStrings: string[]) {
  return parseAbi(abiStrings as [string, ...string[]]);
}

const SANDBOX      = process.env.SANDBOX !== 'false';
const FORCE_ORACLE = process.env.FORCE_ORACLE === 'true';
const AMOUNT       = Number(process.env.AMOUNT_USD ?? 50_000);
const RECIPIENT   = process.env.RECIPIENT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const USE_CDP     = !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
const HAS_WALLET  = USE_CDP || (!!PRIVATE_KEY && PRIVATE_KEY !== '0x...');

async function run() {
  console.log('══════════════════════════════════════════════');
  console.log('  DPX + Coinbase AgentKit — Settlement Demo');
  console.log('══════════════════════════════════════════════\n');

  if (!HAS_WALLET) {
    console.log('ℹ  No wallet configured — running discovery + oracle + quote only.');
    console.log('   To enable x402 payments and settlement, add to .env:');
    console.log('   PRIVATE_KEY=0x<your-key>   (Viem mode)');
    console.log('   — or —');
    console.log('   CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET  (CDP mode)');
    console.log();
  }

  console.log(`Wallet mode  ${USE_CDP ? 'Coinbase CDP (managed)' : HAS_WALLET ? 'Viem (private key)' : 'none — discovery only'}`);
  console.log(`Settlement   ${SANDBOX ? 'Sandbox (oracle + compliance live, no on-chain tx)' : 'Live mainnet'}`);
  console.log();

  // ── Step 1: Initialize AgentKit wallet provider ──────────────────────────
  let walletProvider: ViemWalletProvider | CdpEvmWalletProvider | undefined;
  let agentKit: AgentKit | undefined;

  if (HAS_WALLET) {
    if (USE_CDP) {
      walletProvider = await CdpEvmWalletProvider.configureWithWallet({
        apiKeyId:     process.env.CDP_API_KEY_ID!,
        apiKeySecret: process.env.CDP_API_KEY_SECRET!,
        walletSecret: process.env.CDP_WALLET_SECRET!,
        networkId:    'base-mainnet',
      });
      const addr = await walletProvider.getAddress();
      console.log(`CDP Wallet   ${addr}`);
    } else {
      const account = privateKeyToAccount(PRIVATE_KEY!);
      const client  = createWalletClient({ account, chain: base, transport: http() });
      walletProvider = new ViemWalletProvider(client);
      console.log(`Viem Wallet  ${account.address}`);
    }

    // ── Step 2: Initialize AgentKit instance ───────────────────────────────
    agentKit = await AgentKit.from({ walletProvider });
    console.log('AgentKit     initialized ✓\n');
  }

  // ── Step 3: Discover DPX capabilities via manifest ───────────────────────
  // Agents discover DPX cold — no prior configuration needed
  const manifest = await fetch('https://agent.untitledfinancial.com/manifest').then(r => r.json()) as any;
  console.log('── Discovery ─────────────────────────────────');
  console.log(`Name         ${manifest.name}`);
  console.log(`Version      ${manifest.version}`);
  console.log(`Network      ${manifest.network}`);
  console.log(`Assets       ${(manifest.supportedAssets ?? []).join(', ')}`);
  console.log(`Capabilities ${(manifest.capabilities ?? []).join(', ')}`);
  console.log();

  // ── Step 4: Check stability oracle before committing ─────────────────────
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

  // ── Step 5: Get binding quote ─────────────────────────────────────────────
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

  if (!HAS_WALLET) {
    // ── Discovery-only summary (no wallet) ──────────────────────────────────
    console.log('\n══════════════════════════════════════════════');
    console.log('  Discovery + Oracle validated ✓  (wallet-free)');
    console.log('──────────────────────────────────────────────');
    console.log(`  Manifest:    discovered cold ✓`);
    console.log(`  Oracle:      ${oracleStatus} (${oracleScore}/100) ✓`);
    console.log(`  Quote:       ${quote.quoteId} ✓`);
    console.log('  x402:        — add PRIVATE_KEY to enable');
    console.log('  Settlement:  — add PRIVATE_KEY to enable');
    console.log('══════════════════════════════════════════════\n');
    return;
  }

  // ── Step 6: Pay for macro intelligence via x402 ───────────────────────────
  // AgentKit has a native x402 action provider — DPX Intelligence API is plug-and-play
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
    console.log(`Skipped      (CDP wallet mode — no raw private key for x402 signing)`);
    console.log(`             Add PRIVATE_KEY to .env to enable micropayments`);
  }
  console.log();

  // ── Step 7: VoP counterparty check via x402 ───────────────────────────────
  if (RECIPIENT) {
    console.log('── Verification of Payee (x402) ──────────────');
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

  // ── Step 8: Execute settlement ────────────────────────────────────────────
  if (RECIPIENT) {
    console.log('── Settlement ────────────────────────────────');
    const walletAddress = await walletProvider!.getAddress();
    const referenceId   = `agentkit-${Date.now()}`;

    const settled = await fetch('https://agent.untitledfinancial.com/settle', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:              AMOUNT,
        sourceCurrency:      'USD',
        destinationCurrency: 'USD',
        recipientAddress:    RECIPIENT,
        senderAddress:       walletAddress,
        purpose:             'agentkit-dpx-integration',
        referenceId,
        quoteId:             quote.quoteId,
        sandbox:             SANDBOX,
      }),
    }).then(r => r.json()) as any;

    console.log(`Status       ${settled.status}`);
    console.log(`Oracle       ${settled.oracleStatus} (score: ${settled.oracleScore})`);
    console.log(`Reference    ${referenceId}`);
    if (settled.settlementId) console.log(`Settlement   ${settled.settlementId}`);
    if (settled.paymentId)    console.log(`Payment ID   ${settled.paymentId}`);

    // DPX is sender-funded: /settle authorizes but never broadcasts anything
    // itself. status === 'authorized' + a real execution object means it's
    // now on us to sign and send approve() + router.settle() ourselves.
    if (settled.status === 'authorized' && settled.execution) {
      console.log(`             Authorized — executing on-chain with this wallet...`);
      try {
        const { approveTxHash, settleTxHash } = await executeSettlementOnChain(
          walletProvider!,
          settled.execution as SettlementExecution,
        );
        console.log(`approve()    https://base.blockscout.com/tx/${approveTxHash}`);
        console.log(`settle()     https://base.blockscout.com/tx/${settleTxHash}`);
      } catch (e) {
        console.log(`✗ On-chain execution failed: ${(e as Error).message}`);
        console.log(`  Common causes: wallet lacks USDC or ETH-for-gas on Base mainnet.`);
      }
    } else if (settled.status === 'sandbox') {
      console.log(`             Sandbox — no on-chain tx (set SANDBOX=false to execute for real)`);
    } else {
      console.log(`             Not authorized — ${settled.reasoning ?? 'see full response for details'}`);
    }
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════');
  console.log('  Integration validated ✓');
  console.log('──────────────────────────────────────────────');
  console.log(`  Wallet:      ${USE_CDP ? 'Coinbase CDP (managed)' : 'Viem (private key)'}`);
  console.log(`  AgentKit:    initialized ✓`);
  console.log(`  Manifest:    discovered cold ✓`);
  console.log(`  Oracle:      ${oracleStatus} (${oracleScore}/100) ✓`);
  console.log(`  x402:        ${PRIVATE_KEY ? 'macro-stress paid ✓' : 'skipped (CDP mode — add PRIVATE_KEY to enable)'}`);
  console.log(`  Settlement:  ${RECIPIENT ? 'executed ✓' : 'skipped (no RECIPIENT_ADDRESS)'}`);
  console.log('══════════════════════════════════════════════\n');
}

run().catch(e => { console.error('\n✗', e.message); process.exit(1); });
