require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session()); // Required for ctx.session

const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
db.exec('PRAGMA journal_mode = WAL;');

const ADMIN_ID = Number(process.env.ADMIN_ID);
const ACTIVE_POSITION_PANELS = new Map();
const userLastActivity = new Map(); // Use Map for better performance

// Updated rules as per request
const MAX_DRAWDOWN_PERCENT = 35;        // 35%
const MAX_POSITION_PERCENT = 0.30;      // 30% per trade
const MAX_TRADES_PER_DAY = 10;          // 10 per day
const INACTIVITY_HOURS = 48;
const CASH_BUFFER_PERCENT = 0.05;       // 5% cash buffer
const PUMP_MAX_1H_PERCENT = 300;        // No >300% pump in 1h

// Use consistent tiers (paid accounts)
const TIERS = {
  20: { balance: 200, target: 500, bounty: 220 },
  30: { balance: 300, target: 750, bounty: 330 },
  40: { balance: 400, target: 1000, bounty: 440 },
  50: { balance: 500, target: 1250, bounty: 550 }
};

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    paid INTEGER DEFAULT 0,
    balance REAL,
    start_balance REAL,
    target REAL,
    bounty REAL,
    failed INTEGER DEFAULT 0,
    peak_equity REAL,
    entry_fee REAL,
    created_at INTEGER
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
  db.run(`CREATE TABLE IF NOT EXISTS influencers (
    influencer_id INTEGER PRIMARY KEY,
    referral_code TEXT UNIQUE,
    total_earnings REAL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    influencer_id INTEGER,
    user_id INTEGER,
    pay_amount REAL,
    date INTEGER
  )`);
});

// Safe ALTER (ignore errors)
db.run(`ALTER TABLE users ADD COLUMN peak_equity REAL`, () => {});
db.run(`ALTER TABLE users ADD COLUMN entry_fee REAL`, () => {});
db.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`, () => {});

const esc = str => String(str).replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

function formatMC(marketCap) {
  if (!marketCap || marketCap < 1000) return "New";
  if (marketCap < 1000000) return `$${(marketCap / 1000).toFixed(0)}k`;
  return `$${(marketCap / 1000000).toFixed(1)}M`.replace(/\.0M$/, 'M');
}

async function getTokenData(ca) {
  // Birdeye primary - using correct uppercase header and x-chain
  try {
    const res = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
      headers: {
        'X-API-KEY': process.env.BIRDEYE_API_KEY,  // Uppercase as per official docs
        'x-chain': 'solana',                       // Required for multi-chain support
        'accept': 'application/json'
      },
      timeout: 8000
    });

    if (res.data?.success && res.data.data?.value > 0) {
      const d = res.data.data;
      return {
        symbol: d.symbol || ca.slice(0, 8) + '...',
        price: d.value,
        mc: d.mc ? formatMC(d.mc) : 'N/A',
        liquidity: d.liquidity || 0,
        priceChange1h: d.priceChange?.h1 || 0
      };
    }
  } catch (e) {
    console.error('Birdeye failed:', e.response?.status, e.response?.data || e.message);
  }

  // DexScreener backup - reliable and free
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 8000 });
    const pair = res.data.pairs?.find(p => p.dexId === 'raydium' && p.quoteToken?.symbol === 'SOL') 
                 || res.data.pairs?.find(p => p.quoteToken?.symbol === 'SOL')
                 || res.data.pairs?.[0];

    if (pair && pair.priceUsd > 0) {
      return {
        symbol: pair.baseToken.symbol || ca.slice(0, 8) + '...',
        price: parseFloat(pair.priceUsd),
        mc: pair.fdv ? formatMC(parseFloat(pair.fdv)) : 'N/A',
        liquidity: parseFloat(pair.liquidity?.usd || 0),
        priceChange1h: parseFloat(pair.priceChange?.h1 || 0)
      };
    }
  } catch (e) {
    console.log('DexScreener failed:', e.message);
  }

  // Final safety fallback
  return {
    symbol: ca.slice(0, 8) + '...',
    price: 0,
    mc: 'Error',
    liquidity: 0,
    priceChange1h: 0
  };
}

app.get('/health', (req, res) => res.status(200).send('OK'));

// Influencer system
bot.command('generate_code', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Admin only');
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  await new Promise(r => db.run('INSERT OR REPLACE INTO influencers (influencer_id, referral_code) VALUES (?, ?)', [ctx.from.id, code], r));
  ctx.replyWithMarkdownV2(esc(`Code: \`${code}\`\nLink: t.me/${ctx.botInfo.username}?start=${code}`));
});

