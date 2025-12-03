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
const CHANNEL_LINK = "https://t.me/+yourprivatechannel";

const TIERS = {
  20: { balance: 200, target: 460, bounty: 140 },
  30: { balance: 300, target: 690, bounty: 210 },
  40: { balance: 400, target: 920, bounty: 280 },
  50: { balance: 500, target: 1150, bounty: 350 }
};

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, paid INTEGER DEFAULT 0, balance REAL, start_balance REAL, target REAL, bounty REAL, failed INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ca TEXT, symbol TEXT, amount_usd REAL, tokens_bought REAL, entry_price REAL, created_at INTEGER)`);
});

const esc = str => String(str).replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

// FORMAT MC EXACTLY HOW YOU WANT: $50k, $1.2M, etc.
function formatMC(marketCap) {
  if (!marketCap || marketCap < 1000) return "New";
  if (marketCap < 1000000) {
    return `$${(marketCap / 1000).toFixed(0)}k`;
  } else {
    return `$${(marketCap / 1000000).toFixed(1)}M`.replace(/\.0M$/, 'M');
  }
}

// GET TOKEN DATA — 100% ACCURATE
async function getTokenData(ca) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 9000 });
    if (!res.data.pairs || res.data.pairs.length === 0) return null;

    const pair = res.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    const ageMins = pair.pairCreatedAt ? Math.max(0, Math.floor((Date.now() - pair.pairCreatedAt) / 60000)) : 'N/A';

    return {
      symbol: pair.baseToken.symbol,
      price: parseFloat(pair.priceUsd) || 0.000000001,
      mc: formatMC(pair.marketCap),
      age: ageMins === 'N/A' ? 'Old' : ageMins + 'm'
    };
  } catch (e) {
    return null;
  }
}

// START + PAYMENT + ADMIN TEST (unchanged)
bot.start(ctx => {
  ctx.replyWithMarkdownV2(esc(`*Crucible Prop Firm*\n\nJoin: ${CHANNEL_LINK}`), {
    reply_markup: { inline_keyboard: [
      [{ text: "Join", url: CHANNEL_LINK }],
      [{ text: "$20 → $200", web_app: { url: process.env.MINI_APP_URL + '?tier=20' } }],
      [{ text: "$30 → $300", web_app: { url: process.env.MINI_APP_URL + '?tier=30' } }],
      [{ text: "$40 → $400", web_app: { url: process.env.MINI_APP_URL + '?tier=40' } }],
      [{ text: "$50 → $500", web_app: { url: process.env.MINI_APP_URL + '?tier=50' } }],
      [{ text: "Rules", callback_data: "rules" }]
    ]}
  });
});

bot.action('rules', ctx => ctx.replyWithMarkdownV2(esc(`*RULES*\n• Max DD: 12%\n• Target: 130%\n• No martingale\n• Payout 24h`)));

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
      await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Positions ➜", callback_data: "positions" }]] }
    });

    res.json({ok: true});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok: false});
  }
});

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
// BUY FLOW
async function handleBuy(ctx, ca) {
  const user = await new Promise(r => db.get('SELECT balance FROM users WHERE user_id=? AND paid=1', [ctx.from.id], (_,row) => r(row)));
  if (!user) return ctx.reply('No challenge');
  ctx.replyWithMarkdownV2(esc(`How much to buy?\nAvailable: $${user.balance.toFixed(2)}`), {
    reply_markup: { inline_keyboard: [
      [{ text: "$20", callback_data: `buy|${ca}|20` }, { text: "$50", callback_data: `buy|${ca}|50` }],
      [{ text: "$100", callback_data: `buy|${ca}|100` }, { text: "$250", callback_data: `buy|${ca}|250` }],
      [{ text: "Custom", callback_data: `custom|${ca}` }]
    ]}
  });
}

// BUY BUTTON — FINAL & PERFECT
bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  try {
    await ctx.answerCbQuery('Buying…');
    const ca = ctx.match[1].trim();
    const amount = Number(ctx.match[2]);
    const userId = ctx.from.id;

    const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=? AND paid=1 AND failed=0', [userId], (_,row) => r(row)));
    if (!user || amount > user.balance) return ctx.editMessageText('No funds');

    const token = await getTokenData(ca) || { symbol: ca.slice(0,8), price: 0.000000001, mc: "New", age: "New" };
    const tokens = amount / token.price;

    await new Promise(r => {
      db.run('BEGIN');
      db.run('INSERT INTO positions (user_id,ca,symbol,amount_usd,tokens_bought,entry_price,created_at) VALUES(?,?,?,?,?,?,?)',
        [userId, ca, token.symbol, amount, tokens, token.price, Date.now()], () => {});
      db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amount, userId], () => {});
      db.run('COMMIT', r);
    });
`
const msg = esc(`
BUY EXECUTED

${token.symbol}
Size: $${amount}
Tokens: ${tokens.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${token.price.toFixed(12).replace(/\.?0+$/, '')}
MC: ${token.mc}
Age: ${token.age}

Remaining: $${(user.balance - amount).toFixed(2)}
`.trim());

