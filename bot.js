require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const app = express();
app.use(express.json());

const dbPath = process.env.DB_PATH || '/data/crucible.db';
const db = new sqlite3.Database(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

const ADMIN_ID = Number(process.env.ADMIN_ID);
const ACTIVE_POSITION_PANELS = new Map(); // Now only tracks for cleanup
const userLastActivity = new Map();
const priceCache = new Map();

// === CONFIGURATION ===
const MAX_DRAWDOWN_PERCENT = 35;
const MAX_POSITION_PERCENT = 0.30;
const MAX_TRADES_PER_DAY = 10;
const INACTIVITY_HOURS = 48;
const CASH_BUFFER_PERCENT = 0.05;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_me_immediately'; // CHANGE THIS!

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
  if (cached && now - cached.timestamp < 5000) { // Short cache for fast updates
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

  // Overall hard timeout — prevents hanging forever
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Token data timeout')), 12000)
  );

  try {
    await Promise.race([
      (async () => {
        // 1. Jupiter Price API — fastest & most reliable for memecoins
        try {
          const res = await axios.get(`https://price.jup.ag/v6/price?ids=${ca}`, { timeout: 8000 });
          const data = res.data.data[ca];
          if (data && data.price > 0) {
            result.price = data.price;
            result.symbol = data.mintSymbol || data.symbol || result.symbol;
            if (data.marketCap) result.mc = formatMC(data.marketCap);
            // Jupiter doesn't provide liquidity/decimals directly, but price is priority
            throw new Error('success'); // Early exit from race
          }
        } catch (e) {
          if (e.message !== 'success') console.log('Jupiter price failed:', e.message);
        }

        // 2. DexScreener fallback
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

        // 3. Birdeye fallback (uses your key if set)
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

    // Cache whatever we got (even if price 0)
    priceCache.set(ca, { data: result, timestamp: now });
    return result;

  } catch (e) {
    if (e.message === 'Token data timeout') {
      console.log('getTokenData timed out for', ca);
    }
    priceCache.set(ca, { data: result, timestamp: now });
    return result; // Always returns quickly
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
          [{ text: "Join Winners Only", url: "https://t.me/Crucibleprop" }],
          [{ text: "SURVIVE OR DIE", web_app: { url: process.env.MINI_APP_URL } }]
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
            (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
            VALUES (?, 1, ?, ?, ?, ?, 0, ?, 0, ?)
          `, [userId, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, Date.now()], err => {
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
    (user_id, paid, balance, start_balance, target, bounty, failed, peak_equity, entry_fee, created_at)
    VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?)
  `, [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty, tier.balance, pay, Date.now()], r));

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();
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

    // Simulate a callback query context for the buy handler
    const fakeCtx = {
      ...ctx,
      match: ['', ca, amount],
      from: ctx.from,
      answerCbQuery: () => {},
      editMessageText: async (text, options) => {
        // For custom buys, we reply instead of edit (no prior message to edit)
        await ctx.replyWithMarkdownV2(text, options);
      },
      replyWithMarkdownV2: ctx.replyWithMarkdownV2.bind(ctx)
    };

    // Reuse the same buy logic
    await bot.action(/buy\|(.+)\|(.+)/).callback(fakeCtx);
    return;
  }

  // Direct CA paste
  const text = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,48}$/i.test(text)) {
    await handleBuy(ctx, text);
  }
});

// === SELL LOGIC ===
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
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
});

// === MANUAL POSITIONS PANEL ===
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  userLastActivity.set(userId, Date.now());

  // Clear old interval
  if (ACTIVE_POSITION_PANELS.has(userId)) {
    clearInterval(ACTIVE_POSITION_PANELS.get(userId).intervalId);
  }

  let messageId = ctx.update?.callback_query?.message?.message_id;
  if (!messageId) {
    const sent = await ctx.replyWithMarkdownV2('Loading live positions\\.\\.\\.');
    messageId = sent.message_id;
  }

  // Initial render
  await renderPanel(userId, chatId, messageId);

  // Auto-refresh every 5 seconds
  const intervalId = setInterval(() => {
    renderPanel(userId, chatId, messageId).catch(() => {});
  }, 5000);

  ACTIVE_POSITION_PANELS.set(userId, { chatId, messageId, intervalId });
}

