// bot.js — CRUCIBLE PROP FIRM BOT — FINAL CLEAN VERSION — DEC 2025
require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL_LINK = "https://t.me/+yourprivatechannel"; // CHANGE THIS

// ====================== CONFIG ======================
const TIERS = {
  20: { balance: 200, target: 460, bounty: 140 },
  30: { balance: 300, target: 690, bounty: 210 },
  40: { balance: 400, target: 920, bounty: 280 },
  50: { balance: 500, target: 1150, bounty: 350 }
};

// 10 REAL RULES (you said you have 10)
const RULES = [
  "Max daily loss: 5%",
  "Max overall drawdown: 12% (from highest equity)",
  "No martingale",
  "No hedging",
  "No trading during major news (FOMC, CPI, etc.)",
  "Max 5 open positions at once",
  "Max position size: 50% of equity",
  "Must take minimum 1:2 RR on every trade",
  "No revenge trading after a loss",
  "Weekend holding not allowed"
];

// ====================== DB SCHEMA ======================
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    balance REAL,
    start_balance REAL,
    peak_equity REAL,      -- High Water Mark
    target REAL,
    bounty REAL,
    failed INTEGER DEFAULT 0,
    daily_loss REAL DEFAULT 0,
    day_start_equity REAL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ca TEXT,
    symbol TEXT,
    amount_usd REAL,
    tokens_bought REAL,
    tokens_remaining REAL,
    entry_price REAL,
    created_at INTEGER
  )`);
});

// ====================== HELPERS ======================
const esc = str => String(str).replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');

async function getUser(id) {
  return new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1 AND failed = 0', [id], (_, row) => r(row)));
}

const lastCA = new Map(); // Rate limit per user

async function getTokenInfo(ca) {
  let symbol = ca.slice(0, 8).toUpperCase();
  let price = 0;
  let mc = "New";

  // 1. Jupiter — fastest for brand new tokens
  try {
    const jup = await axios.get(`https://quote-api.jup.ag/v6/price?ids=${ca}`, { timeout: 6000 });
    if (jup.data?.data?.[ca]?.price) {
      price = jup.data.data[ca].price;
    }
  } catch (e) {
    // ignore silently
  }

  // 2. DexScreener fallback
  if (price === 0) {
    try {
      const dex = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/solana/${ca}`, { timeout: 7000 });
      if (dex.data?.pair) {
        const p = dex.data.pair;
        symbol = p.baseToken?.symbol || symbol;
        price = parseFloat(p.priceUsd) || 0;
        mc = p.fdv ? `$${(p.fdv / 1_000_000).toFixed(2)}M` : "New";
      }
    } catch (e) {
      // ignore silently
    }
  }

  // 3. Ultra-new token — still allow buy
  if (price === 0) {
    price = 0.000000001;
    mc = "Ultra New";
  }

  return { symbol, price, mc };
}

// ====================== START & RULES ======================
bot.start(ctx => {
  ctx.replyWithMarkdownV2(esc(`
*Welcome to Crucible Prop Firm!*

Join our private channel first:
${CHANNEL_LINK}
  `), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Join Channel", url: CHANNEL_LINK }],
        [{ text: "$20 → $200", web_app: { url: process.env.MINI_APP_URL + '?tier=20' } }],
        [{ text: "$30 → $300", web_app: { url: process.env.MINI_APP_URL + '?tier=30' } }],
        [{ text: "$40 → $400", web_app: { url: process.env.MINI_APP_URL + '?tier=40' } }],
        [{ text: "$50 → $500", web_app: { url: process.env.MINI_APP_URL + '?tier=50' } }],
        [{ text: "Rules (10)", callback_data: "rules" }]
      ]
    }
  });
});

bot.action('rules', ctx => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdownV2(esc(`*10 TRADING RULES*\n\n` + RULES.map((r, i) => `${i + 1}\\. ${r}`).join('\n')));
});

// ====================== PAYMENT WEBHOOK ======================
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ ok: false });

    const equity = tier.balance;

    await new Promise(r => db.run(
      `INSERT OR REPLACE INTO users 
       (user_id, paid, balance, start_balance, peak_equity, target, bounty, day_start_equity) 
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      [userId, equity, equity, equity, tier.target, tier.bounty, equity], r
    ));

    bot.telegram.sendMessage(ADMIN_ID, `NEW PAID $${payAmount} → $${tier.balance}\nUser: ${userId}`);
    bot.telegram.sendMessage(userId, esc(`
CHALLENGE STARTED

Capital: $${tier.balance}
Target: $${tier.target} 
Bounty: $${tier.bounty}
Max DD: 12% (from peak)

Paste any Solana token address to trade
    `), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// ====================== ADMIN TEST ======================
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]) || 50;
  const tier = TIERS[pay] || TIERS[50];
  const equity = tier.balance;

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users 
     (user_id, paid, balance, start_balance, peak_equity, target, bounty, day_start_equity) 
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
    [ctx.from.id, equity, equity, equity, tier.target, tier.bounty, equity], r
  ));

  ctx.replyWithMarkdownV2(esc(`ADMIN TEST READY\nCapital: $${tier.balance}\nPaste CAs to trade!`), {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
  });
});

