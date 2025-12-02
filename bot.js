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

const TIERS = {
  20: { balance: 200, target: 460, bounty: 140 },
  30: { balance: 300, target: 690, bounty: 210 },
  40: { balance: 400, target: 920, bounty: 280 },
  50: { balance: 500, target: 1150, bounty: 350 }
};

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    balance REAL,
    start_balance REAL,
    target REAL,
    bounty REAL,
    failed INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ca TEXT,
    symbol TEXT,
    amount_usd REAL,
    tokens_bought REAL,
    entry_price REAL,
    created_at INTEGER
  )`);
});

const esc = str => String(str).replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

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
        [{ text: "Rules", callback_data: "rules" }]
      ]
    }
  });
});

bot.action('rules', ctx => {
  ctx.answerCbQuery();
  ctx.replyWithMarkdownV2(esc(`*RULES*\n\n• Max drawdown: 12%\n• Target: 130%\n• No martingale\n• No hedging\n• Payout in 24h`));
});

// ====================== PAYMENT WEBHOOK ======================
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok: false});

    await new Promise(r => db.run(
      `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
      [userId, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
    ));

    bot.telegram.sendMessage(ADMIN_ID, `NEW PAID $${payAmount} → $${tier.balance}\nUser: ${userId}`);
    bot.telegram.sendMessage(userId, esc(`
CHALLENGE STARTED

Capital: $${tier.balance}
Target: $${tier.target}
Max DD: 12%

Paste any Solana token address to buy
    `), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
    });

    res.json({ok: true});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok: false});
  }
});

// ====================== ADMIN TEST (FIXED) ======================
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]);
  if (![20, 30, 40, 50].includes(pay)) {
    return ctx.reply('Usage: /admin_test 20 | 30 | 40 | 50');
  }
  const tier = TIERS[pay];

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
     VALUES (?, 1, ?, ?, ?, ?, 0)`,
    [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
  ));

  ctx.replyWithMarkdownV2(esc(`ADMIN TEST READY\n$${pay} → $${tier.balance}\nStart pasting CAs!`), {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
  });
});

// ====================== BUY FLOW ======================
async function handleBuy(ctx, ca) {
  const user = await new Promise(r => db.get('SELECT balance FROM users WHERE user_id=? AND paid=1', [ctx.from.id], (_, row) => r(row)));
  if (!user) return ctx.reply('No active challenge');

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

// ====================== BUY BUTTON — FIXED (CORRECT MC, AGE, NO WRONG DATA) ======================
bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  try {
    await ctx.answerCbQuery('Sniping…');

    const ca = ctx.match[1].trim();
    const amount = Number(ctx.match[2]);
    const userId = ctx.from.id;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=? AND paid=1 AND failed=0', [userId], (_, row) => r(row)));
    if (!user || amount > user.balance) {
      return ctx.editMessageText('Insufficient balance');
    }

    // PRO ENDPOINT — SORTS BY LIQUIDITY FOR CORRECT PAIR
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
    const { data } = await axios.get(url, { timeout: 9000 });

    let pair = null;
    if (data.pairs && data.pairs.length > 0) {
      pair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    }

    if (!pair) {
      return ctx.editMessageText('No pair found – too new, try in 10s');
    }

    const symbol = pair.baseToken.symbol;
    const price = parseFloat(pair.priceUsd);
    const mc = pair.marketCap ? `$${(pair.marketCap / 1000000).toFixed(2)}M` : 'New';
    const createdAt = pair.pairCreatedAt; // ms timestamp
    const ageMins = createdAt ? Math.floor((Date.now() - createdAt) / (1000 * 60)) : 0;

    const tokens = amount / price;

    await new Promise(r => db.run(
      'INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at) VALUES (?,?,?,?,?,?,?)',
      [userId, ca, symbol, amount, tokens, price, Date.now()], r
    ));
    await new Promise(r => db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amount, userId], r));

    const msg = esc(`
BUY EXECUTED

