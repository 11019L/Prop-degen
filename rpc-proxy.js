// rpc-proxy.js → FINAL VERSION – NO MORE CRASHES EVER
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS for Backpack
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://api.mainnet-beta.solana.com';
let db = null;

// Try to open DB – if file doesn't exist, it will be created automatically
try {
  db = new sqlite3.Database('crucible.db', (err) => {
    if (err) console.error('DB open error:', err);
    else console.log('Connected to crucible.db');
  });
} catch (e) {
  console.error('DB init failed:', e);
}

const balances = new Map();   // publicKey → virtual USDC

function loadBalances() {
  if (!db) {
    console.log('DB not ready yet');
    return;
  }

  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    balances.clear();

    if (err) {
      console.error('Query error:', err.message);
      return;
    }

    // ← THIS FIXES EVERYTHING – safe even if rows is null/undefined
    if (rows && Array.isArray(rows) && rows.length > 0) {
      rows.forEach(row => {
        if (row.publicKey) {
          balances.set(row.publicKey, Number(row.balance || 500));
        }
      });
    }

    console.log(`Loaded ${balances.size} active accounts`);
  });
}

// Load immediately + every 15 seconds
loadBalances();
setInterval(loadBalances, 15000);

// MAIN RPC ENDPOINT – must be exactly "/"
app.post('/', async (req, res) => {
  const { method = '', params = [], id } = req.body || {};
  const pubkey = typeof params[0] === 'object' ? params[0]?.toString() : params[0];

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
          pubkey: "fake1111111111111111111111111111111111111111",
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

  // Forward everything else to real RPC
  try {
    const r = await axios.post(REAL_RPC, req.body, { timeout: 10000 });
    res.json(r.data);
  } catch (e) {
    console.error('Real RPC error:', e.message);
    res.status(500).json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FAKE RPC IS LIVE`);
  console.log(`URL → https://your-service.onrender.com`);
  console.log(`Paste this exact URL in Backpack → Settings → RPC Address`);
});
