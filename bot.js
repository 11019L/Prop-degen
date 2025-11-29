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

// FULL DB SCHEMA (run once – safe if already exists)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    balance REAL,
    target REAL,
    bounty REAL,
    start_date TEXT,
    last_tx INTEGER,
    hwm REAL,
    hwm_date TEXT,
    mnemonic TEXT,
    publicKey TEXT,
    failed INTEGER DEFAULT 0   -- 0=active, 1=failed, 2=winner
  )`);
});

const ADMIN_ID = Number(process.env.ADMIN_ID);
let dailyWinners = 0;
let winnerDate = new Date().toDateString();

// === RESET DAILY WINNER COUNT ===
function resetDailyWinners() {
  const today = new Date().toDateString();
  if (today !== winnerDate) {
    dailyWinners = 0;
    winnerDate = today;
  }
}

// === GET REAL EQUITY (Birdeye) ===
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

// === GET TOKEN LIST FOR POSITION CHECKS ===
async function getWalletTokens(pubkey) {
  try {
    const r = await axios.get(`https://public-api.birdeye.so/wallet/token_list?address=${pubkey}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
    });
    return r.data.data?.items || [];
  } catch { return []; }
}

// === PRICE 6H AGO FOR PUMP CHECK ===
async function getPrice6hAgo(mint) {
  try {
    const from = Math.floor((Date.now() - 6 * 3600000) / 1000);
    const r = await axios.get(`https://public-api.birdeye.so/defi/history_price?address=${mint}&time_from=${from}&time_to=${from + 3600}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
    });
    return r.data.data?.items?.[0]?.value || null;
  } catch { return null; }
}

// === FAIL USER + DELETE PHRASE ===
async function failUser(userId, reason) {
  await db.run('UPDATE users SET failed=1, mnemonic=NULL, publicKey=NULL WHERE user_id=?', [userId]);
  bot.telegram.sendMessage(userId, `Challenge FAILED\nReason: ${reason}\nYour keyphrase has been permanently deleted.`);
}

// === HELIUS TRANSACTION WEBHOOK – ALL RULES ENFORCED ===
app.post('/tx-webhook', async (req, res) => {
  resetDailyWinners();

  for (const tx of req.body) {
    const pubkey = tx.feePayer || tx.accountKeys?.[0]?.pubkey;
    if (!pubkey) continue;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE publicKey=? AND failed=0 AND paid=1', [pubkey], (_, row) => r(row)));
    if (!user) continue;

    const now = Date.now();
    const startTime = new Date(user.start_date).getTime();
    const equity = await getEquity(pubkey);

    // 1. 10-day limit
    if (now - startTime > 10 * 24 * 60 * 60 * 1000) {
      await failUser(user.user_id, "10-day limit reached");
      continue;
    }

    // 2. No trade in 48h
    if (user.last_tx && now - user.last_tx > 48 * 60 * 60 * 1000) {
      await failUser(user.user_id, "No trade in 48 hours");
      continue;
    }
    db.run('UPDATE users SET last_tx=? WHERE user_id=?', [now, user.user_id]);

    // 3. Daily drawdown from high-water mark
    const today = new Date().toDateString();
    let hwm = user.hwm || equity;
    if (user.hwm_date !== today || equity > hwm) {
      hwm = equity;
      db.run('UPDATE users SET hwm=?, hwm_date=? WHERE user_id=?', [hwm, today, user.user_id]);
    }
    if ((hwm - equity) / hwm > 0.12) {
      await failUser(user.user_id, "Daily drawdown >12%");
      continue;
    }

    // 4. Max position size 25%
    const tokens = await getWalletTokens(pubkey);
    for (const t of tokens) {
      if (t.value > user.balance * 0.25) {
        await failUser(user.user_id, "Position size >25% of balance");
        continue;
      }
      // 5. No coin pumped >300% in last 6h
      if (t.mint && t.mint !== 'So11111111111111111111111111111111111111112') {
        const oldPrice = await getPrice6hAgo(t.mint);
        if (oldPrice && t.price / oldPrice > 4) {
          await failUser(user.user_id, "Bought coin that pumped >300% in 6h");
          continue;
        }
      }
    }

    // WINNER?
    if (equity >= user.target) {
      if (dailyWinners >= 5) {
        bot.telegram.sendMessage(user.user_id, "You hit target but daily 5-winner cap reached. Contact admin.");
      } else {
        dailyWinners++;
        db.run('UPDATE users SET failed=2, mnemonic=NULL WHERE user_id=?', [user.user_id]);
        bot.telegram.sendMessage(user.user_id, `WINNER #${dailyWinners} TODAY!\nDM admin for $${user.bounty} payout`);
      }
    }
  }
  res.send('OK');
});

// === CREATE FUNDED WALLET (mini app) + SEND PHRASE ===
app.post('/create-funded-wallet', async (req, res) => {
  const { userId, payAmount, virtualBalance, target, bounty, mnemonic, publicKey } = req.body;

  db.run(`INSERT OR REPLACE INTO users 
    (user_id, paid, balance, target, bounty, start_date, mnemonic, publicKey, failed)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [userId, virtualBalance, target, bounty, new Date().toISOString(), mnemonic, publicKey]);

  bot.telegram.sendMessage(ADMIN_ID, `New account\n$${payAmount} → $${virtualBalance}\nUser ${userId}\n${publicKey}`);

  // SEND PHRASE PRIVATELY
  bot.telegram.sendMessage(userId,
    `*FUNDED ACCOUNT READY*\n\nYour 12-word Phantom phrase:\n\`${mnemonic}\`\n\nImport into Phantom → $${virtualBalance} ready\n\nSAVE IT NOW – disappears forever on fail!`,
    { parse_mode: 'Markdown' }
  );

  res.json({ ok: true });
});

// === BOT COMMANDS ===
bot.start(ctx => ctx.replyWithMarkdownV2('*Crucible PROP*\n\nGet your funded Phantom wallet instantly', {
  reply_markup: { inline_keyboard: [[{ text: "Start Challenge", web_app: { url: process.env.MINI_APP_URL } }]] }
}));

bot.command('status', async ctx => {
  const u = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=?', [ctx.from.id], (_, d) => r(d)));
  if (!u?.paid) return ctx.reply('No active challenge');
  if (u.failed === 1) return ctx.reply('Challenge FAILED');
  if (u.failed === 2) return ctx.reply('You WON! DM admin');
  const eq = await getEquity(u.publicKey || '');
  ctx.replyWithMarkdownV2(`*Status*\nEquity: $${eq.toFixed(2)}\nTarget: $${u.target}\nDrawdown: ${((u.balance - eq) / u.balance * 100).toFixed(2)}%`);
});

// === ADMIN TEST ===
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const mnemonic = bip39.generateMnemonic(128); // ← 12 words
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const kp = Keypair.fromSeed(derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key);
  const pub = kp.publicKey.toBase58();

  db.run(`INSERT OR REPLACE INTO users (user_id,paid,balance,target,bounty,start_date,mnemonic,publicKey,failed) 
          VALUES (?,?,500,1150,350,?,?,?,0)`,
    [ctx.from.id, 1, new Date().toISOString(), mnemonic, pub]);

  ctx.replyWithMarkdownV2(`*TEST ACCOUNT*\n\n\`${mnemonic}\`\n\nImport → $500 ready`);
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('Crucible PROP LIVE – All rules enforced'));
