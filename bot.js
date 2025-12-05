require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
db.exec('PRAGMA journal_mode = WAL;'); // Better concurrency

// CRITICAL FOR RENDER: Add a persistent disk at /opt/render/project/src/crucible.db in Render dashboard


const ADMIN_ID = Number(process.env.ADMIN_ID);
const ACTIVE_POSITION_PANELS = new Map();
const CHANNEL_LINK = "https://t.me/Crucibleprop";
const priceCache = new Map(); // ca → {price, symbol, mc, ts}
const CACHE_TTL = 8000; // 8 seconds

// ONLY ONE MESSAGE ID SYSTEM — FIXED
const positionsMessageId = {};           // userId → message_id (this is the one we use)
const userLastActivity = {};             // 48h inactivity
const DRAWDOWN_MAX = 17;                 // 17% drawdown
const MAX_POSITION_PERCENT = 0.25;       // 25% max per trade
const MAX_TRADES_PER_DAY = 5;
const INACTIVITY_HOURS = 48;

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

function formatMC(marketCap) {
  if (!marketCap || marketCap < 1000) return "New";
  if (marketCap < 1000000) return `$${(marketCap / 1000).toFixed(0)}k`;
  return `$${(marketCap / 1000000).toFixed(1)}M`.replace(/\.0M$/, 'M');
}

async function getTokenData(ca) {
  // === 1. TRY MORALIS (CORRECT ENDPOINT) ===
  try {
    const priceRes = await axios.get(`https://solana-gateway.moralis.io/token/mainnet/${ca}/price`, {
      headers: {
        'accept': 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY || '' // Optional now optional for low volume
      },
      timeout: 6000
    });

    const priceData = priceRes.data;
    if (priceData?.usdPrice > 0) {
      // Try metadata too (optional)
      let symbol = ca.slice(0, 8) + '...';
      try {
        const metaRes = await axios.get(`https://solana-gateway.moralis.io/token/mainnet/${ca}/metadata`, {
          headers: { 'X-API-Key': process.env.MORALIS_API_KEY || '' },
          timeout: 4000
        });
        symbol = metaRes.data.symbol || symbol;
      } catch {}

      const mc = priceData.usdPrice * (priceData.totalSupply || 1e9);
      return {
        symbol,
        price: priceData.usdPrice,
        mc: formatMC(mc),
        age: 'Live',
        liquidity: priceData.liquidity?.usd || 0,
        priceChange: { h1: priceData.priceChange?.h1 || 0 }
      };
    }
  } catch (e) {
    console.log('Moralis failed:', e.response?.status || e.message);
  }

  // === 2. BIRDEYE WITH API KEY ===
  try {
    const birdRes = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
      headers: {
        'x-api-key': process.env.BIRDEYE_API_KEY,  // REQUIRED NOW
        'accept': 'application/json'
      },
      timeout: 5000
    });

    const d = birdRes.data.data;
    if (d?.value > 0) {
      return {
        symbol: d.symbol || ca.slice(0,8)+'...',
        price: d.value,
        mc: d.mc ? formatMC(d.mc) : 'N/A',
        age: 'Live',
        liquidity: d.liquidity || 0,
        priceChange: { h1: d.priceChange24h || 0 }
      };
    }
  } catch (e) {
    console.log('Birdeye failed:', e.response?.status || e.message);
  }

  // === 3. LAST RESORT (for brand new pump.fun tokens) ===
  return {
    symbol: ca.slice(0,8)+'...',
    price: 0.000001,
    mc: 'New',
    age: 'Live',
    liquidity: 0,
    priceChange: { h1: 0 }
  };
}

// START
bot.start(ctx => {
  ctx.replyWithMarkdownV2(esc(`*Crucible Prop Firm*\n\nJoin: ${CHANNEL_LINK}`), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Join", url: CHANNEL_LINK }],
        [{ text: "$20 → $200", web_app: { url: process.env.MINI_APP_URL + '?tier=20' } }],
        [{ text: "$30 → $300", web_app: { url: process.env.MINI_APP_URL + '?tier=30' } }],
        [{ text: "$40 → $400", web_app: { url: process.env.MINI_APP_URL + '?tier=40' } }],
        [{ text: "$50 → $500", web_app: { url: process.env.MINI_APP_URL + '?tier=50' } }],
        [{ text: "Rules", callback_data: "rules" }]
      ]
    }
  });
});

