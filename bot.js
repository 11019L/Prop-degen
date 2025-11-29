require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');
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
  failed INTEGER DEFAULT 0   -- 0=active, 1=failed, 2=winner
)`);

const ADMIN_ID = Number(process.env.ADMIN_ID);

// ===== 1. Mini App creates funded wallet =====
app.post('/create-funded-wallet', async (req, res) => {
  const { userId, payAmount, virtualBalance, target, bounty, mnemonic, publicKey } = req.body;

  await db.run(`INSERT OR REPLACE INTO users 
    (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [userId, virtualBalance, target, bounty, new Date().toISOString(), mnemonic, publicKey]);

  bot.telegram.sendMessage(ADMIN_ID, `New account\n$${payAmount} → $${virtualBalance}\nUser ${userId}\n${publicKey}`);
  res.json({ok:true});
});

// ===== 2. Real equity from Birdeye (free tier works) =====
async function getEquity(pubkey) {
  try {
    const r = await axios.get(`https://public-api.birdeye.so/wallet/token_list?address=${pubkey}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
    });
    return r.data.data?.total || 0;
  } catch { return 0; }
}

// ===== 3. Helius webhook – auto fail / win =====
app.post('/tx-webhook', async (req, res) => {
  for (const tx of req.body) {
    const pubkey = tx.feePayer || tx.accountKeys?.[0]?.pubkey;
    if (!pubkey) continue;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE publicKey=? AND failed=0 AND paid=1', [pubkey], (e,row)=>r(row)));
    if (!user) continue;

    const equity = await getEquity(pubkey);
    const dd = ((user.balance - equity) / user.balance) * 100;

    if (dd > 12) {
      await db.run('UPDATE users SET failed=1, mnemonic=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, 'Challenge FAILED – Drawdown >12%');
    }
    if (equity >= user.target) {
      await db.run('UPDATE users SET failed=2, mnemonic=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, `WINNER! You hit $${user.target.toFixed(0)} → DM admin for $${user.bounty} payout`);
    }
  }
  res.send('OK');
});

// ===== 4. Bot commands =====
bot.start(ctx => ctx.replyWithMarkdownV2('*Crucible PROP*\nClick to get your funded Phantom wallet instantly', {
  reply_markup: { inline_keyboard: [[{ text: "Start Challenge", web_app: { url: process.env.MINI_APP_URL } }]] }
}));

bot.command('status', async ctx => {
  const u = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=?', [ctx.from.id], (e,d)=>r(d)));
  if (!u?.paid) return ctx.reply('No active challenge');
  if (u.failed === 1) return ctx.reply('Challenge FAILED');
  if (u.failed === 2) return ctx.reply('You WON! DM admin');
  const eq = await getEquity(u.publicKey);
  ctx.reply(`Equity: $${eq.toFixed(2)}\nTarget: $${u.target}\nDrawdown: ${((u.balance-eq)/u.balance*100).toFixed(2)}%`);
});

// ===== ADMIN instant test =====
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const mnemonic = bip39.generateMnemonic(160);
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const kp = Keypair.fromSeed(ed25519.derivePath("m/44'/501'/0'/0'", seed).key);
  await db.run(`INSERT OR REPLACE INTO users VALUES (?,?,?,-stamp,?,?,?,?,?,?)`,
    [ctx.from.id,1,500,1150,350,new Date().toISOString(),mnemonic,kp.publicKey.toBase58(),0]);
  ctx.replyWithMarkdownV2(`*TEST WALLET*\n\`${mnemonic}\``);
});

// ===== Start =====
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('Bot live – Phantom mode'));
