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

// ==================== CONFIG ====================
const CHANNEL_LINK = "https://t.me/+yourprivatechannel"; // ← CHANGE THIS
const RULES = `
*CRUCIBLE PROP FIRM – OFFICIAL RULES*

• Max drawdown: 12% from starting balance
• Profit target: 130% (e.g. $500 → $1,150)
• No martingale, no revenge trading
• No hedging across multiple accounts
• Max 1 challenge per person
• You may hold positions overnight
• You may trade any Solana token (Pump.fun, Raydium, etc.)
• Inactivity >7 days = auto-fail
• Payout within 24h after passing

Violation = instant disqualification. No refund.
`.trim();

const TIERS = {
  20: { balance: 200,  target: 460,  bounty: 140 },
  30: { balance: 300,  target: 690,  bounty: 210 },
  40: { balance: 400,  target: 920,  bounty: 280 },
  50: { balance: 500,  target: 1150, bounty: 350 }
};

// ==================== DATABASE ====================
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

// ==================== WELCOME + RULES + CHANNEL ====================
bot.start(async (ctx) => {
  const name = ctx.from.first_name;
  await ctx.replyWithPhoto(
    { url: 'https://i.imgur.com/YourLogoHere.png' }, // ← put your logo
    {
      caption: `
Welcome to *Crucible Prop Firm*, ${name}!

The most trusted funded challenge on Solana.

Join our private trading channel for signals & updates (required):
${CHANNEL_LINK}

Then choose your challenge below
      `.trim(),
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "Join Channel First", url: CHANNEL_LINK }],
          [{ text: "$20 → $200 in SOL", web_app: { url: process.env.MINI_APP_URL + '?tier=20' } }],
          [{ text: "$30 → $300 in SOL", web_app: { url: process.env.MINI_APP_URL + '?tier=30' } }],
          [{ text: "$40 → $400 in SOL", web_app: { url: process.env.MINI_APP_URL + '?tier=40' } }],
          [{ text: "$50 → $500 in SOL", web_app: { url: process.env.MINI_APP_URL + '?tier=50' } }],
          [{ text: "Read Rules", callback_data: "rules" }]
        ]
      }
    }
  );
});

bot.action('rules', (ctx) => {
  ctx.replyWithMarkdownV2(RULES.replace(/[-•]/g, '\\$&'));
});

// ==================== PAYMENT RECEIVED → START CHALLENGE ====================
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok:false});

    await new Promise(r => db.run(
      `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
      [userId, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
    ));

    await bot.telegram.sendMessage(ADMIN_ID, `NEW CHALLENGE STARTED\nPaid: $${payAmount}\nCapital: $${tier.balance}\nUser: ${userId}`);

    await bot.telegram.sendMessage(userId, `
CHALLENGE LIVE!

Capital: *$${tier.balance} in virtual SOL*
Target: *$${tier.target}*
Payout: *$${tier.bounty}* if you pass
Max drawdown: 12%

Paste any Pump.fun or Raydium token address to buy instantly

Example:
Ekp8DAiKmVZ...pump

Or use:
/buy <CA> <amount in $>
    `.trim(), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "My Live Positions", callback_data: "positions" }],
          [{ text: "Rules", callback_data: "rules" }]
        ]
      }
    });

    res.json({ok:true});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok:false});
  }
});

// ==================== ADMIN TEST COMMAND (any tier) ====================
bot.command('admin_test', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const arg = ctx.message.text.split(' ')[1];
  const pay = Number(arg) || 50;
  const tier = TIERS[pay] || TIERS[50];

  const userId = ctx.from.id;

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
     VALUES (?, 1, ?, ?, ?, ?, 0)`,
    [userId, tier.balance, tier.balance, tier.target, tier.bounty], () => r()
  ));

  ctx.replyWithMarkdownV2(`
ADMIN TEST ACCOUNT CREATED

Capital: *$${tier.balance}*
Target: *$${tier.target}*

Start pasting CAs to trade!
  `, {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
  });
});

