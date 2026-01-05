require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const express = require('express');  // ONLY ONE TIME
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('cron');        // Add this if not installed: npm install cron

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(session({
  defaultSession: () => ({})
}));

const app = express();
app.use(express.json());  // ONLY ONE TIME

const dbPath = process.env.DB_PATH || '/data/crucible.db';
const db = new sqlite3.Database(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

const ADMIN_ID = Number(process.env.ADMIN_ID);
const userLastActivity = new Map();
const priceCache = new Map();

// === CONFIGURATION ===
const MAX_DRAWDOWN_PERCENT = 35;
const MAX_POSITION_PERCENT = 0.30;
const MAX_TRADES_PER_DAY = 10;
const INACTIVITY_HOURS = 48;
const CASH_BUFFER_PERCENT = 0.05;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_me_immediately';

const TIERS = {
  20: { balance: 200, target: 500, bounty: 220 },
  30: { balance: 300, target: 750, bounty: 330 },
  40: { balance: 400, target: 1000, bounty: 440 },
  50: { balance: 500, target: 1250, bounty: 550 }
};

// === DATABASE SETUP ===
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
    realized_peak REAL,
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
    decimals INTEGER DEFAULT 9,
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

  // Add realized_peak column + initialize
  db.run(`ALTER TABLE users ADD COLUMN realized_peak REAL`, () => {});
  db.run(`UPDATE users SET realized_peak = start_balance WHERE realized_peak IS NULL`, () => {});
  db.run('ALTER TABLE users ADD COLUMN payout_address TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN payout_tx TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN payout_sent INTEGER DEFAULT 0', () => {});
});

// Backward compatibility
db.run(`ALTER TABLE users ADD COLUMN peak_equity REAL`, () => {});
db.run(`ALTER TABLE users ADD COLUMN entry_fee REAL`, () => {});
db.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`, () => {});
db.run(`ALTER TABLE positions ADD COLUMN decimals INTEGER DEFAULT 9`, () => {});

const esc = str => String(str).replace(/[_*[\]()~>#+-=|{}.!]/g, '\\$&');

function formatMC(marketCap) {
  if (!marketCap || marketCap < 1000) return "New";
  if (marketCap < 1000000) return `$${(marketCap / 1000).toFixed(0)}k`;
  return `$${(marketCap / 1000000).toFixed(1)}M`.replace(/\.0M$/, 'M');
}

async function getTokenData(ca) {
  const now = Date.now();
  const cached = priceCache.get(ca);
  if (cached && now - cached.timestamp < 15000) { // 15 seconds cache
    return cached.data;
  }

  let result = {
    symbol: ca.slice(0, 8) + '...',
    price: 0,
    mc: 'Unknown',
    liquidity: 0,
    priceChange1h: 0,
    decimals: 9
  };

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Token data timeout')), 12000)
  );

  try {
    await Promise.race([
      (async () => {
        try {
          const res = await axios.get(`https://price.jup.ag/v6/price?ids=${ca}`, { timeout: 8000 });
          const data = res.data.data[ca];
          if (data && data.price > 0) {
            result.price = data.price;
            result.symbol = data.mintSymbol || data.symbol || result.symbol;
            if (data.marketCap) result.mc = formatMC(data.marketCap);
            throw new Error('success');
          }
        } catch (e) {
          if (e.message !== 'success') console.log('Jupiter price failed:', e.message);
        }

        try {
          const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 7000 });
          const pair = res.data.pairs?.find(p => p.dexId === 'raydium' && p.quoteToken?.symbol === 'SOL')
                    || res.data.pairs?.find(p => p.quoteToken?.symbol === 'SOL')
                    || res.data.pairs?.[0];

          if (pair && pair.priceUsd > 0) {
            const fdv = pair.fdv || 0;
            result = {
              symbol: pair.baseToken.symbol || ca.slice(0, 8) + '...',
              price: parseFloat(pair.priceUsd),
              mc: fdv > 0 ? formatMC(fdv) : 'N/A',
              liquidity: parseFloat(pair.liquidity?.usd || 0),
              priceChange1h: parseFloat(pair.priceChange?.h1 || 0),
              decimals: pair.baseToken.decimals || 9
            };
            throw new Error('success');
          }
        } catch (e) {
          if (e.message !== 'success') console.log('DexScreener failed:', e.message);
        }

        try {
          const headers = process.env.BIRDEYE_API_KEY 
            ? { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' }
            : { 'x-chain': 'solana' };

          const res = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
            headers,
            timeout: 6000
          });

          if (res.data?.success && res.data.data?.value > 0) {
            const d = res.data.data;
            result.symbol = d.symbol || result.symbol;
            result.price = d.value;
            result.liquidity = d.liquidity || result.liquidity;
            result.priceChange1h = d.priceChange?.h1 || 0;
            throw new Error('success');
          }
        } catch (e) {
          if (e.message !== 'success') console.log('Birdeye failed:', e.message);
        }
      })(),
      timeoutPromise
    ]);

    priceCache.set(ca, { data: result, timestamp: now });
    return result;

  } catch (e) {
    if (e.message === 'Token data timeout') {
      console.log('getTokenData timed out for', ca);
    }
    priceCache.set(ca, { data: result, timestamp: now });
    return result;
  }
}