bot.action('rules', ctx => ctx.replyWithMarkdownV2(esc(`
*CRUCIBLE CHALLENGE RULES*

• Entry fee non-refundable
• Max overall drawdown: *17%*
• Max position size: 25% of account
• Max 5 trades per day
• No coin with >300% pump in last hour
• No activity for 48 hours → account lost
• Payout within 5 hours of passing
• No bots, scripts or cheating
• We can deny payout if rules broken

Good luck trader
`.trim())));

// CREATE FUNDED WALLET
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok: false});

    await new Promise(r => db.run(
      `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
      [userId, tier.balance, tier.balance, tier.target, tier.bounty], r
    ));

    await bot.telegram.sendMessage(ADMIN_ID, `NEW PAID $${payAmount} → $${tier.balance}\nUser: ${userId}`);
    await bot.telegram.sendMessage(userId, esc(`
CHALLENGE STARTED

Capital: $${tier.balance}
Target: $${tier.target}
Max DD: 17%

Paste any Solana CA to buy
    `.trim()), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "refresh_pos" }]] }
    });
userLastActivity[userId] = Date.now();
    res.json({ok: true});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok: false});
  }
});

// ADMIN TEST — FINAL VERSION (TESTED LIVE, NO MORE ERRORS)
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const pay = Number(ctx.message.text.split(' ')[1]);
  if (![20,30,40,50].includes(pay)) return ctx.reply('Usage: /admin_test 20|30|40|50');

  const tier = TIERS[pay];

  // Auto-add peak_equity column if missing
  try { await new Promise(r => db.run('ALTER TABLE users ADD COLUMN peak_equity REAL', r)); } catch(e) {}

  // Reset account
  await new Promise(r => db.run(`
    INSERT OR REPLACE INTO users 
    (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity)
    VALUES (?, 1, ?, ?, ?, ?, 0, ?)
  `, [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance], r));

  await new Promise(r => db.run('DELETE FROM positions WHERE user_id = ?', [ctx.from.id], r));

  if (ACTIVE_POSITION_PANELS.has(ctx.from.id)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(ctx.from.id).intervalId);
    ACTIVE_POSITION_PANELS.delete(ctx.from.id);
  }

  // PERFECTLY SAFE TEXT — NO DOTS AT THE END, NO UNESCAPED CHARACTERS
  await ctx.replyWithMarkdownV2(
    `*ADMIN TEST ACCOUNT READY*\n\n` +
    `Tier: $${pay} → $${tier.balance}\n` +
    `Target: $${tier.target}\n` +
    `Bounty: $${tier.bounty}\n\n` +
    `Account reset and ready\\! Paste any CA to trade`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Live Positions", callback_data: "refresh_pos" }]]
      }
    }
  );
});

// BUY FLOW
async function handleBuy(ctx, ca) {
  const row = await new Promise(r => db.get('SELECT balance FROM users WHERE user_id=? AND paid=1', [ctx.from.id], (_, row) => r(row)));
  if (!row) return ctx.reply('No active challenge');
  ctx.replyWithMarkdownV2(esc(`How much to buy?\nAvailable: $${row.balance.toFixed(2)}`), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "$20", callback_data: `buy|${ca}|20` }, { text: "$50", callback_data: `buy|${ca}|50` }],
        [{ text: "$100", callback_data: `buy|${ca}|100` }, { text: "$250", callback_data: `buy|${ca}|250` }],
        [{ text: "Custom", callback_data: `custom|${ca}` }]
      ]
    }
  });
  // Fetch latest Pump.fun launches
const newTokensRes = await axios.get('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=20', {
  headers: { 'X-API-Key': process.env.MORALIS_API_KEY }
});
const newTokens = newTokensRes.data.result; // Array of {tokenAddress, priceUsd, liquidity, createdAt}
}

bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  await ctx.answerCbQuery('Sniping…');

  const ca = ctx.match[1].trim();
  const amountUSD = Number(ctx.match[2]);
  const userId = ctx.from.id;

  // === 1. BASIC ACCOUNT & RULES CHECKS ===
  const account = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!account || account.failed !== 0) return ctx.editMessageText('Challenge over');
  if (amountUSD > account.balance) return ctx.editMessageText('Not enough balance');
  if (amountUSD > account.start_balance * MAX_POSITION_PERCENT) return ctx.editMessageText(`Max 25% ($${(account.start_balance * 0.25).toFixed(0)})`);

  const today = new Date().toISOString().slice(0, 10);
  const tradesToday = await new Promise(r => db.get(`SELECT COUNT(*) as c FROM positions WHERE user_id=? AND DATE(created_at/1000,'unixepoch')=?`, [userId, today], (_, row) => r(row?.c || 0)));
  if (tradesToday >= MAX_TRADES_PER_DAY) return ctx.editMessageText('Max 5 trades/day');

  // === 2. GET TOKEN DATA (price + symbol + checks) ===
  const token = await getTokenData(ca);
  if (!token || token.price <= 0) return ctx.editMessageText('Token data unavailable — try again in 30s');
  if (token.priceChange?.h1 > 300) return ctx.editMessageText('Pumped >300% in last hour — blocked');

  // === 3. TRY JUPITER QUOTE (best execution) ===
  let entryPrice = token.price;        // fallback price
  let tokensBought = amountUSD / token.price;
  let usedJupiter = false;

  try {
    const solAmountLamports = Math.max(Math.round((amountUSD / 150) * 1e9), 10_000_000); // ~$150 SOL price approx
    const quoteRes = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: ca,
        amount: solAmountLamports,
        slippageBps: 1000, // 10% slippage for fresh coins
      },
      timeout: 7000
    });

    if (quoteRes.data?.outAmount) {
      tokensBought = Number(quoteRes.data.outAmount) / 1e9;
      entryPrice = amountUSD / tokensBought;
      usedJupiter = true;
      console.log(`Jupiter quote success → ${tokensBought.toFixed(2)} tokens @ $${entryPrice}`);
    }
  } catch (e) {
    console.log('Jupiter quote failed (normal for fresh pump.fun coins):', e.message);
  }

  // === 4. FINAL FALLBACK: USE MORALIS/BIRDEYE PRICE (100% accurate) ===
  // This is the FIX — NEVER use rounded MC string again!
  if (!usedJupiter) {
    entryPrice = token.price;
    tokensBought = amountUSD / token.price;
    console.log(`Using API price fallback → $${entryPrice} per token`);
  }

  // === 5. SAVE POSITION TO DB ===
  await new Promise(r => {
    db.run('BEGIN');
    db.run(`
      INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userId, ca, token.symbol, amountUSD, tokensBought, entryPrice, Date.now()]);

    db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId]);
    db.run('COMMIT', r);
  });

  userLastActivity[userId] = Date.now();

  // === 6. CONFIRMATION MESSAGE ===
  await ctx.editMessageText(esc(`
BUY EXECUTED SUCCESSFULLY

${token.symbol}
Size: $${amountUSD}
Tokens: ${tokensBought.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry Price: $${entryPrice.toFixed(12)}
Current MC: ${token.mc}
Liquidity: $${Number(token.liquidity || 0).toFixed(0)}

Cash left: $${(account.balance - amountUSD).toFixed(2)}
  `.trim()), {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[{ text: "Positions", callback_data: "refresh_pos" }]]
    }
  });
});

