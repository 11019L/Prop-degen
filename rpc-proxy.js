require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS – required for Backpack
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://api.mainnet-beta.solana.com';
const db = new sqlite3.Database('crucible.db');

const virtualSol = new Map(); // publicKey → virtual SOL amount (in SOL, not lamports)

function loadVirtualBalances() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    virtualSol.clear();
    if (err) {
      console.error('DB error:', err);
      return;
    }
    (rows || []).forEach(row => {
      if (row.publicKey) {
        // Convert your stored "balance" (e.g. 500) to SOL
        virtualSol.set(row.publicKey, Number(row.balance || 500));
      }
    });
    console.log(`Loaded ${virtualSol.size} virtual SOL accounts`);
  });
}
loadVirtualBalances();
setInterval(loadVirtualBalances, 12000);

app.post('/', async (req, res) => {
  const { method = '', params = [], id } = req.body || {};
  const pubkey = params[0]?.toString?.() || params[0];

  // 1. Fake SOL balance (in lamports)
  if (method === 'getBalance' && virtualSol.has(pubkey)) {
    const solAmount = virtualSol.get(pubkey);
    const lamports = Math.floor(solAmount * 1_000_000_000);
    return res.json({ jsonrpc: "2.0", id, result: { value: lamports } });
  }

  // 2. Fake transaction success
  if (method === 'sendTransaction') {
    return res.json({ jsonrpc: "2.0", id, result: "1111111111111111111111111111111111111111111111111111111111111111" });
  }

  // Forward everything else to real RPC
  try {
    const r = await axios.post(REAL_RPC, req.body, { timeout: 10000 });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE SOL RPC IS LIVE');
  console.log(`URL → https://your-rpc-service.onrender.com`);
  console.log('Paste this URL in Backpack → Settings → RPC Address');
});