async function getSolPrice() {
  try {
    const res = await axios.get('https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112', {
      headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY },
      timeout: 5000
    });
    return res.data.data?.value || 150;
  } catch {
    return 150;
  }
}

async function getSellQuote(ca, tokensToSell, decimals = 9) {
  try {
    const amount = Math.round(tokensToSell * Math.pow(10, decimals));
    const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: ca,
        outputMint: 'So11111111111111111111111111111111111111112',
        amount,
        slippageBps: 300
      },
      timeout: 6000
    });
    if (res.data?.outAmount) {
      return Number(res.data.outAmount) / 1e9;
    }
  } catch (e) {
    console.log('Jupiter sell quote failed:', e.message);
  }
  return null;
}

app.get('/health', (req, res) => res.status(200).send('OK'));


const pendingPayments = new Map();

// Clean up old pending payments
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of pendingPayments.entries()) {
    if (now - data.timestamp > 15 * 60 * 1000) {
      pendingPayments.delete(userId);
    }
  }
}, 60000);

// 1. Mini App calls this when user selects a tier
app.post('/start-payment', (req, res) => {
  const { userId, payAmount } = req.body;

  if (!userId || ![20, 30, 40, 50].includes(payAmount)) {
    return res.json({ ok: false, error: 'Invalid request' });
  }

  pendingPayments.set(Number(userId), {
    payAmount,
    timestamp: Date.now(),
    confirmed: false
  });

  console.log(`Payment started: User ${userId} expecting $${payAmount}`);
  res.json({ ok: true });
});

// 2. Mini App polls this to check if paid
app.post('/check-payment', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.json({ ok: false });

  const pending = pendingPayments.get(Number(userId));

  if (pending && pending.confirmed) {
    pendingPayments.delete(Number(userId));
    return res.json({ ok: true });
  }

  res.json({ ok: false });
});

