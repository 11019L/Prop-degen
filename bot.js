// rpc-proxy.js → FINAL working version for Backpack (Nov 29 2025)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

// Allow Backpack (CORS)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://api.mainnet-beta.solana.com';
const db = new sqlite3.Database('crucible.db');

const balances = new Map();   // publicKey → virtual USDC amount

function load() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    balances.clear();
    rows.forEach(r => balances.set(r.publicKey, Number(r.balance || 500)));
    console.log('Loaded balances:', balances.size, 'users');
  });
}
load();
setInterval(load, 15_000);

// MAIN RPC ENDPOINT – must be exactly "/"
app.post('/', async (req, res) => {
  const { method, params, id } = req.body || {};
  const pubkey = params?.[0]?.toString() || params?.[0];

  // 1. Fake SOL balance
  if (method === 'getBalance' && balances.has(pubkey)) {
    return res.json({ jsonrpc: "2.0", id, result: { value: 500_000_000 } }); // 0.5 SOL
  }

  // 2. Fake USDC token account
  if (method === 'getTokenAccountsByOwner' && balances.has(pubkey)) {
    const usd = balances.get(pubkey);
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        value: [{
          pubkey: "fakeusdcacct111111111111111111111111111111",
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

  // 3. Fake transaction success
  if (method === 'sendTransaction') {
    return res.json({ jsonrpc: "2.0", id, result: "1111111111111111111111111111111111111111111111111111111111111111" });
  }

  // Everything else → real chain
  try {
    const r = await axios.post(REAL_RPC, req.body, { timeout: 10000 });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ jsonrpc: "2.0", id, error: { code: -32002, message: "Server error" } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fake RPC LIVE → https://your-app.onrender.com`);
  console.log(`Test with Backpack → paste this exact URL in RPC settings`);
});
