require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
const ADMIN_ID = Number(process.env.ADMIN_ID);

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

// BACKPACK-COMPATIBLE WALLET GENERATOR
async function generateBackpackWallet(virtualBalanceUSD = 500) {
  const mnemonic = bip39.generateMnemonic(128);
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'", seed).key; // Backpack default
  const keypair = Keypair.fromSeed(derivedSeed);
  return {
    mnemonic,
    publicKey: keypair.publicKey.toBase58(),
    balanceUSD: virtualBalanceUSD
  };
}

// TIERS – $20 → $200 in SOL, etc.
const TIERS = {
  20: { pay: 20,  balanceUSD: 200,  target: 460,   bounty: 140 },
  30: { pay: 30,  balanceUSD: 300,  target: 690,   bounty: 210 },
  40: { pay: 40,  balanceUSD: 400,  target: 920,   bounty: 280 },
  50: { pay: 50,  balanceUSD: 500,  target: 1150,  bounty: 350 }
};

// CREATE FUNDED WALLET (mini-app)
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ ok: false });

    const { mnemonic, publicKey } = await generateBackpackWallet(tier.balanceUSD);

    await new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO users 
        (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
        [userId, tier.balanceUSD, tier.target, tier.bounty, new Date().toISOString(), mnemonic, publicKey],
        err => err ? reject(err) : resolve()
      );
    });

    await bot.telegram.sendMessage(ADMIN_ID, `
NEW PAID ACCOUNT
$${payAmount} → $${tier.balanceUSD} in SOL
User: ${userId}
${publicKey}
    `.trim());

    await bot.telegram.sendMessage(userId, `
CHALLENGE ACCOUNT READY!

You paid: *$${payAmount}*
Virtual capital: *$${tier.balanceUSD} in SOL*
Profit target: *$${tier.target}*
Payout if you pass: *$${tier.bounty}*

Recovery phrase (shown once):
\`${mnemonic}\`

Import into **Backpack Wallet**
→ Settings → Developer → Custom RPC
→ Paste: ${process.env.RPC_URL || 'https://your-rpc.onrender.com'}

$${tier.balanceUSD} in SOL appears immediately!

Good luck trader
    `.trim(), { parse_mode: 'Markdown' });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// ADMIN TEST
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]) || 50;
  const tier = TIERS[pay] || TIERS[50];

  const { mnemonic, publicKey } = await generateBackpackWallet(tier.balanceUSD);

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [ctx.from.id, tier.balanceUSD, tier.target, tier.bounty, new Date().toISOString(), mnemonic, publicKey], () => r()
  ));

  ctx.replyWithMarkdownV2(`
*ADMIN TEST – $${tier.balanceUSD} in SOL*

Phrase:
\`${mnemonic}\`

Address: \`${publicKey}\`

Import → use your RPC URL → $${tier.balanceUSD} in SOL shows instantly
  `.trim());
});

// STATUS
bot.command('status', async ctx => {
  const row = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=?', [ctx.from.id], (_, row) => r(row)));
  if (!row?.paid) return ctx.reply('No active challenge');
  if (row.failed === 1) return ctx.reply('FAILED – Drawdown exceeded');
  if (row.failed === 2) return ctx.reply('WINNER! DM admin for payout');

  ctx.replyWithMarkdownV2(`
*Challenge Status*

Capital: *$${row.balance} in SOL*
Target: *$${row.target}*
Current equity: check Backpack
Max drawdown: 12%
  `.trim());
});

// STATS
bot.command('stats', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const d = await new Promise(r => db.get('SELECT COUNT(*) as c, SUM(balance) as v FROM users WHERE paid=1 AND failed=0', (_, row) => r(row)));
  ctx.reply(`Active: ${d.c || 0}\nVolume: $${d.v?.toFixed(0) || 0} in SOL`);
});

// START MENU
bot.start(ctx => ctx.replyWithMarkdownV2('*Crucible Prop Firm*\n\nChoose your challenge', {
  reply_markup: {
    inline_keyboard: [
      [{ text: "$20 → $200 in SOL",  web_app: { url: process.env.MINI_APP_URL + '?tier=20' } }],
      [{ text: "$30 → $300 in SOL",  web_app: { url: process.env.MINI_APP_URL + '?tier=30' } }],
      [{ text: "$40 → $400 in SOL",  web_app: { url: process.env.MINI_APP_URL + '?tier=40' } }],
      [{ text: "$50 → $500 in SOL",  web_app: { url: process.env.MINI_APP_URL + '?tier=50' } }],
    ]
  }
}));

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT – $500 in SOL – LIVE DEC 2025'));