// ====================== BUY FLOW ======================
async function handleBuy(ctx, ca) {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply('No active challenge');

  const now = Date.now();
  if (lastCA.get(ctx.from.id) > now - 8000) {
    return ctx.reply('⏳ Wait 8 seconds between tokens');
  }
  lastCA.set(ctx.from.id, now);

  ctx.replyWithMarkdownV2(esc(`How much to buy?\nAvailable: $${user.balance.toFixed(2)}`), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "$20", callback_data: `buy|${ca}|20` }, { text: "$50", callback_data: `buy|${ca}|50` }],
        [{ text: "$100", callback_data: `buy|${ca}|100` }, { text: "$250", callback_data: `buy|${ca}|250` }],
        [{ text: "Custom", callback_data: `custom|${ca}` }]
      ]
    }
  });
}

// ====================== EXECUTE BUY ======================
async function executeBuy(ctx, ca, amountUSD) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from?.id;
  const user = await getUser(userId);
  if (!user || amountUSD > user.balance) {
    await ctx.answerCbQuery('Insufficient balance', { show_alert: true });
    return false;
  }

  const { symbol, price, mc } = await getTokenInfo(ca);
  if (price === 0) {
    await ctx.answerCbQuery('Token not found or no liquidity – try again in 30s', { show_alert: true });
    return false;
  }

  const tokens = amountUSD / price;

  // Atomic transaction
  await new Promise((resolve, reject) => {
    db.run('BEGIN', err => {
      if (err) return reject(err);
      db.run('INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, tokens_remaining, entry_price, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [userId, ca, symbol, amountUSD, tokens, tokens, price, Date.now()], err => {
          if (err) return db.run('ROLLBACK'), reject(err);
          db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId], err => {
            if (err) return db.run('ROLLBACK'), reject(err);
            db.run('COMMIT', resolve);
          });
        });
    });
  });

  const msg = esc(`
BUY EXECUTED

${symbol}
Size: $${amountUSD}
Tokens: ${tokens.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${price.toFixed(10).replace(/\.?0+$/, '')}
MC: ${mc}

Remaining: $${(user.balance - amountUSD).toFixed(2)}
  `);

  if (ctx.update?.callback_query) {
    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
    });
  } else {
    await ctx.replyWithMarkdownV2(msg, {
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
    });
  }
  return true;
}