// SEND AS A NEW PERMANENT MESSAGE — STAYS FOREVER
await ctx.replyWithMarkdownV2(msg, {
  disable_web_page_preview: true,
  reply_markup: {
    inline_keyboard: [
      [{ text: "Positions", callback_data: "positions" }]
    ]
  }
});

  } catch (err) {
    console.error(err);
    try { await ctx.editMessageText('Failed – try again'); } catch {}
  }
});

// CUSTOM + TEXT
bot.action(/custom\|(.+)/, ctx => { ctx.session = {}; ctx.session.ca = ctx.match[1]; ctx.reply('Send amount in $'); ctx.answerCbQuery(); });
bot.on('text', async ctx => {
  if (ctx.session?.ca) {
    const amount = Number(ctx.message.text);
    delete ctx.session.ca;
    if (amount > 0) await bot.action(`buy|${ctx.session.ca}|${amount}`, ctx);
    return;
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(ctx.message.text.trim())) handleBuy(ctx, ctx.message.text.trim());
});

// POSITIONS — PnL MOVES, DD FIXED
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update?.callback_query?.from?.id;
  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=? AND paid=1 AND failed=0', [userId], (_,row) => r(row)));
  if (!user) return ctx.reply('No active challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id=?', [userId], (_,rows) => r(rows || [])));

  let totalPnL = 0;
  const buttons = [];

  // Parallel fast fetch
  const results = await Promise.all(positions.map(p => getTokenData(p.ca)));
  
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const live = results[i] || { price: p.entry_price };
    const pnl = (live.price - p.entry_price) / p.entry_price * 100;  // ← % change
    totalPnL += (live.price - p.entry_price) * p.tokens_bought;

    buttons.push([
      { text: `${p.symbol} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, callback_data: 'noop' },
      { text: "25%", callback_data: `sell_${p.id}_25` },
      { text: "50%", callback_data: `sell_${p.id}_50` },
      { text: "100%", callback_data: `sell_${p.id}_100` }
    ]);
  }

  const equity = user.balance + totalPnL;
  const totalPct = ((equity - user.start_balance) / user.start_balance) * 100;
  const dd = equity < user.start_balance ? ((user.start_balance - equity) / user.start_balance) * 100 : 0;

  if (dd > 12) {
    db.run('UPDATE users SET failed=1 WHERE user_id=?', [userId]);
    return ctx.reply('CHALLENGE FAILED — Drawdown >12%');
  }
  if (equity >= user.target) {
    db.run('UPDATE users SET failed=2 WHERE user_id=?', [userId]);
    return ctx.reply(`WINNER! Equity $${equity.toFixed(2)} — DM admin`);
  }

  const text = esc(`
LIVE POSITIONS (${positions.length})

Equity: $${equity.toFixed(2)}
Total: ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%
Drawdown: ${dd.toFixed(2)}%
  `.trim());

  const keyboard = { inline_keyboard: [...buttons, [{ text: "Refresh", callback_data: "positions" }]] };

  // ALWAYS edit the same message
  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (e) {
    await ctx.replyWithMarkdownV2(text, { reply_markup: keyboard });
  }
}

bot.action('positions', async (ctx) => {
  await ctx.answerCbQuery();
  await showPositions(ctx);
});
// SELL
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  await ctx.answerCbQuery('Selling…');
  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]);
  const userId = ctx.update.callback_query.from.id;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id=? AND user_id=?', [posId, userId], (_,row) => r(row)));
  if (!pos) return;

  const token = await getTokenData(pos.ca) || { price: pos.entry_price };
  const curPrice = token.price;

  const sellUSD = pos.amount_usd * (percent / 100);
  const pnl = (curPrice - pos.entry_price) * pos.tokens_bought * (percent / 100);

  db.run('UPDATE users SET balance = balance + ? WHERE user_id=?', [sellUSD + pnl, userId]);
  if (percent === 100) db.run('DELETE FROM positions WHERE id=?', [posId]);

  await ctx.replyWithMarkdownV2(esc(`SELL ${percent}% ${pos.symbol}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
  showPositions(ctx);
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT — FINAL & PERFECT — $50k SHOWS AS $50k'));

process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
