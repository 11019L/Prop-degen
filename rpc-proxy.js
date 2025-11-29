require('dotenv').config();
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS – Backpack needs this
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const REAL_RPC = 'https://api.mainnet-beta.solana.com';

// Open DB safely
const db = new sqlite3.Database('crucible.db', (err) => {
  if (err) console.error('DB error:', err);
  else console.log('DB connected');
});

const balances = new Map();

function loadBalances() {
  db.all(
    `SELECT publicKey, balance FROM users WHERE paid=1 AND failed=0`,
    (err, rows) => {
      balances.clear();

      if (err) {
        console.error('Query error:', err);
        return;
      }

      // THIS LINE FIXES EVERYTHING – safe even if rows is null
      (rows || []).forEach((row) => {
        if (row?.publicKey) {
          balances.set(row.publicKey, Number(row.balance || 500));
        }
      });

      console.log(`Loaded ${balances.size} accounts`);
    }
  );
}

// Load now + every 12 seconds
loadBalances();
setInterval(loadBalances, 12000);

// MAIN RPC ENDPOINT
app.post('/', async (req, res) => {
  try {
    const { method = '', params = [], id } = req.body || {};
    const pubkey = params[0]?.toString?.() || params[0];

    // Fake SOL
    if (method === 'getBalance' && balances.has(pubkey)) {
      return res.json({ jsonrpc: '2.0', id, result: { value: 500000000 } });
    }

    // Fake USDC
    if (method === 'getTokenAccountsByOwner' && balances.has(pubkey)) {
      const usd = balances.get(pubkey);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          value: [
            {
              pubkey: 'fakeusdc111111111111111111111111111111111',
              account: {
                data: {
                  parsed: {
                    info: {
                      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                      tokenAmount: { amount: String(usd * 1000000), decimals: 6 },
                    },
                  },
                },
                executable: false,
                lamports: 2039280,
                owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              },
            },
          ],
        },
      });
    }

    // Fake tx success
    if (method === 'sendTransaction') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: '1111111111111111111111111111111111111111111111111111111111111111',
      });
    }

    // Forward to real RPC
    const r = await axios.post(REAL_RPC, req.body, { timeout: 10000 });
    res.json(r.data);
  } catch (e) {
    console.error('RPC error:', e.message);
    res
      .status(500)
      .json({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Server error' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('FAKE RPC IS 100% LIVE');
  console.log('URL → https://your-service.onrender.com');
});