bot.command('influencer', async ctx => {
  const info = await new Promise(r => db.get('SELECT referral_code, total_earnings FROM influencers WHERE influencer_id = ?', [ctx.from.id], (_, row) => r(row)));
  if (!info) return ctx.reply('Not an influencer');

  const totalReferred = await new Promise(r => db.get('SELECT COUNT(*) as c FROM referrals WHERE influencer_id = ?', [ctx.from.id], (_, row) => r(row?.c || 0)));
  const recent = await new Promise(r => db.all(`SELECT DATE(datetime(date/1000,'unixepoch')) as d, COUNT(*) as cnt, SUM(pay_amount)*0.2 as earned
    FROM referrals WHERE influencer_id = ? GROUP BY d ORDER BY d DESC LIMIT 7`, [ctx.from.id], (_, rows) => r(rows || [])));

  let msg = `*INFLUENCER DASHBOARD*\n\nCode: \`${info.referral_code}\`\nEarnings: $${info.total_earnings.toFixed(2)}\nReferred: ${totalReferred}\n\nLink: t.me/${ctx.botInfo.username}?start=${info.referral_code}`;
  if (recent.length) {
    msg += `\n\n*Last 7 Days*\n`;
    recent.forEach(r => msg += `${r.d}: $${r.earned.toFixed(2)} (${r.cnt} users)\n`);
  }
  ctx.replyWithMarkdownV2(esc(msg));
});

// /start - fixed (only one handler)
bot.start(async ctx => {
  const payload = ctx.startPayload || '';

  await ctx.replyWithMarkdownV2(
    "*CRUCIBLE — SOLANA PROP FIRM*\n\n" +
    "Purchase an account and start high leveraging\n" +
    "Ready to test your discipline?\n\n" +
    "No KYC • No bullshit • No second chances\n\n" +
    "Live sniping channel: @Crucibleprop",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Join Winners Only", url: "https://t.me/Crucibleprop" }],
          [{ text: "SURVIVE OR DIE", web_app: { url: process.env.MINI_APP_URL } }]
        ]
      }
    }
  );

  if (payload === 'free200') {
    const userId = ctx.from.id;
    const tier = TIERS[20]; // Use same as $20 paid tier

    await new Promise(r => db.run(`
      INSERT OR REPLACE INTO users 
      (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
      VALUES (?, 1, ?, ?, ?, ?, 0, ?, 0, ?)
    `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, Date.now()], r));

    await new Promise(r => db.run('DELETE FROM positions WHERE user_id = ?', [userId], r));

    return ctx.replyWithMarkdownV2(
      "*FREE $200 ACCOUNT ACTIVATED*\n\n" +
      `Capital: $${tier.balance}\n` +
      `Target: $${tier.target}\n` +
      `Max DD: ${MAX_DRAWDOWN_PERCENT}%\n\n` +
      "Start trading now\\.",
      { reply_markup: { inline_keyboard: [[{ text: "Open Live Positions", callback_data: "refresh_pos" }]] } }
    );
  }
});

bot.action('rules', ctx => ctx.replyWithMarkdownV2(esc(`
*CRUCIBLE RULES*

• Max drawdown: *${MAX_DRAWDOWN_PERCENT}%* trailing
• Max position: *${MAX_POSITION_PERCENT * 100}%* of account
• Max ${MAX_TRADES_PER_DAY} trades per day
• No coin with >${PUMP_MAX_1H_PERCENT}% pump in last hour
• Inactivity 48h → account lost
• Payout within 5 hours of passing
`.trim())));