${symbol}
Size: $${amount}
Tokens: ${tokens.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${price.toFixed(12).replace(/\.?0+$/, '')}
MC: ${mc}
Age: ${ageMins}m

Remaining: $${(user.balance - amount).toFixed(2)}
    `);

    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
    });

  } catch (err) {
    console.error(err);
    try { await ctx.editMessageText('Buy failed – try again'); } catch {}
  }
});

// ====================== CUSTOM AMOUNT ======================
bot.action(/custom\|(.+)/, async ctx => {
  ctx.session = ctx.session || {};
  ctx.session.customCA = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply('Send amount in USD (e.g. 123.45)');
});

bot.on('text', async ctx => {
  if (ctx.session?.customCA) {
    const amount = Number(ctx.message.text);
    const ca = ctx.session.customCA;
    delete ctx.session.customCA;
    if (amount > 0) {
      const fakeCtx = { from: ctx.from, update: { callback_query: null } };
      await bot.action(`buy|${ca}|${amount}`, fakeCtx);
    }
    return;
  }

  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(text)) {
    await handleBuy(ctx, text);
  }
});

// ====================== POSITIONS — FIXED DD CALC (NO FALSE TRIGGERS) ======================
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from?.id;
  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=? AND paid=1 AND failed=0', [userId], (_, row) => r(row)));
  if (!user) return ctx.reply('No active challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id=?', [userId], (_, rows) => r(rows || [])));
  if (positions.length === 0) {
    return ctx.reply('No positions', { reply_markup: { inline_keyboard: [[{ text: "Refresh", callback_data: "positions" }]] } });
  }

  let totalPnL = 0;
  const buttons = [];

  for (const p of positions) {
    let price = p.entry_price;
    try {
      const r = await axios.get(`https://public-api.birdeye.so/defi/price?address=${p.ca}`, {
        headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
      });
      price = r.data.data?.value || p.entry_price;
    } catch {}

    const pnl = (price - p.entry_price) * p.tokens_bought;
    totalPnL += pnl;

    buttons.push([
      { text: `${p.symbol} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, callback_data: 'noop' },
      { text: "25%", callback_data: `sell_${p.id}_25` },
      { text: "50%", callback_data: `sell_${p.id}_50` },
      { text: "100%", callback_data: `sell_${p.id}_100` }
    ]);
  }

  const equity = user.balance + totalPnL;
  const dd = equity > 0 ? Math.max(0, ((user.start_balance - equity) / user.start_balance) * 100) : 100; // Fixed: max(0, ...) to avoid negatives; check equity > 0

  if (dd > 12) {
    await new Promise(r => db.run('UPDATE users SET failed=1 WHERE user_id=?', [userId], r));
    return ctx.reply('CHALLENGE FAILED — Drawdown >12%');
  }
  if (equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed=2 WHERE user_id=?', [userId], r));
    return ctx.reply(`WINNER! Equity $${equity.toFixed(2)} — DM admin`);
  }

  ctx.replyWithMarkdownV2(esc(`
LIVE POSITIONS

Equity: $${equity.toFixed(2)}
PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Drawdown: ${dd.toFixed(2)}%
  `), {
    reply_markup: { inline_keyboard: [...buttons, [{ text: "Refresh", callback_data: "positions" }]] }
  });
}

bot.command('positions', showPositions);
bot.action('positions', ctx => { ctx.answerCbQuery(); showPositions(ctx); });
bot.action('noop', ctx => ctx.answerCbQuery());

// ====================== SELL ======================
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  try {
    await ctx.answerCbQuery('Selling…');
    const posId = ctx.match[1];
    const percent = Number(ctx.match[2]);
    const userId = ctx.update.callback_query.from.id;

    const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id=? AND user_id=?', [posId, userId], (_, row) => r(row)));
    if (!pos) return;

    let curPrice = pos.entry_price;
    try {
      const r = await axios.get(`https://public-api.birdeye.so/defi/price?address=${pos.ca}`, {
        headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
      });
      curPrice = r.data.data?.value || pos.entry_price;
    } catch {}

    const sellUSD = pos.amount_usd * (percent / 100);
    const pnl = (curPrice - pos.entry_price) * pos.tokens_bought * (percent / 100);

    await new Promise(r => db.run('UPDATE users SET balance = balance + ? WHERE user_id=?', [sellUSD + pnl, userId], r));
    if (percent === 100) {
      await new Promise(r => db.run('DELETE FROM positions WHERE id=?', [posId], r));
    }

    await ctx.replyWithMarkdownV2(esc(`SELL ${percent}% ${pos.symbol}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
    showPositions(ctx);
  } catch (err) {
    console.error(err);
    await ctx.answerCbQuery('Sell failed', { show_alert: true });
  }
});

// ====================== START ======================
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT — FIXED MC/AGE/DD — DEC 2025'));

process.on('SIGINT', () => { db.close(); bot.stop(); process.exit(); });
process.on('SIGTERM', () => { db.close(); bot.stop(); process.exit(); });
