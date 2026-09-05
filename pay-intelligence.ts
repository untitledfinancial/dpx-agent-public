/**
 * DPX — single live x402 intelligence payment
 *
 * Pays for one real intelligence call with real USDC on Base mainnet, via the
 * Coinbase x402 facilitator. This is also what triggers Bazaar auto-indexing
 * (CDP indexes an endpoint the first time it sees a real settled payment).
 *
 * Setup:
 *   cd dpx-agent-public
 *   npm install
 *   echo "PRIVATE_KEY=0xyourkey" > .env
 *
 * Run:
 *   npx tsx pay-intelligence.ts
 */

import 'dotenv/config';

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const ENDPOINT = process.env.ENDPOINT ?? 'https://intelligence.untitledfinancial.com/v1/intelligence/macro-stress';

if (!PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY in .env (the wallet holding USDC on Base).');
  process.exit(1);
}

async function main() {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createSigner, wrapFetchWithPayment } = await import('x402-fetch');

  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`Wallet     ${account.address}`);
  console.log(`Endpoint   ${ENDPOINT}\n`);

  const signer = await createSigner('base', PRIVATE_KEY);
  // Cap this run at $1 — well above any single intelligence call's price, just a safety ceiling.
  const fetchX402 = wrapFetchWithPayment(fetch, signer, BigInt(1 * 10 ** 6));

  const res = await fetchX402(ENDPOINT);
  const paymentResponseHeader = res.headers.get('x-payment-response');
  const body = await res.json();

  console.log('Result');
  console.log(JSON.stringify(body, null, 2));

  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString());
      console.log('\nPayment settled');
      console.log(JSON.stringify(decoded, null, 2));
      if (decoded.transaction) {
        console.log(`\nBasescan: https://basescan.org/tx/${decoded.transaction}`);
      }
    } catch {
      console.log('\nX-PAYMENT-RESPONSE (raw):', paymentResponseHeader);
    }
  }

  console.log('\nCheck Bazaar indexing in a minute or two:');
  console.log('  curl https://intelligence.untitledfinancial.com/bazaar/status');
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
