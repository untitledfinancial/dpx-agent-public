/**
 * Generates a fresh disposable wallet for testing, writes PRIVATE_KEY to .env directly
 * (never printed to the terminal), and prints only the public address.
 *
 * Run:
 *   npx tsx generate-wallet.ts
 *
 * Then fund the printed address with a small amount of USDC on Base
 * (send from Coinbase, any exchange, or another wallet — just a normal transfer
 * to that address) before running pay-intelligence.ts.
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = '.env';

if (existsSync(envPath) && readFileSync(envPath, 'utf8').includes('PRIVATE_KEY=')) {
  console.error('.env already has a PRIVATE_KEY set. Delete that line first if you want to generate a new one.');
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

writeFileSync(envPath, `PRIVATE_KEY=${privateKey}\n`, { flag: 'a' });

console.log(`New wallet created.`);
console.log(`Address: ${account.address}`);
console.log(`\nThe private key was written directly to .env — it was not printed above and won't appear in any terminal scrollback.`);
console.log(`\nNext: send a small amount of USDC on Base to ${account.address}`);
console.log(`(e.g. $1-2 is plenty — covers the $0.15 test call with room to spare).`);
console.log(`Then run: npx tsx pay-intelligence.ts`);