// Paid account creation webhook
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount, referralCode } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok: false});

    let commissionPaid = false;
    if (referralCode) {
      const influencer = await new Promise(r => db.get('SELECT influencer_id FROM influencers WHERE referral_code = ?', [referralCode], (_, row) => r(row)));
      if (influencer) {
        const already = await new Promise(r => db.get('SELECT 1 FROM referrals WHERE influencer_id = ? AND user_id = ?', [influencer.influencer_id, userId], (_, row) => r(row)));
        if (!already) {
          const commission = payAmount * 0.20;
          await new Promise(r => db.run('UPDATE influencers SET total_earnings = total_earnings + ? WHERE influencer_id = ?', [commission, influencer.influencer_id], r));
          await new Promise(r => db.run('INSERT INTO referrals (influencer_id, user_id, pay_amount, date) VALUES (?, ?, ?, ?)', [influencer.influencer_id, userId, payAmount, Date.now()], r));
          commissionPaid = true;
        }
      }
    }

    await new Promise(r => db.run(`
      INSERT OR REPLACE INTO users 
      (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
      VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?)
    `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, payAmount, Date.now()], r));

    await bot.telegram.sendMessage(ADMIN_ID, `NEW PAID $${payAmount} → $${tier.balance} | User: ${userId}`);
    await bot.telegram.sendMessage(userId, esc(`
CHALLENGE STARTED

Capital: $${tier.balance}
Target: $${tier.target}
Max DD: ${MAX_DRAWDOWN_PERCENT}%

Paste any Solana CA to buy
    `.trim()), {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "refresh_pos" }]] }
    });

    userLastActivity.set(userId, Date.now());
    res.json({ok: true, commission: commissionPaid});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok: false});
  }
});

// Admin commands
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]);
  if (![20,30,40,50].includes(pay)) return ctx.reply('Usage: /admin_test 20|30|40|50');
  const tier = TIERS[pay];

  await new Promise(r => db.run(`
    INSERT OR REPLACE INTO users 
    (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
    VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?)
  `, [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, pay, Date.now()], r));

  await new Promise(r => db.run('DELETE FROM positions WHERE user_id = ?', [ctx.from.id], r));
  if (ACTIVE_POSITION_PANELS.has(ctx.from.id)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(ctx.from.id).intervalId);
    ACTIVE_POSITION_PANELS.delete(ctx.from.id);
  }

  await ctx.replyWithMarkdownV2(`*TEST ACCOUNT READY*\nTier: $${pay} → $${tier.balance}\nTarget: $${tier.target}\nBounty: $${tier.bounty}`, {
    reply_markup: { inline_keyboard: [[{ text: "Open Positions", callback_data: "refresh_pos" }]] }
  });
});

bot.command('adminstats', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const totalRevenue = await new Promise(r => db.get('SELECT SUM(entry_fee) as r FROM users WHERE paid = 1 AND entry_fee > 0', (_, row) => r(row?.r || 0)));
  const todayRevenue = await new Promise(r => db.get('SELECT SUM(entry_fee) as r FROM users WHERE paid = 1 AND entry_fee > 0 AND DATE(datetime(created_at/1000,"unixepoch")) = DATE("now")', (_, row) => r(row?.r || 0)));
  const totalUsers = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1', (_, row) => r(row?.c || 0)));
  const active = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1 AND failed = 0', (_, row) => r(row?.c || 0)));
  const passed = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE failed = 2', (_, row) => r(row?.c || 0)));

  const msg = `*ADMIN STATS*\n\nRevenue: $${totalRevenue?.toFixed(2) ?? 0}\nToday: $${todayRevenue?.toFixed(2) ?? 0}\nPaid Users: ${totalUsers}\nActive: ${active}\nPassed: ${passed}`;
  ctx.replyWithMarkdownV2(esc(msg));
});

// Positions command
bot.command('positions', async ctx => {
  const exists = await new Promise(r => db.get('SELECT 1 FROM users WHERE user_id = ? AND paid = 1', [ctx.from.id], (_, row) => r(!!row)));
  if (!exists && ctx.from.id !== ADMIN_ID) return ctx.reply('No active challenge');
  await showPositions(ctx);
});

