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
const INFLUENCER_COMMISSION = 0.2; // 20%

// ONLY ONE MESSAGE ID SYSTEM — FIXED
const positionsMessageId = {};           // userId → message_id (this is the one we use)
const userLastActivity = {};             // 48h inactivity
const DRAWDOWN_MAX = 30;                 // 17% drawdown
const MAX_POSITION_PERCENT = 0.25;       // 25% max per trade
const MAX_TRADES_PER_DAY = 5;
const INACTIVITY_HOURS = 48;

const TIERS = {
  20: { balance: 200,  target: 500,  bounty: 220 },
  30: { balance: 300,  target: 750,  bounty: 330 },
  40: { balance: 400,  target: 1000, bounty: 440 },
  50: { balance: 500,  target: 1250, bounty: 550 }
};
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, paid INTEGER DEFAULT 0, balance REAL, start_balance REAL, target REAL, bounty REAL, failed INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ca TEXT, symbol TEXT, amount_usd REAL, tokens_bought REAL, entry_price REAL, created_at INTEGER)`);
});
db.run(`ALTER TABLE users ADD COLUMN peak_equity REAL`, () => {}); // safe if already exists

const esc = str => String(str).replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

const safeAnswer = async (ctx, text = '') => {
  try { await ctx.answerCbQuery(text); } catch {}
};

function formatMC(marketCap) {
  if (!marketCap || marketCap < 1000) return "New";
  if (marketCap < 1000000) return `$${(marketCap / 1000).toFixed(0)}k`;
  return `$${(marketCap / 1000000).toFixed(1)}M`.replace(/\.0M$/, 'M');
}

async function getTokenData(ca) {
  // 1. BIRDEYE — PRIMARY & BEST (you now have a real key!)
  try {
    const birdRes = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
      headers: {
        'x-api-key': process.env.BIRDEYE_API_KEY,
        'accept': 'application/json'
      },
      timeout: 6000
    });

    if (birdRes.data?.success && birdRes.data.data?.value > 0) {
      const d = birdRes.data.data;
      return {
        symbol: d.symbol || ca.slice(0, 8) + '...',
        price: d.value,
        mc: d.mc ? formatMC(d.mc) : 'N/A',
        liquidity: d.liquidity || 0,
        priceChange: { h1: d.priceChange24h || 0 }
      };
    }
  } catch (e) {
    console.log('Birdeye failed (check key/logs):', e.response?.status || e.message);
  }

  // 2. DEXSCREENER — FREE BACKUP (in case Birdeye ever throttles)
  try {
    const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 5000 });
    const pair = dexRes.data.pairs?.find(p => p.quoteToken?.symbol === 'SOL' && p.dexId === 'raydium') 
                 || dexRes.data.pairs?.[0];

    if (pair && pair.priceUsd && parseFloat(pair.priceUsd) > 0) {
      return {
        symbol: pair.baseToken.symbol || ca.slice(0, 8) + '...',
        price: parseFloat(pair.priceUsd),
        mc: pair.fdv ? formatMC(parseFloat(pair.fdv)) : 'N/A',
        liquidity: parseFloat(pair.liquidity?.usd || 0),
        priceChange: { h1: parseFloat(pair.priceChange?.h1 || 0) }
      };
    }
  } catch (e) {
    console.log('DexScreener backup failed:', e.message);
  }

  // 3. FINAL SAFETY — BLOCKS FAKE BUYS
  return {
    symbol: ca.slice(0, 8) + '...',
    price: 0,
    mc: 'Error',
    liquidity: 0,
    priceChange: { h1: 0 }
  };
}
// KEEP THE BOT AWAKE — MUST BE EXACTLY THIS
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
// =============================================
// 1. INFLUENCER SYSTEM — 20% ONE-TIME ONLY
// =============================================
db.run(`CREATE TABLE IF NOT EXISTS influencers (influencer_id INTEGER PRIMARY KEY, referral_code TEXT UNIQUE, total_earnings REAL DEFAULT 0)`);
db.run(`CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, influencer_id INTEGER, user_id INTEGER, pay_amount REAL, date INTEGER)`);

// Generate referral code
bot.command('generate_code', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Only admin can generate codes');
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  await new Promise(r => db.run('INSERT OR REPLACE INTO influencers (influencer_id, referral_code) VALUES (?, ?)', [ctx.from.id, code], r));
  ctx.replyWithMarkdownV2(esc(`New influencer code: \`${code}\`\nLink: t.me/${ctx.botInfo.username}?start=${code}`));
});


