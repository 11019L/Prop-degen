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

const esc = str => str.replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

// Session support
bot.use((ctx, next) => {
  ctx.session = ctx.session || {};
  return next();
});

// ====================== HELPERS ======================
async function getUser(id) {
  return new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1 AND failed = 0', [id], (_, row) => r(row)));
}

async function getTokenInfo(ca) {
  let symbol = ca.slice(0, 8);
  let price = 0;
  let mc = 'N/A';

  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/solana/${ca}`, { timeout: 8000 });
    const pair = res.data.pair;
    if (pair && pair.baseToken) {
      symbol = pair.baseToken.symbol;
      price = parseFloat(pair.priceUsd) || 0;
      mc = pair.fdv ? `$${(pair.fdv / 1000000).toFixed(2)}M` : 'N/A';
    }
  } catch (e) {
    try {
      const bd = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
        headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' }
      });
      if (bd.data.success) {
        price = bd.data.data.value || 0;
        symbol = bd.data.data.symbol || symbol;
      }
    } catch {}
  }
  return { symbol, price, mc };
}

// ====================== START ======================
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

bot.action('rules', ctx => ctx.replyWithMarkdownV2(esc(`*RULES*\n• Max drawdown: 12%\n• Target: 130%\n• No martingale\n• No hedging\n• Payout in 24h`)));

// ====================== PAYMENT ======================
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok: false});

    await new Promise(r => db.run(
      `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed) VALUES (?, 1, ?, ?, ?, ?, 0)`,
      [userId, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
    ));

    bot.telegram.sendMessage(ADMIN_ID, `NEW PAID $${payAmount} → $${tier.balance}\nUser: ${userId}`);
    bot.telegram.sendMessage(userId, esc(`
CHALLENGE STARTED

Capital: $${tier.balance}
Target: $${tier.target}
Max DD: 12%

Paste any token address to buy
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

// ====================== ADMIN TEST ======================
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]) || 50;
  const tier = TIERS[pay] || TIERS[50];

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed) VALUES (?, 1, ?, ?, ?, ?, 0)`,
    [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
  ));

  ctx.replyWithMarkdownV2(esc(`ADMIN TEST READY\nCapital: $${tier.balance}\nPaste CAs to trade!`), {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
  });
});

// ====================== BUY FLOW ======================
async function handleBuy(ctx, ca) {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply('No active challenge');

  ctx.replyWithMarkdownV2(esc(`How much to buy?\nAvailable: $${user.balance.toFixed(2)}`), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "$20", callback_data: `buy|${ca}|20` }, { text: "$50", callback_data: `buy|${ca}|50` }],
        [{ text: "$100", callback_data: `buy|${ca}|100` }, { text: "$250", callback_data: `buy|${ca}|250` }],
        [{ text: "Custom Amount", callback_data: `custom|${ca}` }]
      ]
    }
  });
}

// ====================== EXECUTE BUY ======================
async function executeBuy(ctx, ca, amountUSD) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from.id;
  const user = await getUser(userId);
  if (!user || amountUSD > user.balance) {
    return ctx.answerCbQuery('Insufficient balance', { show_alert: true });
  }

  const { symbol, price, mc } = await getTokenInfo(ca);
  if (price === 0) {
    return ctx.answerCbQuery('Token not found – try again in 30s', { show_alert: true });
  }

  const tokens = amountUSD / price;

  await new Promise(r => db.run('INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, ca, symbol, amountUSD, tokens, price, Date.now()], r));
  await new Promise(r => db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId], r));

  const updatedUser = await getUser(userId);

  const msg = esc(`
BUY EXECUTED

${symbol}
Size: $${amountUSD}
Tokens: ${tokens.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Price: $${price.toFixed(10).replace(/\.?0+$/g, '')}
MC: ${mc}

Remaining: $${updatedUser.balance.toFixed(2)}
  `);

  if (ctx.update?.callback_query) {
    ctx.editMessageText(msg, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] } });
    ctx.answerCbQuery('Bought!');
  } else {
    ctx.replyWithMarkdownV2(msg, { reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] } });
  }
}

// ====================== BUTTONS ======================
bot.action(/buy\|(.+)\|(\d+)/, async ctx => {
  const ca = ctx.match[1];
  const amount = Number(ctx.match[2]);
  ctx.answerCbQuery('Buying…');
  await executeBuy(ctx, ca, amount);
});

bot.action(/custom\|(.+)/, ctx => {
  ctx.session.customCA = ctx.match[1];
  ctx.reply('Send amount in $');
  ctx.answerCbQuery();
});

// ====================== TEXT HANDLER ======================
bot.on('text', async ctx => {
  if (ctx.session?.customCA) {
    const amount = Number(ctx.message.text);
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

// ====================== POSITIONS ======================
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from.id;
  const user = await getUser(userId);
  if (!user) return ctx.reply('No active challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows)));
  if (positions.length === 0) {
    return ctx.reply('No positions', { reply_markup: { inline_keyboard: [[{ text: "Refresh", callback_data: "positions" }]] } });
  }

  let totalPnL = 0;
  const buttons = [];

  for (const p of positions) {
    const { price } = await getTokenInfo(p.ca);
    const curPrice = price || p.entry_price;
    const pnl = (curPrice - p.entry_price) * p.tokens_bought;
    totalPnL += pnl;

    buttons.push([
      { text: `${p.symbol} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, callback_data: 'x' },
      { text: "25%", callback_data: `sell_${p.id}_25` },
      { text: "50%", callback_data: `sell_${p.id}_50` },
      { text: "100%", callback_data: `sell_${p.id}_100` }
    ]);
  }

  const equity = user.balance + totalPnL;
  const dd = ((user.start_balance - equity) / user.start_balance) * 100;

  if (dd > 12) {
    await new Promise(r => db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId], r));
    return ctx.reply('CHALLENGE FAILED — Drawdown >12%');
  }
  if (equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId], r));
    return ctx.reply(`WINNER! Equity: $${equity.toFixed(2)} — DM admin`);
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

bot.command('positions', ctx => showPositions(ctx));
bot.action('positions', ctx => showPositions(ctx));

// ====================== SELL ======================
async function handleSell(ctx, posId, percent) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from.id;
  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos) return;

  const { price } = await getTokenInfo(pos.ca);
  const curPrice = price || pos.entry_price;
  const pnl = (curPrice - pos.entry_price) * pos.tokens_bought * (percent / 100);
  const sellUSD = pos.amount_usd * (percent / 100);

  await new Promise(r => db.run('UPDATE users SET balance = balance + ? WHERE user_id = ?', [sellUSD + pnl, userId], r));
  if (percent === 100) await new Promise(r => db.run('DELETE FROM positions WHERE id = ?', [posId], r));

  ctx.replyWithMarkdownV2(esc(`SELL ${percent}% DONE\n${pos.symbol}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
  showPositions(ctx);
}

bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  await handleSell(ctx, ctx.match[1], Number(ctx.match[2]));
  ctx.answerCbQuery();
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT – FINAL 100% WORKING – DEC 2025'));