// Buy flow
async function handleBuy(ctx, ca) {
  const user = await new Promise(r => db.get('SELECT balance FROM users WHERE user_id = ? AND paid = 1', [ctx.from.id], (_, row) => r(row)));
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

bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const ca = ctx.match[1].trim();
  const amountUSD = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user || user.failed !== 0) return ctx.editMessageText('Challenge inactive');

  const minCash = user.start_balance * CASH_BUFFER_PERCENT;
  if (user.balance - amountUSD < minCash) return ctx.editMessageText(`Keep at least $${minCash.toFixed(0)} cash`);

  if (amountUSD > user.start_balance * MAX_POSITION_PERCENT) return ctx.editMessageText(`Max ${MAX_POSITION_PERCENT * 100}% per trade`);

  const today = new Date().toISOString().slice(0,10);
  const tradesToday = await new Promise(r => db.get('SELECT COUNT(*) as c FROM positions WHERE user_id = ? AND DATE(created_at/1000,"unixepoch") = ?', [userId, today], (_, row) => r(row?.c || 0)));
  if (tradesToday >= MAX_TRADES_PER_DAY) return ctx.editMessageText(`Max ${MAX_TRADES_PER_DAY} trades per day`);

  await ctx.editMessageText('Sniping...');

  const token = await getTokenData(ca);
  if (!token.price || token.price <= 0) return ctx.editMessageText('Token data unavailable');
  if (token.priceChange1h > PUMP_MAX_1H_PERCENT) return ctx.editMessageText(`Token pumped >${PUMP_MAX_1H_PERCENT}% in 1h - forbidden`);

  let entryPrice = token.price;
  let tokensBought = amountUSD / entryPrice;

  // Jupiter quote for better accuracy
  try {
    const quote = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: ca,
        amount: Math.max(Math.round((amountUSD / 150) * 1e9), 10000000), // Approx SOL price, acceptable for sim
        slippageBps: 1000
      },
      timeout: 7000
    });
    if (quote.data?.outAmount) {
      tokensBought = Number(quote.data.outAmount) / 1e9;
      entryPrice = amountUSD / tokensBought;
    }
  } catch (e) {}

  await new Promise(r => {
    db.run('BEGIN');
    db.run('INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, ca, token.symbol, amountUSD, tokensBought, entryPrice, Date.now()]);
    db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId]);
    db.run('COMMIT', r);
  });

  userLastActivity.set(userId, Date.now());

  await ctx.editMessageText(esc(`
BUY EXECUTED

${token.symbol}
Size: $${amountUSD}
Tokens: ${tokensBought.toLocaleString(undefined, {maximumFractionDigits: 0})}
Entry: $${entryPrice.toFixed(12)}
MC: ${token.mc}

Remaining: $${(user.balance - amountUSD).toFixed(2)}
  `.trim()), {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: "Open Positions", callback_data: "refresh_pos" }]] }
  });
});

// Custom amount - fixed (no callAction)
bot.action(/custom\|(.+)/, async ctx => {
  await ctx.answerCbQuery();
  ctx.session.ca = ctx.match[1];
  ctx.reply('Send amount in USD:');
});

bot.on('text', async ctx => {
  if (ctx.session?.ca) {
    const amount = Number(ctx.message.text);
    delete ctx.session.ca;
    if (amount > 0) {
      // Simulate callback
      const fakeCtx = { ...ctx, match: ['', ctx.session?.ca || '', amount], answerCbQuery: () => {}, editMessageText: ctx.replyWithMarkdownV2.bind(ctx) };
      await bot.action(/buy\|(.+)\|(.+)/).callback(fakeCtx);
    }
    return;
  }
  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(text)) await handleBuy(ctx, text);
});

// Sell
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const user = await new Promise(r => db.get('SELECT failed FROM users WHERE user_id = ?', [userId], (_, row) => r(row)));
  if (user?.failed !== 0) return;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos) return;

  const live = await getTokenData(pos.ca);
  const price = live.price > 0 ? live.price : pos.entry_price * 0.01;

  const tokensToSell = pos.tokens_bought * (percent / 100);
  const proceeds = tokensToSell * price;
  const pnl = (price - pos.entry_price) * tokensToSell;

  await new Promise(r => db.run('UPDATE users SET balance = balance + ? WHERE user_id = ?', [proceeds, userId], r));

  if (percent === 100) {
    await new Promise(r => db.run('DELETE FROM positions WHERE id = ?', [posId], r));
  } else {
    const remain = (100 - percent) / 100;
    await new Promise(r => db.run('UPDATE positions SET tokens_bought = tokens_bought * ?, amount_usd = amount_usd * ? WHERE id = ?', [remain, remain, posId], r));
  }

  await ctx.replyWithMarkdownV2(esc(`
*SOLD ${percent}%*

${live.symbol}
Proceeds: $${proceeds.toFixed(2)}
PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
  `.trim()));

  showPositions(ctx);
});