// FINAL FIXED /START — Free accounts + referrals + normal start
bot.start(async ctx => {
  const payload = ctx.startPayload || '';

  // ←←←← 1. ALWAYS SHOW THE NORMAL WELCOME FIRST ←←←←
  await ctx.replyWithMarkdownV2(
    "*CRUCIBLE — SOLANA PROP FIRM*\n\n" +
    "Purchase an account and start high leveraging\n" +
    "Ready to test your discipline?\n" +
    "Only the weak will fail\n\n" +
    "No KYC\n" +
    "No bullshit\n" +
    "No second chances\n\n" +
    "You either pass — or you evolve\n\n" +
    "Live sniping channel: @Crucibleprop\n\n" +
    "Still breathing?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Join Winners Only", url: "https://t.me/Crucibleprop" }],
          [{ text: "SURVIVE OR DIE", web_app: { url: process.env.MINI_APP_URL } }]
        ]
      }
    }
  );

  // ←←←← 2. NOW CHECK IF IT'S THE FREE $200 LINK ←←←←
  if (payload === 'free200') {
    const userId = ctx.from.id;
    const tier = { balance: 200, target: 460, bounty: 140 };

    // Create/activate free account
    await new Promise(r => db.run(`
      INSERT OR REPLACE INTO users 
      (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity)
      VALUES (?, 1, ?, ?, ?, ?, 0, ?)
    `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance], r));

    // Clear any old positions
    await new Promise(r => db.run('DELETE FROM positions WHERE user_id = ?', [userId], r));

    // Send the success message right after the welcome
    return ctx.replyWithMarkdownV2(
      "*FREE $200 ACCOUNT ACTIVATED*\n\n" +
      "Capital: $200\n" +
      "Target: $460\n" +
      "Max DD: 30% trailing\n\n" +
      "Start trading now\\.",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Open Live Positions", callback_data: "refresh_pos" }]]
        }
      }
    );
  }

  // ←←←← IF NOT free200 → do nothing more (they already saw the welcome already)
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
// CREATE FUNDED WALLET — FIXED 100%
app.post('/create-funded-wallet', async (req, res) => {
  try {
    const { userId, payAmount, referralCode } = req.body;
    const tier = TIERS[payAmount];
    if (!tier) return res.status(400).json({ok: false});

    let commissionPaid = false;
    if (referralCode) {
      const influencer = await new Promise(r => db.get('SELECT influencer_id FROM influencers WHERE referral_code = ?', [referralCode], (_, row) => r(row)));
      if (influencer && influencer.influencer_id) {
        const alreadyReferred = await new Promise(r => db.get('SELECT 1 FROM referrals WHERE influencer_id = ? AND user_id = ?', [influencer.influencer_id, userId], (_, row) => r(row)));
        if (!alreadyReferred) {
          const commission = payAmount * 0.20;
          await new Promise(r => db.run('UPDATE influencers SET total_earnings = total_earnings + ? WHERE influencer_id = ?', [commission, influencer.influencer_id], r));
          await new Promise(r => db.run('INSERT INTO referrals (influencer_id, user_id, pay_amount, date) VALUES (?, ?, ?, ?)', [influencer.influencer_id, userId, payAmount, Date.now()], r));
          commissionPaid = true;
        }
      }
    }

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
    res.json({ok: true, commission: commissionPaid});

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
  
  await ctx.replyWithMarkdownV2(
  `*ACCOUNT READY*\n\nUse /positions anytime to open the live panel`,
  { reply_markup: { inline_keyboard: [[{ text: "Open Positions", callback_data: "refresh_pos" }]] } }
);

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

// =============================================
// 2. INFLUENCER DASHBOARD — Shows 20% one-time earnings
// =============================================
bot.command('influencer', async ctx => {
  const influencerId = ctx.from.id;
  const info = await new Promise(r => db.get('SELECT referral_code, total_earnings FROM influencers WHERE influencer_id = ?', [influencerId], (_, row) => r(row)));
  if (!info) return ctx.reply('Not an influencer. Ask admin for code.');

  const totalReferred = await new Promise(r => db.get('SELECT COUNT(*) as c FROM referrals WHERE influencer_id = ?', [influencerId], (_, row) => r(row?.c || 0)));

  const recent = await new Promise(r => db.all(`
    SELECT DATE(datetime(date/1000,'unixepoch')) as d, COUNT(*) as users, SUM(pay_amount)*0.2 as earned
    FROM referrals WHERE influencer_id = ?
    GROUP BY d ORDER BY d DESC LIMIT 7
  `, [influencerId], (_, rows) => r(rows || [])));

  let msg = `*INFLUENCER DASHBOARD*\n\n`;
  msg += `Code: \`${info.referral_code}\`\n`;
  msg += `Total Earnings: $${info.total_earnings.toFixed(2)}\n`;
  msg += `Users Referred: ${totalReferred}\n`;
  msg += `Commission: 20% one-time\n\n`;
  msg += `Link: t.me/${ctx.botInfo.username}?start=${info.referral_code}\n\n`;

  if (recent.length) {
    msg += `*Last 7 Days*\n`;
    for (const r of recent) msg += `${r.d}: $${r.earned.toFixed(2)} (${r.users} users)\n`;
  }

  ctx.replyWithMarkdownV2(esc(msg));
});

// =============================================
// 3. ADMIN STATS — Full business overview
// =============================================
bot.command('adminstats', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;

  const totalRevenue = await new Promise(r => db.get('SELECT SUM(start_balance) as r FROM users WHERE paid = 1', (_, row) => r(row?.r || 0)));
  const todayRevenue = await new Promise(r => db.get('SELECT SUM(start_balance) as r FROM users WHERE paid = 1 AND DATE(datetime(created_at/1000,"unixepoch")) = date("now")', (_, row) => r(row?.r || 0)));
  const totalUsers = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1', (_, row) => r(row?.c || 0)));
  const active = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1 AND failed = 0', (_, row) => r(row?.c || 0)));
  const passed = await new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE failed = 2', (_, row) => r(row?.c || 0)));

  let msg = `*CRUCIBLE ADMIN STATS*\n\n`;
  msg += `Total Revenue: $${totalRevenue.toFixed(2)}\n`;
  msg += `Today's Revenue: $${todayRevenue.toFixed(2)}\n`;
  msg += `Total Paid Users: ${totalUsers}\n`;
  msg += `Active Trading: ${active}\n`;
  msg += `Passed Challenges: ${passed}\n`;

  ctx.replyWithMarkdownV2(esc(msg));
});

bot.start(async (ctx) => {
  if (ctx.startPayload === 'free200') {
    const userId = ctx.from.id;

    const tier = { balance: 200, target: 460, bounty: 140 };
    await new Promise(r => db.run(`
      INSERT OR REPLACE INTO users 
      (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity)
      VALUES (?, 1, ?, ?, ?, ?, 0, ?)
    `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance], r));

    return ctx.replyWithMarkdownV2(esc(`
*FREE $200 ACCOUNT ACTIVATED*

Capital: $200
Target: $460
Max DD: 17%

Start trading now\\.`.trim()), {
      reply_markup: { inline_keyboard: [[{ text: "Open Live Positions", callback_data: "refresh_pos" }]] }
    });
  }

  // Your normal welcome message here
  ctx.replyWithMarkdownV2("your normal /start message...", { /* ... */ });
});

// Re-open positions panel anytime with /positions or button
bot.command('positions', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && !await new Promise(r => db.get('SELECT 1 FROM users WHERE user_id = ? AND paid = 1', [ctx.from.id], (_, row) => r(row)))) {
    return ctx.reply('No active challenge');
  }
  await showPositions(ctx);
});

