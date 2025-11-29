require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
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

const ADMIN_ID = Number(process.env.ADMIN_ID);

// Create funded wallet (called from mini app)
app.post('/create-funded-wallet', async (req, res) => {
  const { userId, payAmount, virtualBalance, target, bounty, mnemonic, publicKey } = req.body;

  db.run(`INSERT OR REPLACE INTO users 
    (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [userId, virtualBalance, target, bounty, new Date().toISOString(), mnemonic, publicKey]);

  bot.telegram.sendMessage(ADMIN_ID, `New account\n$${payAmount} → $${virtualBalance}\nUser ${userId}`);
  res.json({ok: true});
});

// Get real wallet equity
async function getEquity(pubkey) {
  try {
    const r = await axios.get(`https://public-api.birdeye.so/wallet/token_list?address=${pubkey}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
    });
    return r.data.data?.total || 0;
  } catch (e) {
    return 0;
  }
}

// Helius webhook – auto fail/win
app.post('/tx-webhook', async (req, res) => {
  for (const tx of req.body) {
    const pubkey = tx.feePayer || tx.accountKeys?.[0]?.pubkey;
    if (!pubkey) continue;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE publicKey=? AND failed=0 AND paid=1', [pubkey], (_, row) => r(row)));
    if (!user) continue;

    const equity = await getEquity(pubkey);
    const dd = ((user.balance - equity) / user.balance) * 100;

    if (dd > 12) {
      db.run('UPDATE users SET failed=1, mnemonic=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, 'Challenge FAILED – Drawdown >12%');
    }
    if (equity >= user.target) {
      db.run('UPDATE users SET failed=2, mnemonic=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, `WINNER! Target hit – DM admin for $${user.bounty} payout`);
    }
  }
  res.send('OK');
});

// Bot commands
bot.start(ctx => ctx.replyWithMarkdownV2('*Crucible PROP*\n\nGet funded Phantom wallet instantly', {
  reply_markup: { inline_keyboard: [[{ text: "Start Challenge", web_app: { url: process.env.MINI_APP_URL } }]] }
}));

bot.command('status', async ctx => {
  const u = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=?', [ctx.from.id], (_, d) => r(d)));
  if (!u?.paid) return ctx.reply('No active challenge');
  if (u.failed === 1) return ctx.reply('Challenge FAILED');
  if (u.failed === 2) return ctx.reply('You WON! DM admin');
  const eq = await getEquity(u.publicKey);
  ctx.replyWithMarkdownV2(`*Status*\nEquity: $${eq.toFixed(2)}\nTarget: $${u.target}\nDrawdown: ${((u.balance-eq)/u.balance*100).toFixed(2)}%`);
});

// Admin instant test wallet
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const mnemonic = bip39.generateMnemonic(160);
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const kp = Keypair.fromSeed(derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key);
  const pub = kp.publicKey.toBase58();

  db.run(`INSERT OR REPLACE INTO users (user_id,paid,balance,target,bounty,start_date,mnemonic,publicKey,failed) 
          VALUES (?,?,500,1150,350,?,?,?,0)`,
    [ctx.from.id, 1, new Date().toISOString(), mnemonic, pub]);

  ctx.replyWithMarkdownV2(`*TEST WALLET READY*\n\n\`${mnemonic}\`\n\nImport into Phantom → $500 ready`);
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('Crucible PROP live'));