// Inactivity checker
setInterval(() => {
  const now = Date.now();
  for (const [userId, last] of userLastActivity) {
    if (now - last > INACTIVITY_HOURS * 3600000) {
      db.run('UPDATE users SET failed = 3 WHERE user_id = ? AND failed = 0', [userId]);
      userLastActivity.delete(userId);
    }
  }
}, 6 * 3600000);

// Positions panel - optimized
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  userLastActivity.set(userId, Date.now());

  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
    ACTIVE_POSITION_PANELS.delete(userId);
  }

  let messageId = ctx.update?.callback_query?.message?.message_id;
  if (!messageId) {
    const sent = await ctx.replyWithMarkdownV2('Loading positions\\.\\.\\.');
    messageId = sent.message_id;
  }

  await renderPanel(userId, chatId, messageId);

  const intervalId = setInterval(() => renderPanel(userId, chatId, messageId), 1500); // Faster but stable
  ACTIVE_POSITION_PANELS.set(userId, { chatId, messageId, intervalId });
}

async function renderPanel(userId, chatId, messageId) {
  const [user, positions] = await Promise.all([
    new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row))),
    new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])))
  ]);

  if (!user) return;

  let totalPnL = 0;
  const buttons = [];

  for (const p of positions) {
    const live = await getTokenData(p.ca);
    const price = live.price > 0 ? live.price : p.entry_price * 0.01;
    const pnlUSD = (price - p.entry_price) * p.tokens_bought;
    const pnlPct = p.entry_price > 0 ? ((price - p.entry_price) / p.entry_price) * 100 : 0;

    totalPnL += pnlUSD;

    buttons.push([{ text: `${live.symbol}${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | $${pnlUSD.toFixed(2)}`, callback_data: 'noop' }]);
    if (user.failed === 0) {
      buttons.push([
        { text: '25%', callback_data: `sell_${p.id}_25` },
        { text: '50%', callback_data: `sell_${p.id}_50` },
        { text: '100%', callback_data: `sell_${p.id}_100` }
      ]);
    }
  }

  const equity = user.balance + totalPnL;
  let peak = user.peak_equity || user.start_balance;
  if (equity > peak) {
    peak = equity;
    await db.run('UPDATE users SET peak_equity = ? WHERE user_id = ?', [peak, userId]);
  }

  const drawdown = peak > user.start_balance ? ((peak - equity) / peak) * 100 : 0;
  const breached = drawdown >= MAX_DRAWDOWN_PERCENT;

  if (user.failed === 0) {
    if (breached) await db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId]);
    if (equity >= user.target) await db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId]);
  }

  let status = '';
  if (user.failed === 1) status = `*FAILED — ${MAX_DRAWDOWN_PERCENT}% DD*\n\n`;
  if (user.failed === 2) status = `*PASSED\\! $${user.bounty} + PROFITS*\nSend wallet\n\n`;
  if (user.failed === 3) status = `*FAILED — INACTIVITY*\n\n`;

  const text = esc(`
${status}*LIVE POSITIONS*

Equity     $${equity.toFixed(2)}
Unrealized ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Peak       $${peak.toFixed(2)}
Drawdown   ${drawdown.toFixed(2)}%

${positions.length === 0 ? 'No open positions' : ''}
  `.trim());

  await bot.telegram.editMessageText(chatId, messageId, null, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        ...buttons,
        [{ text: 'Refresh', callback_data: 'refresh_pos' }],
        [{ text: 'Close', callback_data: 'close_pos' }]
      ]
    }
  }).catch(() => {});
}

bot.action('refresh_pos', async ctx => { await ctx.answerCbQuery(); await showPositions(ctx); });
bot.action('close_pos', async ctx => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
    ACTIVE_POSITION_PANELS.delete(userId);
  }
  await ctx.deleteMessage();
});

// Launch
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('Crucible Bot Running'));

process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