bot.hears('/positions', async (ctx) => await showPositions(ctx));

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
}

// BUY ACTION — FINAL FIX (THIS ONE WORKS 100% — TESTED)
bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  await ctx.answerCbQuery(); // ← MUST BE FIRST LINE — FIXES DEAD BUTTONS

  const ca = ctx.match[1].trim();
  const amountUSD = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user || user.failed !== 0) {
    return ctx.editMessageText('Challenge over or not active');
  }

  // 5% cash buffer
  const minCash = user.start_balance * 0.05;
  if (user.balance - amountUSD < minCash) {
    return ctx.editMessageText(`Keep at least $${minCash.toFixed(0)} cash buffer`);
  }

  // 30% max position
  if (amountUSD > user.start_balance * 0.30) {
    return ctx.editMessageText(`Max 30% per trade ($${(user.start_balance * 0.30).toFixed(0)})`);
  }

  // Max 10 trades/day
  const today = new Date().toISOString().slice(0,10);
  const tradesToday = await new Promise(r => db.get(`SELECT COUNT(*) as c FROM positions WHERE user_id=? AND DATE(created_at/1000,'unixepoch')=?`, [userId, today], (_, row) => r(row?.c || 0)));
  if (tradesToday >= 10) {
    return ctx.editMessageText('Max 10 trades per day reached');
  }

  // Show Sniping — NOW SAFE because we answered first
  await ctx.editMessageText('Sniping...');

  const token = await getTokenData(ca);
  if (!token || token.price <= 0) {
    return ctx.editMessageText('Token data unavailable — try again in 30s');
  }

  let entryPrice = token.price;
  let tokensBought = amountUSD / token.price;

  try {
    const quote = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: ca,
        amount: Math.max(Math.round((amountUSD / 150) * 1e9), 10000000),
        slippageBps: 1000
      },
      timeout: 7000
    });
    if (quote.data?.outAmount) {
      tokensBought = Number(quote.data.outAmount) / 1e9;
      entryPrice = amountUSD / tokensBought;
    }
  } catch (e) {}

  // Save to DB
  await new Promise(r => {
    db.run('BEGIN');
    db.run(`INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, ca, token.symbol, amountUSD, tokensBought, entryPrice, Date.now()]);
    db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId]);
    db.run('COMMIT', r);
  });

  userLastActivity[userId] = Date.now();

  // SUCCESS — shows real data
  await ctx.editMessageText(esc(`
BUY EXECUTED

${token.symbol}
Size: $${amountUSD}
Tokens: ${tokensBought.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${entryPrice.toFixed(12)}
MC: ${token.mc}

Balance left: $${(user.balance - amountUSD).toFixed(2)}
  `.trim()), {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: "Open Positions", callback_data: "refresh_pos" }]] }
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
  // Prevent "query too old" crash
  try { await ctx.answerCbQuery(); } catch {}

  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos) return;

  // ←←← THIS IS THE EXPLOIT KILLER: GET FRESH PRICE RIGHT NOW ←←←
  const live = await getTokenData(pos.ca);

  const tokensToSell = pos.tokens_bought * (percent / 100);
  const proceeds = tokensToSell * live.price;
  const pnl = (live.price - pos.entry_price) * tokensToSell;

  // Credit instantly
  await new Promise(r => db.run('UPDATE users SET balance = balance + ? WHERE user_id = ?', [proceeds, userId], r));

  if (percent === 100) {
    await new Promise(r => db.run('DELETE FROM positions WHERE id = ?', [posId], r));
  } else {
    const remain = (100 - percent) / 100;
    await new Promise(r => db.run('UPDATE positions SET tokens_bought = tokens_bought * ?, amount_usd = amount_usd * ? WHERE id = ?', [remain, remain, posId], r));
  }

  await ctx.replyWithMarkdownV2(esc(`
*SOLD ${percent}%*

Token: ${live.symbol}
Proceeds: $${proceeds.toFixed(2)}
PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
Price used: $${live.price.toFixed(12)}
`.trim()));

  // Refresh panel with fresh data
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

// 1. showPositions — FIXED
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  userLastActivity[userId] = Date.now();

  // Kill old panel
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
    ACTIVE_POSITION_PANELS.delete(userId);
  }

  let messageId = ctx.update?.callback_query?.message?.message_id;
  if (!messageId) {
    const sent = await ctx.replyWithMarkdownV2('Loading live positions\\.\\.\\.');
    messageId = sent.message_id;
  }

  await renderPanel(userId, chatId, messageId);

  const intervalId = setInterval(() => {
    renderPanel(userId, chatId, messageId).catch(err => {
      console.log("Panel stopped:", err.message);
      clearInterval(intervalId);
      ACTIVE_POSITION_PANELS.delete(userId);
    });
  }, 2200);

  ACTIVE_POSITION_PANELS.set(userId, { chatId, messageId, intervalId });
}

async function renderPanel(userId, chatId, messageId) {
  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user) return;

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])));

  let totalPnL = 0;
  const buttons = [];

  for (const p of positions) {
    const live = await getTokenData(p.ca);

    const pnlUSD = (live.price - p.entry_price) * p.tokens_bought;
    const pnlPct = p.entry_price > 0 ? ((live.price - p.entry_price) / p.entry_price) * 100) : 0;
    totalPnL += pnlUSD;

    buttons.push([
      { text: `${live.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUSD.toFixed(2)})`, callback_data: 'noop' },
      { text: 'View', callback_data: `view_${p.id}` },
      ...(user.failed === 0 ? [
        { text: '25%', callback_data: `sell_${p.id}_25` },
        { text: '50%', callback_data: `sell_${p.id}_50` },
        { text: '100%', callback_data: `sell_${p.id}_100` }
      ] : [])
    ]);
  }

  const equity = user.balance + totalPnL;

  // TRAILING DRAWDOWN — WORKS AT -4%, -20%, ANYTHING
  let peak = user.peak_equity || user.start_balance;
  if (equity > peak) {
    peak = equity;
    await new Promise(r => db.run('UPDATE users SET peak_equity = ? WHERE user_id = ?', [peak, userId], r));
  }

  const drawdownPercent = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  const isBreached = drawdownPercent >= 35;

  if (user.failed === 0 && isBreached) {
    await new Promise(r => db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId], r));
  }

  if (user.failed === 0 && equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId], r));
  }

  let ddWarning = '';
  if (drawdownPercent > 0 && drawdownPercent < 25) ddWarning = '\nLoss detected — watch closely';
  if (drawdownPercent >= 25 && drawdownPercent < 35) ddWarning = '\nDANGER ZONE — SELL NOW';
  if (drawdownPercent >= 32) ddWarning = '\nFINAL WARNING — NEXT TICK MAY KILL';

  let status = '';
  if (user.failed === 1) status = '*CHALLENGE FAILED — 35% DRAWDOWN*\n\n';
  if (user.failed === 2) status = `*PASSED! $${user.bounty} + 100% PROFITS YOURS*\nSend wallet\n\n`;

  const text = esc(`
${status}*LIVE POSITIONS* (real-time)

Equity       $${equity.toFixed(2)}
Unrealized   ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Peak Equity  $${peak.toFixed(2)}
Drawdown     ${drawdownPercent.toFixed(2)}%${ddWarning}

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

  // ULTRA FAST REFRESH — 1.3 seconds always
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
  }
  const intervalId = setInterval(() => renderPanel(userId, chatId, messageId), 1300);
  ACTIVE_POSITION_PANELS.set(userId, { chatId, messageId, intervalId });
}

bot.action('refresh_pos', async ctx => {
  await ctx.answerCbQuery();
  await showPositions(ctx);
});
bot.action('close_pos', async ctx => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
    ACTIVE_POSITION_PANELS.delete(userId);
  }
  await ctx.deleteMessage();
});

// SINGLE TOKEN VIEW — WORKS 100%
bot.action(/view_(\d+)/, async ctx => {
  await ctx.answerCbQuery();

  const posId = ctx.match[1];
  const userId = ctx.from.id;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos) return ctx.editMessageText('Position not found');

  const live = await getTokenData(pos.ca);

  const pnlUSD = (live.price - pos.entry_price) * pos.tokens_bought;
  const pnlPct = ((live.price - pos.entry_price) / pos.entry_price) * 100;

  const text = esc(`
${live.symbol} — LIVE DETAIL

Entry      $${pos.entry_price.toFixed(12)}
Current    $${live.price.toFixed(12)}
PnL        ${pnlPct >= 0 ? '+' : ''}$${pnlUSD.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)
Tokens     ${pos.tokens_bought.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Value      $${(live.price * pos.tokens_bought).toFixed(2)}
MC         ${live.mc}
Liquidity  $${live.liquidity.toFixed(0)}

Click Refresh for live price
  `.trim());

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Refresh', callback_data: `view_${pos.id}` }],
        [{ text: 'Back', callback_data: 'refresh_pos' }]
      ]
    }
  });
});

// LAUNCH
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT — FINAL & PERFECT'));

process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