// ==================== BUY / SELL / POSITIONS (same as previous message) ====================
async function handleBuy(ctx, ca, amountUSD = null) {
  const userId = ctx.from?.id || ctx.update.callback_query?.from.id;
  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id=? AND paid=1 AND failed=0', [userId], (_,row)=>r(row)));
  if (!user) return ctx.reply('No active challenge');

  if (!amountUSD) {
    return ctx.reply(`How much $ to buy?\nAvailable: $${user.balance}`, { reply_markup: { force_reply: true } });
  }
  if (amountUSD > user.balance || amountUSD <= 0) return ctx.reply('Invalid amount');

  let symbol = ca.slice(0,10);
  let price = 0;
  try {
    const r = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
      headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' },
      timeout: 8000
    });
    price = r.data.data?.value || 0;
    symbol = r.data.data?.symbol || ca.slice(0,8);
    if (price === 0) throw '';
  } catch {
    return ctx.reply('Token not found — wait 30–60s after launch');
  }

  const tokens = amountUSD / price;

  db.run(`INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, ca, symbol, amountUSD, tokens, price, Date.now()]);

  db.run('UPDATE users SET balance = balance - ? WHERE user_id=?', [amountUSD, userId]);

  ctx.replyWithMarkdownV2(`
BUY FILLED

*${symbol}* × ${tokens.toFixed(2)}
Entry: $${price.toExponential(4)}
Invested: $${amountUSD}
Remaining: $${(user.balance - amountUSD).toFixed(2)}
  `.trim(), {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "positions" }]] }
  });
}

async function handleSell(ctx, posId, percent) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id=? AND user_id=?', [posId, userId], (_,row)=>r(row)));
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

  db.run('UPDATE users SET balance = balance + ? WHERE user_id=?', [sellUSD + pnl, userId]);

  if (percent === 100) {
    db.run('DELETE FROM positions WHERE id=?', [posId]);
  } else {
    db.run(`UPDATE positions SET amount_usd = amount_usd * ?, tokens_bought = tokens_bought * ? WHERE id=?`,
      [(100-percent)/100, (100-percent)/100, posId]);
  }

  ctx.replyWithMarkdownV2(`SELL ${percent}%\n${pos.symbol}\nPnL: ${pnl>=0?'+' : ''}$${pnl.toFixed(2)}`);
  showPositions(ctx);
}

// Auto-detect CA paste
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(text)) {
    await handleBuy(ctx, text, null);
  }
});

bot.command('buy', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /buy <CA> <amount>');
  await handleBuy(ctx, parts[1], Number(parts[2]));
});

bot.command('positions', ctx => showPositions(ctx));
bot.action('positions', ctx => showPositions(ctx));

async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const user = await new Promise(r => db.get('SELECT balance, start_balance, target FROM users WHERE user_id=? AND paid=1', [userId], (_,row)=>r(row)));
  if (!user) return ctx.reply('No challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id=?', [userId], (_,rows)=>r(rows)));
  if (positions.length === 0) return ctx.reply('No positions', { reply_markup: { inline_keyboard: [[{ text: "Refresh", callback_data: "positions" }]] } });

  let totalPnL = 0;
  const rows = [];

  for (const p of positions) {
    let price = p.entry_price;
    try {
      const r = await axios.get(`https://public-api.birdeye.so/defi/price?address=${p.ca}`, { headers: { 'x-api-key': process.env.BIRDEYE_KEY || '' } });
      price = r.data.data?.value || p.entry_price;
    } catch {}

    const pnl = (price - p.entry_price) * p.tokens_bought;
    totalPnL += pnl;

    rows.push([
      { text: `${p.symbol} ${pnl>=0?'Up':'Down'}$${Math.abs(pnl).toFixed(1)}`, callback_data: 'noop' },
      { text: "25%", callback_data: `sell_${p.id}_25` },
      { text: "50%", callback_data: `sell_${p.id}_50` },
      { text: "100%", callback_data: `sell_${p.id}_100` }
    ]);
  }

  const equity = user.balance + totalPnL;
  const dd = ((user.start_balance - equity) / user.start_balance) * 100;

  if (dd > 12) {
    db.run('UPDATE users SET failed=1 WHERE user_id=?', [userId]);
    return ctx.reply('CHALLENGE FAILED — DD >12%');
  }
  if (equity >= user.target) {
    db.run('UPDATE users SET failed=2 WHERE user_id=?', [userId]);
    return ctx.reply(`WINNER! Equity $${equity.toFixed(2)} — DM admin`);
  }

  ctx.replyWithMarkdownV2(`
*LIVE POSITIONS*

Equity: *$${equity.toFixed(2)}*
Unrealized: *$${totalPnL.toFixed(2)}*
Drawdown: *${dd.toFixed(2)}%*
  `.trim(), {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: "Refresh", callback_data: "positions" }]
      ]
    }
  });
}

bot.action(/sell_(\d+)_(\d+)/, async (ctx) => {
  await handleSell(ctx, ctx.match[1], Number(ctx.match[2]));
  ctx.answerCbQuery('Sell executed');
});

bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE PROP FIRM BOT – FULLY STACKED – LIVE 2025'));