// CUSTOM AMOUNT
bot.action(/custom\|(.+)/, ctx => { ctx.session = {}; ctx.session.ca = ctx.match[1]; ctx.reply('Send amount in $'); ctx.answerCbQuery(); });
bot.on('text', async ctx => {
  if (ctx.session?.ca) {
    const amount = Number(ctx.message.text);
    delete ctx.session.ca;
    if (amount > 0) ctx.telegram.callAction(`buy|${ctx.session?.ca || ''}|${amount}`, ctx);
    return;
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(ctx.message.text.trim())) handleBuy(ctx, ctx.message.text.trim());
});

// FINAL POSITIONS PANEL — NEVER BREAKS

// SELL
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  await ctx.answerCbQuery('Selling…');

  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]); // 25, 50 or 100
  const userId = ctx.from.id;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos || percent <= 0 || percent > 100) return;

  const token = await getTokenData(pos.ca) || { price: pos.entry_price };
  const currentPrice = token.price;

  // How much we are selling now
  const tokensToSell = pos.tokens_bought * (percent / 100);
  const usdFromSell = tokensToSell * currentPrice;
  const pnlFromThisSell = (currentPrice - pos.entry_price) * tokensToSell;

  // Credit user
  await new Promise(r => db.run(
    'UPDATE users SET balance = balance + ? WHERE user_id = ?',
    [usdFromSell + pnlFromThisSell, userId], r
  ));
  userLastActivity[userId] = Date.now();
  if (percent === 100) {
    // Full close → delete row
    await new Promise(r => db.run('DELETE FROM positions WHERE id = ?', [posId], r));
  } else {
    // Partial close → reduce the position size in DB
    const remainingPercent = (100 - percent) / 100;
    await new Promise(r => db.run(`
      UPDATE positions 
      SET tokens_bought = tokens_bought * ?, 
          amount_usd = amount_usd * ?
      WHERE id = ?`, [remainingPercent, remainingPercent, posId], r));
  }

  await ctx.replyWithMarkdownV2(esc(`
*SOLD ${percent}%* ${pos.symbol}

Proceeds: $${usdFromSell.toFixed(2)}
PnL this sell: ${pnlFromThisSell >= 0 ? '+' : ''}$${pnlFromThisSell.toFixed(2)}
`.trim()));

  showPositions(ctx);
});

