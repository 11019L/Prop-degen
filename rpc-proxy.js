// rpc-proxy.js → 100% working fake RPC for Backpack
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

const REAL_RPC = 'https://api.mainnet-beta.solana.com'; // fallback
const db = new sqlite3.Database('crucible.db');

// Load virtual balances from your existing users table
const balances = new Map();
function load() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    balances.clear();
    rows.forEach(r => balances.set(r.publicKey, Number(r.balance || 500)));
  });
}
load();
setInterval(load, 20_000);

app.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};

  const pubkey = params?.[0]?.toString();

  // Fake SOL balance (0.5 SOL)
  if (method === 'getBalance' && balances.has(pubkey)) {
    return res.json({ jsonrpc: "2.0", id, result: { value: 500_000_000 } });
  }

  // Fake USDC token account (real USDC mint)
  if (method === 'getTokenAccountsByOwner' && balances.has(pubkey)) {
    const usd = balances.get(pubkey);
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        value: [{
          pubkey: "fakeusdc1111111111111111111111111111111111",
          account: {
            data: { parsed: { info: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: { amount: String(usd * 1_000_000), decimals: 6 } } } },
            executable: false,
            lamports: 2039280,
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          }
        }]
      }
    });
  }

  // Fake transaction success so swaps work
  if (method === 'sendTransaction') {
    return res.json({ jsonrpc: "2.0", id, result: "fake-signature-11111111111111111111111111111111" });
  }

  // Forward everything else to real chain
  try {
    const r = await axios.post(REAL_RPC, req.body, { timeout: 9000 });
    res.json(r.data);
  } catch {
    res.status(500).json({ error: "timeout" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fake RPC running → https://your-app.onrender.com`));