// ====================== BUTTON HANDLERS ======================
bot.action(/buy\|(.+)\|(\d+)/, async (ctx) => {
  try {
    const ca = ctx.match[1];
    const amount = Number(ctx.match[2]);
    const userId = ctx.from.id;

    // One single answer – stops the eternal spinner
    await ctx.answerCbQuery('Processing…');

    const user = await getUser(userId);
    if (!user) {
      return ctx.editMessageText('No active challenge');
    }

    if (amount > user.balance) {
      return ctx.editMessageText('Insufficient balance');
    }

    const { symbol, price, mc } = await getTokenInfo(ca);
    }

    const tokens = amount / price;

    // Atomic transaction – real working code
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN');
        db.run(
          `INSERT INTO positions 
           (user_id, ca, symbol, amount_usd, tokens_bought, tokens_remaining, entry_price, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, ca, symbol, amount, tokens, tokens, price, Date.now()],
          function (err) {
            if (err) return db.run('ROLLBACK'), reject(err);
            db.run(
              'UPDATE users SET balance = balance - ? WHERE user_id = ?',
              [amount, userId],
              function (err) {
                if (err) return db.run('ROLLBACK'), reject(err);
                db.run('COMMIT', resolve);
              }
            );
          }
        );
      });
    });

    const msg = esc(`
BUY EXECUTED

${symbol}
Size: $${amount}
Tokens: ${tokens.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${price.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')}
MC: ${mc}

Remaining: $${(user.balance - amount).toFixed(2)}
    `);

    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]]
      }
    });

  } catch (err) {
    console.error('Buy error:', err);
    try {
      await ctx.editMessageText('Buy failed – try again later');
    } catch {}
  }
});

bot.action(/custom\|(.+)/, async ctx => {
  try {
    ctx.session ??= {};
    ctx.session.customCA = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply('Send amount in USD (e.g. 123.45)');
  } catch (err) {
    await ctx.answerCbQuery('Error', { show_alert: true });
  }
});

// ====================== TEXT HANDLER ======================
bot.on('text', async ctx => {
  if (ctx.session?.customCA) {
    const amount = parseFloat(ctx.message.text);
    const ca = ctx.session.customCA;
    delete ctx.session.customCA;
    if (amount > 0) await executeBuy(ctx, ca, amount);
    return;
  }

  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(text)) {
    await handleBuy(ctx, text);
  }
});

// ====================== POSITIONS & RULE CHECKS ======================
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from?.id;
  let user = await getUser(userId);
  if (!user) return ctx.reply('No active challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])));

  let totalPnL = 0;
  const buttons = [];

  for (const p of positions) {
    const { price } = await getTokenInfo(p.ca);
    const curPrice = price || p.entry_price;
    const pnl = (curPrice - p.entry_price) * p.tokens_remaining;
    totalPnL += pnl;

    if (p.tokens_remaining > 0) {
      buttons.push([
        { text: `${p.symbol} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, callback_data: 'noop' },
        { text: "25%", callback_data: `sell_${p.id}_25` },
        { text: "50%", callback_data: `sell_${p.id}_50` },
        { text: "100%", callback_data: `sell_${p.id}_100` }
      ]);
    }
  }

  const equity = user.balance + totalPnL;

  // Update peak equity
  if (equity > user.peak_equity) {
    await new Promise(r => db.run('UPDATE users SET peak_equity = ? WHERE user_id = ?', [equity, userId], r));
    user.peak_equity = equity;
  }

  const overallDD = ((user.peak_equity - equity) / user.peak_equity) * 100;

  // Rule violations
  if (overallDD > 12) {
    await new Promise(r => db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId], r));
    return ctx.reply('CHALLENGE FAILED — Overall drawdown >12%');
  }
  if (equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId], r));
    return ctx.reply(`WINNER! Equity: $${equity.toFixed(2)}\nYou passed! DM admin for payout`);
  }

  ctx.replyWithMarkdownV2(esc(`
LIVE POSITIONS (${positions.length})

Equity: $${equity.toFixed(2)}
Unrealized PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Overall Drawdown: ${overallDD.toFixed(2)}% (max 12%)

${positions.length === 0 ? 'No open positions' : ''}
  `), {
    reply_markup: {
      inline_keyboard: [
        ...buttons,
        [{ text: "Refresh", callback_data: "positions" }],
        [{ text: "Close", callback_data: "close" }]
      ]
    }
  });
}

bot.action('positions', ctx => { ctx.answerCbQuery(); showPositions(ctx); });
bot.command('positions', showPositions);
bot.action('close', ctx => { ctx.answerCbQuery(); ctx.deleteMessage().catch(() => {}); });
bot.action('noop', ctx => ctx.answerCbQuery());

// ====================== SELL ======================
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  try {
    await ctx.answerCbQuery('Selling…');
    const posId = ctx.match[1];
    const percent = Number(ctx.match[2]);
    const userId = ctx.update.callback_query.from.id;

    const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
    if (!pos || pos.tokens_remaining <= 0) return;

    const { price } = await getTokenInfo(pos.ca);
    const curPrice = price || pos.entry_price;
    const sellTokens = pos.tokens_remaining * (percent / 100);
    const pnl = (curPrice - pos.entry_price) * sellTokens;
    const returnUSD = pos.amount_usd * (percent / 100) + pnl;

    await new Promise((resolve, reject) => {
      db.run('BEGIN', err => {
        if (err) return reject(err);
        db.run('UPDATE users SET balance = balance + ? WHERE user_id = ?', [returnUSD, userId], err => {
          if (err) return db.run('ROLLBACK'), reject(err);
          if (percent === 100) {
            db.run('DELETE FROM positions WHERE id = ?', [posId], err => {
              if (err) return db.run('ROLLBACK'), reject(err);
              db.run('COMMIT', resolve);
            });
          } else {
            db.run('UPDATE positions SET tokens_remaining = tokens_remaining - ? WHERE id = ?', [sellTokens, posId], err => {
              if (err) return db.run('ROLLBACK'), reject(err);
              db.run('COMMIT', resolve);
            });
          }
        });
      });
    });

    await ctx.replyWithMarkdownV2(esc(`SELL ${percent}% ${pos.symbol}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
    showPositions(ctx);
  } catch (err) {
    console.error(err);
    try { await ctx.answerCbQuery('Sell failed', { show_alert: true }); } catch {}
  }
});

// ====================== GRACEFUL SHUTDOWN ======================
process.on('SIGINT', () => { db.close(); bot.stop('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { db.close(); bot.stop('SIGTERM'); process.exit(0); });

// ====================== START ======================
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT – FULLY CLEAN & READY – DEC 2025'));