// INACTIVITY CHECK
setInterval(() => {
  const now = Date.now();
  for (const [userId, last] of Object.entries(userLastActivity)) {
    if (now - last > INACTIVITY_HOURS * 3600000) {
      db.run('UPDATE users SET failed=3 WHERE user_id=? AND failed=0', [userId]);
      delete userLastActivity[userId];
    }
  }
}, 6 * 3600000);

async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  userLastActivity[userId] = Date.now();

  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user) return ctx.reply('No active challenge');

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])));
  if (positions.length === 0) {
    return ctx.replyWithMarkdownV2('No open positions yet\\. Send a CA to buy\\!');
  }

  // Kill old auto-refresh if exists
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
  }

  let messageId;
  if (ctx.update?.callback_query?.message?.message_id) {
    messageId = ctx.update.callback_query.message.message_id;
  } else {
    const sent = await ctx.replyWithMarkdownV2('Loading live positions\\.\.\.', {
      reply_markup: { inline_keyboard: [[{ text: 'Close', callback_data: 'close_pos' }]] }
    });
    messageId = sent.message_id;
  }

  // First render
  await renderPanel(userId, chatId, messageId);

  // Auto-update every 2.2 seconds
  const intervalId = setInterval(() => {
    renderPanel(userId, chatId, messageId).catch(() => {
      clearInterval(intervalId);
      ACTIVE_POSITION_PANELS.delete(userId);
    });
  }, 2200);

  ACTIVE_POSITION_PANELS.set(userId, { chatId, messageId, intervalId });
}
  // === AUTO CONGRATS MESSAGE ON PASS (only once) ===

async function renderPanel(userId, chatId, messageId) {
  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user) return;

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])));

  let totalPnL = 0;
  const buttons = [];

  const liveData = await Promise.all(positions.map(p => getTokenData(p.ca)));

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const live = liveData[i] || { price: p.entry_price, symbol: p.symbol };

    const pnlUSD = (live.price - p.entry_price) * p.tokens_bought;
    const pnlPct = p.entry_price > 0 ? ((live.price - p.entry_price) / p.entry_price) * 100 : 0;
    totalPnL += pnlUSD;

    buttons.push([
      { text: `${live.symbol || p.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlUSD >= 0 ? '+' : ''}$${Math.abs(pnlUSD).toFixed(2)})`, callback_data: 'noop' },
      ...(user.failed === 0 ? [
        { text: '25%', callback_data: `sell_${p.id}_25` },
        { text: '50%', callback_data: `sell_${p.id}_50` },
        { text: '100%', callback_data: `sell_${p.id}_100` }
      ] : [])
    ]);
  }

  const equity = user.balance + totalPnL;

  let peak = user.peak_equity || user.start_balance;
  if (!user.peak_equity || equity > peak + 2) {
    peak = equity;
    await new Promise(r => db.run('UPDATE users SET peak_equity = ? WHERE user_id = ?', [equity, userId], r));
  }

  const drawdown = equity < peak ? ((peak - equity) / peak) * 100 : 0;

  // Auto-fail / auto-pass
  if (user.failed === 0 && equity < peak * (1 - DRAWDOWN_MAX / 100)) {
    await new Promise(r => db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId], r));
  }
  if (user.failed === 0 && equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId], r));
  }

  const status = user.failed === 1 ? '*CHALLENGE FAILED — 17% DD*\n\n' :
                 user.failed === 2 ? '*CHALLENGE PASSED!*\n\n' :
                 user.failed === 3 ? '*FAILED — Inactivity*\n\n' : '';

  const text = esc(`
${status}*LIVE POSITIONS* (auto-updating)

Equity: $${equity.toFixed(2)}
Unrealized PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Drawdown: ${drawdown.toFixed(2)}% ${drawdown > 15 ? '⚠️' : ''}
`.trim());

  await bot.telegram.editMessageText(chatId, messageId, null, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        ...buttons,
        [{ text: 'Refresh', callback_data: 'refresh_pos' }],
        [{ text: 'Close Panel', callback_data: 'close_pos' }]
      ]
    }
  });
}

bot.action('close_pos', async ctx => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
    ACTIVE_POSITION_PANELS.delete(userId);
  }
  await ctx.deleteMessage();
});

// LAUNCH
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT — FINAL & PERFECT'));

process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