// 3. Helius calls this when SOL is received
app.post('/helius-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // === SECURITY: Verify it's really Helius ===
    const EXPECTED_AUTH = process.env.HELIUS_AUTH_HEADER; // e.g., "Bearer abc123xyz"
    if (!EXPECTED_AUTH) {
      console.error('HELIUS_AUTH_HEADER not set!');
      return res.status(500).send('Server misconfigured');
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader !== EXPECTED_AUTH) {
      console.log('Unauthorized webhook attempt');
      return res.status(401).send('Unauthorized');
    }

    const payload = JSON.parse(req.body.toString());

    for (const txn of payload) {
      // Look for SOL transfers to your wallet
      const transfers = txn.nativeTransfers || [];
      const ourTransfer = transfers.find(t => 
        t.toUserAccount === 'B4427oKJc3xnQf91kwXHX27u1SsVyB8GDQtc3NBxRtkK'
      );

      if (!ourTransfer) continue;

      const receivedSOL = ourTransfer.amount / 1e9;

      // Map expected SOL → USD tier (adjust these when SOL price changes significantly)
      const SOL_TO_USD = {
        0.12: 20,   // ~$20 when SOL ≈ $166
        0.18: 30,   // ~$30
        0.24: 40,   // ~$40
        0.30: 50    // ~$50
      };

      let matchedPay = null;
      for (const [expectedSOL, usd] of Object.entries(SOL_TO_USD)) {
        if (Math.abs(receivedSOL - Number(expectedSOL)) < 0.01) { // ±0.01 SOL tolerance
          matchedPay = usd;
          break;
        }
      }

      if (!matchedPay) continue;

      // Find which pending user this matches
      let fundedUserId = null;
      for (const [userId, data] of pendingPayments.entries()) {
        if (data.payAmount === matchedPay && !data.confirmed) {
          fundedUserId = Number(userId);
          data.confirmed = true;
          break;
        }
      }

      if (!fundedUserId) {
        console.log(`Payment received ($${matchedPay}) but no pending user`);
        continue;
      }

      // === AUTO-FUND THE ACCOUNT ===
      const tier = TIERS[matchedPay];

      await new Promise((resolve) => {
        db.run('BEGIN TRANSACTION');
        db.run(`INSERT OR REPLACE INTO users 
          (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, realized_peak, entry_fee, created_at)
          VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          [fundedUserId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, tier.balance, matchedPay, Date.now()],
          () => {}
        );
        db.run('DELETE FROM positions WHERE user_id = ?', [fundedUserId], () => {});
        db.run('COMMIT', resolve);
      });

      // Notify user
      await bot.telegram.sendMessage(fundedUserId, 
        `*CRUCIBLE ACCOUNT FUNDED AUTOMATICALLY!*\n\n` +
        `Capital: $${tier.balance}\n` +
        `Target: $${tier.target}\n` +
        `Max Drawdown: 35%\n\n` +
        `Paste any Solana token address to start trading.`,
        { 
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [[{ text: "📊 Positions", callback_data: "refresh_pos" }]] }
        }
      ).catch(() => {});

      // Notify admin
      await bot.telegram.sendMessage(ADMIN_ID, 
        `✅ AUTO-FUNDED: User ${fundedUserId} paid $${matchedPay} → $${tier.balance} account\nTx: ${txn.signature.slice(0,12)}...`
      );

      pendingPayments.delete(fundedUserId);
      console.log(`Successfully auto-funded user ${fundedUserId}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Helius webhook error:', err);
    res.status(500).send('Error');
  }
});

// === SECURE WEBHOOK FOR PAYMENTS ===
app.post('/create-funded-wallet', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(403).json({ok: false, error: 'Invalid secret'});
  }

  try {
    const { userId, payAmount, referralCode } = req.body;
    if (!userId || !payAmount) return res.status(400).json({ok: false});

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

    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION');
      db.run(`INSERT OR REPLACE INTO users 
        (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
        VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, payAmount, Date.now()],
        err => err && reject(err)
      );
      db.run('DELETE FROM positions WHERE user_id = ?', [userId], err => err && reject(err));
      db.run('COMMIT', resolve);
    });

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
    console.error('Webhook error:', e);
    res.status(500).json({ok: false});
  }
});

// === BOT COMMANDS ===
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

bot.start(async ctx => {
  const payload = ctx.startPayload || '';

  // === MAIN WELCOME MESSAGE (always shown) ===
  await ctx.replyWithMarkdownV2(
    "*CRUCIBLE — SOLANA PROP FIRM*\n\n" +
    "Purchase an account and start high leveraging\n" +
    "Ready to test your discipline?\n\n" +
    "No KYC • No bullshit • No second chances\n\n" +
    "Live sniping channel: @Crucibleprop",
    {
      reply_markup: {
      inline_keyboard: [
      [{ text: "Join Winners Only", url: "https://t.me/Crucibleprop" }]
        ]
      }
    }
  );

  // === FREE ACCOUNT HANDLER — Multiple Tiers ===
  let tierKey = null;

  if (payload === 'free200') tierKey = 20;
  else if (payload === 'free300') tierKey = 30;
  else if (payload === 'free400') tierKey = 40;
  else if (payload === 'free500') tierKey = 50;

  if (tierKey) {
    const userId = ctx.from.id;
    const tier = TIERS[tierKey];

    if (!tier) {
      return ctx.reply('❌ Invalid free tier. Contact admin.');
    }

    try {
      // Clear old data and activate free account
      await new Promise((resolve, reject) => {
        db.run('BEGIN TRANSACTION', err => {
          if (err) return reject(err);

          db.run(`
            INSERT OR REPLACE INTO users 
            (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, realized_peak, entry_fee, created_at)
            VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, 0, ?)
          `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, tier.balance, Date.now()], err => {
            if (err) reject(err);
          });

          db.run('DELETE FROM positions WHERE user_id = ?', [userId], err => {
            if (err) reject(err);
          });

          db.run('COMMIT', err => err ? reject(err) : resolve());
        });
      });

      // Success message with correct tier details
      await ctx.replyWithMarkdownV2(
        `*FREE $${tier.balance} CHALLENGE ACTIVATED* 🎉\n\n` +
        `Capital: $${tier.balance}\n` +
        `Profit Target: $${tier.target}\n` +
        `Bounty: $${tier.bounty}\n` +
        `Max Drawdown: ${MAX_DRAWDOWN_PERCENT}%\n\n` +
        "Paste any Solana token CA to start trading\\!\n" +
        "Good luck — survive or die\\.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 Open Live Positions", callback_data: "refresh_pos" }]
            ]
          }
        }
      );

    } catch (error) {
      console.error('Free account activation failed:', error);
      await ctx.reply('❌ Failed to activate free account. Try again later.');
    }

    return;
  }
});

bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]);
  if (![20,30,40,50].includes(pay)) return ctx.reply('Usage: /admin_test 20|30|40|50');
  const tier = TIERS[pay];

  await new Promise(r => db.run(`
    INSERT OR REPLACE INTO users 
    (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, realized_peak, entry_fee, created_at)
    VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `, [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, tier.balance, pay, Date.now()], r));

  await new Promise(r => db.run('DELETE FROM positions WHERE user_id = ?', [ctx.from.id], r));

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

bot.command('positions', async ctx => {
  const exists = await new Promise(r => db.get('SELECT 1 FROM users WHERE user_id = ? AND paid = 1', [ctx.from.id], (_, row) => r(!!row)));
  if (!exists && ctx.from.id !== ADMIN_ID) return ctx.reply('No active challenge');
  await showPositions(ctx);
});

async function handleBuy(ctx, ca) {
  const user = await new Promise(r => db.get('SELECT balance, start_balance FROM users WHERE user_id = ? AND paid = 1', [ctx.from.id], (_, row) => r(row)));
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
  await ctx.answerCbQuery().catch(() => {});

  const ca = ctx.match[1].trim();
  let amountUSD = Number(ctx.match[2]);
  if (isNaN(amountUSD) || amountUSD <= 0) return;

  const userId = ctx.from.id;

  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user || user.failed !== 0) {
      return await ctx.editMessageText('❌ Challenge inactive or failed.');
    }

    const minCash = user.start_balance * CASH_BUFFER_PERCENT;
    if (user.balance < amountUSD) {
      return await ctx.editMessageText('❌ Insufficient balance.');
    }
    if (user.balance - amountUSD < minCash) {
      return await ctx.editMessageText(`❌ Must keep at least $${minCash.toFixed(0)} in cash buffer.`);
    }
    if (amountUSD > user.start_balance * MAX_POSITION_PERCENT) {
      return await ctx.editMessageText(`❌ Max position size: ${MAX_POSITION_PERCENT * 100}% of starting capital.`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const tradesToday = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as c FROM positions WHERE user_id = ? AND DATE(created_at/1000,"unixepoch") = ?', [userId, today], (err, row) => {
        if (err) reject(err);
        else resolve(row?.c || 0);
      });
    });

    if (tradesToday >= MAX_TRADES_PER_DAY) {
      return await ctx.editMessageText(`❌ Max ${MAX_TRADES_PER_DAY} trades per day reached.`);
    }

    await ctx.editMessageText('🔍 Fetching token data...');

    const token = await getTokenData(ca);
    if (!token.price || token.price <= 0) {
      return await ctx.editMessageText(esc(`
❌ Token data unavailable

• Token may be too new
• No liquidity on Raydium
• Invalid or honeypot contract

Try again in a few minutes or use a different token.
      `.trim()), { parse_mode: 'MarkdownV2' });
    }

    let entryPrice = token.price;
    let tokensBought = amountUSD / entryPrice;
    let decimals = token.decimals;

    // Try Jupiter quote for more accurate token amount
    try {
      const solPrice = await getSolPrice();
      const solAmount = amountUSD / solPrice;

      const quote = await axios.get('https://quote-api.jup.ag/v6/quote', {
        params: {
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: ca,
          amount: Math.round(solAmount * 1e9),
          slippageBps: 500
        },
        timeout: 10000  // Increased timeout
      });

      if (quote.data?.outAmount) {
        tokensBought = Number(quote.data.outAmount) / Math.pow(10, decimals);
        entryPrice = amountUSD / tokensBought;
      }
    } catch (e) {
      console.log('Jupiter quote failed, using price estimate:', e.message);
      // Continue with DexScreener/Birdeye price — it's acceptable
    }

    // Execute trade in DB
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);

        db.run(
          'INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, decimals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [userId, ca, token.symbol, amountUSD, tokensBought, entryPrice, decimals, Date.now()],
          err => { if (err) reject(err); }
        );

        db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId], err => {
          if (err) reject(err);
        });

        db.run('COMMIT', err => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    userLastActivity.set(userId, Date.now());

    // Final success message
    await ctx.editMessageText(esc(`
✅ BUY EXECUTED

${token.symbol}
Size: $${amountUSD}
Tokens: ${tokensBought.toLocaleString(undefined, {maximumFractionDigits: 0})}
Entry: $${entryPrice.toFixed(12)}
MC: ${token.mc}
Liquidity: $${token.liquidity.toFixed(0)}

Remaining cash: $${(user.balance - amountUSD).toFixed(2)}
    `.trim()), {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Open Positions", callback_data: "refresh_pos" }]]
      }
    });

  } catch (error) {
    console.error(`Buy failed for user ${userId} | CA: ${ca} | Amount: ${amountUSD}`, error);

    try {
      await ctx.editMessageText(esc(`
❌ Buy failed

An error occurred while processing your trade.
Please try again in a moment.

If this persists, the token may not be tradable yet.
      `.trim()), { parse_mode: 'MarkdownV2' });
    } catch (editErr) {
      console.error('Could not send error message:', editErr);
    }
  }
});

// === CUSTOM AMOUNT HANDLER (Fixed) ===
bot.action(/custom\|(.+)/, async ctx => {
  await ctx.answerCbQuery().catch(() => {});

  ctx.session.pendingBuyCA = ctx.match[1].trim();

  await ctx.reply('💵 Send the amount in USD (e.g., 75):');
});


bot.on('text', async ctx => {
  if (ctx.session?.pendingBuyCA) {
    const amount = Number(ctx.message.text.trim());
    const ca = ctx.session.pendingBuyCA;
    delete ctx.session.pendingBuyCA;

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Invalid amount. Please send a positive number.');
    }

    const fakeCtx = {
      ...ctx,
      match: ['', ca, amount],
      from: ctx.from,
      answerCbQuery: () => {},
      editMessageText: async (text, options) => await ctx.replyWithMarkdownV2(text, options),
      replyWithMarkdownV2: ctx.replyWithMarkdownV2.bind(ctx)
    };

    await bot.action(/buy\|(.+)\|(.+)/).callback(fakeCtx);
    return;
  }

  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(text)) {
    await handleBuy(ctx, text);
  }
});

// === SELL LOGIC ===
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  await ctx.answerCbQuery().catch(() => {});

  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const user = await new Promise(r => db.get('SELECT failed, balance FROM users WHERE user_id = ?', [userId], (_, row) => r(row)));
  if (user?.failed !== 0) return;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id = ? AND user_id = ?', [posId, userId], (_, row) => r(row)));
  if (!pos) return;

  const live = await getTokenData(pos.ca);
  const currentPrice = live.price > 0 ? live.price : pos.entry_price;

  const tokensToSell = pos.tokens_bought * (percent / 100);
  const solReceived = await getSellQuote(pos.ca, tokensToSell, pos.decimals);
  const solPrice = await getSolPrice();

  // Prioritize real quote, fallback conservatively
  const realizedUSD = solReceived !== null 
    ? solReceived * solPrice 
    : tokensToSell * currentPrice * 0.95; // 5% safety margin on estimate

  const originalCost = pos.amount_usd * (percent / 100);
  const pnl = realizedUSD - originalCost;

  await new Promise((resolve, reject) => {
    db.run('BEGIN TRANSACTION');
    db.run('UPDATE users SET balance = balance + ? WHERE user_id = ?', [realizedUSD, userId], err => err && reject(err));
    if (percent === 100) {
      db.run('DELETE FROM positions WHERE id = ?', [posId], err => err && reject(err));
    } else {
      const remain = (100 - percent) / 100;
      db.run('UPDATE positions SET tokens_bought = tokens_bought * ?, amount_usd = amount_usd * ? WHERE id = ?', [remain, remain, posId], err => err && reject(err));
    }
    db.run('COMMIT', resolve);
  });

  await ctx.replyWithMarkdownV2(esc(`
*SOLD ${percent}%*

${live.symbol}
Realized: $${realizedUSD.toFixed(2)}${solReceived === null ? ' *(estimate)*' : ''}
PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
  `.trim()));

  await showPositions(ctx);
  // After successful sell and DB commit
// === UPDATE REALIZED PEAK ONLY WHEN NO POSITIONS LEFT ===
  const openCount = await new Promise(r => db.get('SELECT COUNT(*) as c FROM positions WHERE user_id = ?', [userId], (_, row) => r(row?.c || 0)));

  if (openCount === 0) {
    const updatedUser = await new Promise(r => db.get('SELECT balance, start_balance, realized_peak FROM users WHERE user_id = ?', [userId], (_, row) => r(row)));
    const currentEquity = updatedUser.balance;
    const currentPeak = updatedUser.realized_peak || updatedUser.start_balance;

    if (currentEquity > currentPeak) {
      db.run('UPDATE users SET realized_peak = ? WHERE user_id = ?', [currentEquity, userId]);
    }
  }
});

// === POSITIONS PANEL ===
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  userLastActivity.set(userId, Date.now());

  let messageId = ctx.update?.callback_query?.message?.message_id;
  if (!messageId) {
    const sent = await ctx.replyWithMarkdownV2('Loading positions\\.\\.\\.');
    messageId = sent.message_id;
  }

  await renderPanel(userId, chatId, messageId);
}

async function renderPanel(userId, chatId, messageId) {
  try {
    const [user, positions] = await Promise.all([
      new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row))),
      new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])))
    ]);

    if (!user) return;

    let totalPnL = 0;
    let positionCost = 0;
    const buttons = [];

    if (positions.length > 0) {
      const liveDataArray = await Promise.all(positions.map(p => getTokenData(p.ca)));

      positions.forEach((p, i) => {
        const live = liveDataArray[i];
        const currentPrice = live.price > 0 ? live.price : p.entry_price;

        const pnlUSD = (currentPrice - p.entry_price) * p.tokens_bought;
        const pnlPct = p.entry_price > 0 ? ((currentPrice - p.entry_price) / p.entry_price) * 100 : 0;

        totalPnL += pnlUSD;
        positionCost += p.amount_usd;

        buttons.push([
          { text: `${live.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | $${pnlUSD.toFixed(2)}`, callback_data: 'noop' }
        ]);

        if (user.failed === 0) {
          buttons.push([
            { text: '25%', callback_data: `sell_${p.id}_25` },
            { text: '50%', callback_data: `sell_${p.id}_50` },
            { text: '100%', callback_data: `sell_${p.id}_100` }
          ]);
        }
      });
    }

    const positionCurrentValue = positionCost + totalPnL;
    const equity = user.balance + positionCurrentValue;

    // Realized peak only (no unrealized updates)
    const realizedPeak = user.realized_peak || user.start_balance;

    const drawdown = equity < realizedPeak ? ((realizedPeak - equity) / realizedPeak) * 100 : 0;

    if (user.failed === 0) {
      if (drawdown >= MAX_DRAWDOWN_PERCENT) {
        db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId]);
      }
      if (equity >= user.target) {
        db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId]);
      }
    }

    let status = '';
    if (user.failed === 1) status = `*FAILED — ${MAX_DRAWDOWN_PERCENT}% Drawdown*\n\n`;
    if (user.failed === 2) status = `*PASSED\\! Claim $${user.bounty} + profits*\nSend your Solana wallet\\.\n\n`;
    if (user.failed === 3) status = `*FAILED — Inactivity*\n\n`;

    const text = esc(`
${status}*LIVE POSITIONS*

Equity         $${equity.toFixed(2)}
Unrealized     ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Peak Equity    $${realizedPeak.toFixed(2)} (realized)
Drawdown       ${drawdown.toFixed(2)}%

${positions.length === 0 ? 'No open positions\\.' : ''}
    `.trim());

    await bot.telegram.editMessageText(chatId, messageId, null, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          ...buttons,
          [{ text: '🔄 Refresh', callback_data: 'refresh_pos' }],
          [{ text: '❌ Close Panel', callback_data: 'close_pos' }]
        ]
      }
    }).catch(() => {});

  } catch (err) {
    console.error('renderPanel error:', err);
  }
}

bot.action('refresh_pos', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  await showPositions(ctx);
});

bot.action('close_pos', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});

bot.action('noop', ctx => ctx.answerCbQuery().catch(() => {}));


// Daily report at 00:00 UTC
new cron.CronJob('0 0 0 * * *', async () => {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTimestamp = Math.floor(todayStart.getTime() / 1000);

    const [totalRevenue, todayRevenue, totalUsers, active, passedToday, failedDrawdown, failedInactivity, pendingPayouts] = await Promise.all([
      new Promise(r => db.get('SELECT SUM(entry_fee) as r FROM users WHERE paid = 1 AND entry_fee > 0', (_, row) => r(row?.r || 0))),
      new Promise(r => db.get('SELECT SUM(entry_fee) as r FROM users WHERE paid = 1 AND entry_fee > 0 AND created_at >= ?', [todayTimestamp * 1000], (_, row) => r(row?.r || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1', (_, row) => r(row?.c || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE paid = 1 AND failed = 0', (_, row) => r(row?.c || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE failed = 2 AND created_at >= ?', [todayTimestamp * 1000], (_, row) => r(row?.c || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE failed = 1 AND created_at >= ?', [todayTimestamp * 1000], (_, row) => r(row?.c || 0))),
      new Promise(r => db.get('SELECT COUNT(*) as c FROM users WHERE failed = 3 AND created_at >= ?', [todayTimestamp * 1000], (_, row) => r(row?.c || 0))),
      new Promise(r => db.get('SELECT COALESCE(SUM(bounty + (balance - start_balance)), 0) as total FROM users WHERE failed = 2', (_, row) => r(row?.total || 0)))
    ]);

    const dateStr = new Date().toUTCString().slice(0, 16);

    const msg = esc(`
*DAILY CRUCIBLE REPORT — ${dateStr}*

*Revenue*
• Today: $${todayRevenue.toFixed(2)}
• All-time: $${totalRevenue.toFixed(2)}

*Users*
• Total paid: ${totalUsers}
• Active challenges: ${active}
• Passed today: ${passedToday}
• Failed today: ${failedDrawdown} drawdown | ${failedInactivity} inactivity

*Pending payouts*: $${pendingPayouts.toFixed(2)}
    `.trim());

    await bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'MarkdownV2' });
    console.log('Daily report sent');
  } catch (err) {
    console.error('Daily report failed:', err);
  }
}, null, true, 'UTC');

// === ADMIN WEB DASHBOARD (Add this to your bot.js) ===
const ADMIN_DASH_USER = process.env.ADMIN_DASH_USER || 'admin';
const ADMIN_DASH_PASS = process.env.ADMIN_DASH_PASS;

if (!ADMIN_DASH_PASS) {
  console.warn('ADMIN_DASH_PASS not set — admin dashboard disabled');
}

// Basic Auth Middleware
const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    return res.set('WWW-Authenticate', 'Basic realm="Crucible Admin"').status(401).send('Login required');
  }

  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [username, password] = credentials.split(':');

  if (username === ADMIN_DASH_USER && password === ADMIN_DASH_PASS) {
    return next();
  }

  res.status(401).send('Invalid credentials');
};

// Shared HTML styling
const dashboardStyle = `
<style>
  body { margin:0; padding:0; background:#000; color:#f5f5f0; font-family:Arial,sans-serif; }
  .container { max-width:1200px; margin:20px auto; padding:20px; }
  h1 { color:#cf1020; text-align:center; text-shadow:0 0 15px #cf1020; margin-bottom:40px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:20px; margin:40px 0; }
  .card { background:#111; border:2px solid #cf1020; border-radius:12px; padding:20px; text-align:center; box-shadow:0 0 20px rgba(207,16,32,0.4); }
  .card h3 { margin:0 0 12px; color:#cf1020; font-size:18px; }
  .card p { margin:0; font-size:28px; font-weight:bold; }
  table { width:100%; border-collapse:collapse; background:#111; border:2px solid #cf1020; border-radius:12px; overflow:hidden; margin:30px 0; }
  th { background:#cf1020; color:#000; padding:14px; text-align:left; }
  td { padding:12px; border-bottom:1px solid #333; }
  tr:hover { background:#222; }
  .btn { background:#cf1020; color:#000; border:none; padding:8px 16px; border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px; }
  .btn:hover { background:#e05060; }
  .search { width:100%; padding:14px; margin:20px 0; background:#111; border:2px solid #cf1020; color:#f5f5f0; border-radius:8px; font-size:16px; box-sizing:border-box; }
  .back { display:block; text-align:center; margin:40px 0; color:#cf1020; font-weight:bold; text-decoration:none; font-size:18px; }
  .status-active { color:#0f0; font-weight:bold; }
  .status-passed { color:#cf1020; font-weight:bold; }
  .status-failed { color:#888; }
  form { display:inline; }
  input[type=text] { background:#000; color:#fff; border:1px solid #cf1020; padding:6px; border-radius:4px; margin-right:8px; }
</style>
`;

// Main Dashboard
app.get('/admin', adminAuth, async (req, res) => {
  try {
    const stats = await Promise.all([
      new Promise(r => db.get('SELECT SUM(entry_fee) as revenue FROM users WHERE paid = 1', (_, row) => r(row))),
      new Promise(r => db.get('SELECT SUM(entry_fee) as today FROM users WHERE paid = 1 AND date(created_at/1000,"unixepoch") = date("now")', (_, row) => r(row))),
      new Promise(r => db.get('SELECT COUNT(*) as total FROM users WHERE paid = 1', (_, row) => r(row))),
      new Promise(r => db.get('SELECT COUNT(*) as active FROM users WHERE paid = 1 AND failed = 0', (_, row) => r(row))),
      new Promise(r => db.get('SELECT COUNT(*) as passed FROM users WHERE failed = 2', (_, row) => r(row))),
      new Promise(r => db.get('SELECT COALESCE(SUM(bounty + (balance - start_balance)),0) as pending FROM users WHERE failed = 2 AND payout_sent = 0', (_, row) => r(row))),
      new Promise(r => db.all('SELECT user_id, entry_fee, balance, failed, created_at FROM users WHERE paid = 1 ORDER BY created_at DESC LIMIT 15', (_, rows) => r(rows))),
      new Promise(r => db.all('SELECT user_id, payout_address, bounty, balance, start_balance FROM users WHERE failed = 2 AND payout_sent = 0', (_, rows) => r(rows)))
    ]);

    const [revenue, today, total, active, passed, pendingPayouts, recent, pendingUsers] = stats;

    let html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crucible Admin</title>${dashboardStyle}</head><body><div class="container">
      <h1>CRUCIBLE ADMIN DASHBOARD</h1>
      <div class="cards">
        <div class="card"><h3>Total Revenue</h3><p>$${Number(revenue?.revenue || 0).toFixed(2)}</p></div>
        <div class="card"><h3>Today's Revenue</h3><p>$${Number(today?.today || 0).toFixed(2)}</p></div>
        <div class="card"><h3>Total Users</h3><p>${total?.total || 0}</p></div>
        <div class="card"><h3>Active</h3><p>${active?.active || 0}</p></div>
        <div class="card"><h3>Passed</h3><p>${passed?.passed || 0}</p></div>
        <div class="card"><h3>Pending Payouts</h3><p>$${Number(pendingPayouts?.pending || 0).toFixed(2)}</p></div>
      </div>`;

    if (pendingUsers.length > 0) {
      html += `<h2 style="color:#cf1020;">Pending Payouts (${pendingUsers.length})</h2><table><thead><tr>
        <th>User ID</th><th>Wallet</th><th>Bounty</th><th>Profit</th><th>Total Owed</th><th>Action</th>
      </tr></thead><tbody>`;
      for (const u of pendingUsers) {
        const profit = (u.balance - u.start_balance).toFixed(2);
        const total = (u.bounty + (u.balance - u.start_balance)).toFixed(2);
        html += `<tr>
          <td>${u.user_id}</td>
          <td>${u.payout_address || '<i>Not set</i>'}</td>
          <td>$${u.bounty}</td>
          <td>$${profit}</td>
          <td><strong>$${total}</strong></td>
          <td>
            <form action="/admin/mark-paid" method="POST">
              <input type="hidden" name="userId" value="${u.user_id}">
              <input type="text" name="tx" placeholder="Tx hash" required>
              <button type="submit" class="btn">Mark Paid</button>
            </form>
          </td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    html += `<h2 style="color:#cf1020;margin-top:50px;">Recent Activity</h2><table><thead><tr>
      <th>User ID</th><th>Tier</th><th>Status</th><th>Equity</th><th>Joined</th>
    </tr></thead><tbody>`;
    for (const u of recent) {
      const status = u.failed === 0 ? 'Active' : u.failed === 2 ? 'Passed' : 'Failed';
      const statusClass = u.failed === 0 ? 'status-active' : u.failed === 2 ? 'status-passed' : 'status-failed';
      html += `<tr>
        <td>${u.user_id}</td>
        <td>$${u.entry_fee || 'Free'}</td>
        <td class="${statusClass}">${status}</td>
        <td>$${Number(u.balance).toFixed(2)}</td>
        <td>${new Date(u.created_at).toLocaleString()}</td>
      </tr>`;
    }
    html += `</tbody></table>
      <p style="text-align:center;"><a href="/admin/users" style="color:#cf1020;font-weight:bold;font-size:18px;">View All Users →</a></p>
      </div></body></html>`;

    res.send(html);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// All Users Page
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await new Promise(r => db.all('SELECT user_id, entry_fee, balance, failed, created_at, payout_sent FROM users WHERE paid = 1 ORDER BY created_at DESC', (_, rows) => r(rows)));

    let html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>All Users</title>${dashboardStyle}</head><body><div class="container">
      <h1>All Users (${users.length})</h1>
      <input type="text" class="search" placeholder="Search User ID..." onkeyup="let v=this.value.toLowerCase(); document.querySelectorAll('tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(v)?'':'none')">
      <table><thead><tr>
        <th>User ID</th><th>Tier</th><th>Equity</th><th>Status</th><th>Payout</th><th>Joined</th>
      </tr></thead><tbody>`;

    for (const u of users) {
      const status = u.failed === 0 ? 'Active' : u.failed === 2 ? 'Passed' : 'Failed';
      const statusClass = u.failed === 0 ? 'status-active' : u.failed === 2 ? 'status-passed' : 'status-failed';
      const payout = u.failed === 2 ? (u.payout_sent ? 'Paid' : 'Pending') : '-';
      html += `<tr>
        <td>${u.user_id}</td>
        <td>$${u.entry_fee || 'Free'}</td>
        <td>$${Number(u.balance).toFixed(2)}</td>
        <td class="${statusClass}">${status}</td>
        <td>${payout}</td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
      </tr>`;
    }

    html += `</tbody></table>
      <a href="/admin" class="back">← Back to Dashboard</a>
      </div></body></html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// Mark Paid Endpoint
app.post('/admin/mark-paid', adminAuth, express.urlencoded({extended: true}), async (req, res) => {
  const { userId, tx } = req.body;
  if (!userId || !tx?.trim()) return res.redirect('/admin');

  try {
    const user = await new Promise(r => db.get('SELECT user_id, bounty, balance, start_balance FROM users WHERE user_id = ? AND failed = 2 AND payout_sent = 0', [userId], (_, row) => r(row)));
    if (!user) return res.redirect('/admin');

    await new Promise(r => db.run('UPDATE users SET payout_tx = ?, payout_sent = 1 WHERE user_id = ?', [tx.trim(), userId], r));

    const profit = user.balance - user.start_balance;
    const total = user.bounty + profit;

    await bot.telegram.sendMessage(userId, 
      `*🎉 PAYOUT SENT!*\n\n` +
      `Amount: $${total.toFixed(2)}\n` +
      `Transaction: \`${tx.trim()}\`\n\n` +
      `Thank you for trading with Crucible!`,
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});

    res.redirect('/admin');
  } catch (err) {
    console.error('Mark paid error:', err);
    res.redirect('/admin');
  }
});

// === IMPROVED INACTIVITY CHECKER ===
setInterval(async () => {
  const now = Date.now();
  const threshold = INACTIVITY_HOURS * 3600000; // 48 hours in ms

  const inactiveUsers = [];
  for (const [userId, last] of userLastActivity.entries()) {
    if (now - last > threshold) {
      inactiveUsers.push(userId);
    }
  }

  if (inactiveUsers.length === 0) return;

  console.log(`Checking ${inactiveUsers.length} potentially inactive users...`);

  try {
    await new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', err => {
        if (err) return reject(err);

        let completed = 0;
        const total = inactiveUsers.length;

        if (total === 0) {
          db.run('COMMIT', resolve);
          return;
        }

        inactiveUsers.forEach(userId => {
          db.run(
            'UPDATE users SET failed = 3 WHERE user_id = ? AND failed = 0',
            [userId],
            function(err) {
              if (err) {
                console.error(`Failed to mark user ${userId} inactive:`, err);
              } else if (this.changes > 0) {
                console.log(`User ${userId} marked inactive`);
                userLastActivity.delete(userId);

                // Notify admin
                bot.telegram.sendMessage(ADMIN_ID, 
                  `⚠️ User ${userId} failed due to inactivity (${INACTIVITY_HOURS}h no interaction)`
                ).catch(() => {});

                // Optional: notify user
                bot.telegram.sendMessage(userId,
                  '❌ Your challenge has been failed due to inactivity.\n\n' +
                  `No interaction detected in the last ${INACTIVITY_HOURS} hours.\n` +
                  'Contact support if you believe this is an error.'
                ).catch(() => {});
              }
              completed++;
              if (completed === total) db.run('COMMIT', resolve);
            }
          );
        });
      });
    });

    console.log(`Inactivity check complete: ${inactiveUsers.length} checked.`);
  } catch (err) {
    console.error('Inactivity checker transaction failed:', err);
    // On error, rollback is automatic in SQLite
  }
}, 3600000); // Every hour

const PORT = process.env.PORT || 3000;
const RAILWAY_PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.PUBLIC_URL;

if (!RAILWAY_PUBLIC_URL) {
  console.error('ERROR: No public URL found! Set PUBLIC_URL or wait for Railway domain.');
  process.exit(1);
}

const WEBHOOK_URL = `${RAILWAY_PUBLIC_URL}/bot`;
const SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || 'super-secret-token-change-me';

// Use your existing Express app for Telegraf webhook
app.post('/bot', bot.webhookCallback('/bot'));

// Start ONLY the Express server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Express server listening on port ${PORT}`);
  console.log('Webhook URL:', WEBHOOK_URL);
  console.log('Public Domain:', RAILWAY_PUBLIC_URL);

  // Set the webhook with Telegram (runs on every start – safe and ensures it's correct)
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL, {
      secret_token: SECRET_TOKEN
    });
    console.log('Webhook successfully set to:', WEBHOOK_URL);
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
  }
});