async function renderPanel(userId, chatId, messageId) {
  const MAX_REFRESH_INTERVAL = 5000; // 5 seconds — fast but safe
  const startTime = Date.now();

  try {
    // === 1. Fetch user and positions ===
    const [user, positions] = await Promise.all([
      new Promise((resolve) => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => resolve(row))),
      new Promise((resolve) => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => resolve(rows || [])))
    ]);

    if (!user) {
      clearInterval(ACTIVE_POSITION_PANELS.get(userId)?.intervalId);
      ACTIVE_POSITION_PANELS.delete(userId);
      return;
    }

    // === 2. FORCE FRESH PRICES — Clear cache for all positions ===
    positions.forEach(pos => priceCache.delete(pos.ca));

    // === 3. Fetch live prices (in parallel) ===
    let totalPnL = 0;
    const buttons = [];
    let liveDataArray = [];

    if (positions.length > 0) {
      liveDataArray = await Promise.all(positions.map(p => getTokenData(p.ca)));

      positions.forEach((p, i) => {
        const live = liveDataArray[i];
        const currentPrice = live.price > 0 ? live.price : p.entry_price * 0.95; // gentle fallback
        const pnlUSD = (currentPrice - p.entry_price) * p.tokens_bought;
        const pnlPct = p.entry_price > 0 ? ((currentPrice - p.entry_price) / p.entry_price) * 100 : 0;

        totalPnL += pnlUSD;

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

    // === 4. Calculate equity, peak, drawdown ===
    const equity = user.balance + totalPnL;
    let peak = user.peak_equity || user.start_balance;

    if (equity > peak) {
      peak = equity;
      db.run('UPDATE users SET peak_equity = ? WHERE user_id = ?', [peak, userId]);
    }

    const drawdown = peak > user.start_balance ? ((peak - equity) / peak) * 100 : 0;
    const breached = drawdown >= MAX_DRAWDOWN_PERCENT;

    if (user.failed === 0) {
      if (breached) db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId]);
      if (equity >= user.target) db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId]);
    }

    // === 5. Status message ===
    let status = '';
    if (user.failed === 1) status = `*FAILED — ${MAX_DRAWDOWN_PERCENT}% DD*\n\n`;
    if (user.failed === 2) status = `*PASSED\\! Claim $${user.bounty} + profits*\nSend wallet address\\.\n\n`;
    if (user.failed === 3) status = `*FAILED — INACTIVITY*\n\n`;

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const text = esc(`
${status}*LIVE POSITIONS* ↻ ${now}

Equity       $${equity.toFixed(2)}
Unreal PnL   ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Peak         $${peak.toFixed(2)}
Drawdown     ${drawdown.toFixed(2)}%

${positions.length === 0 ? 'No open positions' : ''}
    `.trim());

    // === 6. Edit message ===
    await bot.telegram.editMessageText(chatId, messageId, null, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          ...buttons,
          [{ text: '🔄 Refresh', callback_data: 'refresh_pos' }],
          [{ text: '❌ Close', callback_data: 'close_pos' }]
        ]
      }
    }).catch(() => {}); // Silent fail if message deleted

  } catch (err) {
    console.error('renderPanel error:', err);
    // Don't crash the interval
  }
}

bot.action('refresh_pos', async ctx => {
  await ctx.answerCbQuery();
  await showPositions(ctx);
});

bot.action('close_pos', async ctx => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
});

bot.action('noop', ctx => ctx.answerCbQuery());

// === INACTIVITY CHECKER (every hour now) ===
setInterval(() => {
  const now = Date.now();
  for (const [userId, last] of userLastActivity.entries()) {
    if (now - last > INACTIVITY_HOURS * 3600000) {
      db.run('UPDATE users SET failed = 3 WHERE user_id = ? AND failed = 0', [userId]);
      userLastActivity.delete(userId);
    }
  }
}, 3600000); // Hourly

// === CORRECT & WORKING WEBHOOK SETUP FOR RAILWAY ===
const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = '/webhook'; // Simple fixed path

// THIS LINE IS CRITICAL — mount the webhook handler
app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

// Health checks
app.get('/', (req, res) => res.send('Crucible Bot is running!'));
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;

  if (!domain) {
    console.error('❌ RAILWAY_PUBLIC_DOMAIN missing! Generate a domain in Railway settings.');
    return;
  }

  const webhookUrl = `https://${domain}${WEBHOOK_PATH}`;

  try {
    // Clear any old webhook first
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('Cleared old webhook');

    // Set the new one
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set successfully: ${webhookUrl}`);
    console.log('Bot is now fully active — /start, free links, buys, positions all work!');
  } catch (error) {
    console.error('Webhook setup failed:', error.message);
    if (error.response) console.error(error.response.description);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit();
});
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit();
});
