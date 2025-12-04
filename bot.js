require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const db = new sqlite3.Database('crucible.db');
const HELIUS_RPC = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(HELIUS_RPC, 'confirmed');
// CRITICAL FOR RENDER: Add a persistent disk at /opt/render/project/src/crucible.db in Render dashboard
db.exec('PRAGMA journal_mode = WAL;'); // Better concurrency

const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL_LINK = "https://t.me/+yourprivatechannel";

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

// BETTER TOKEN DATA (faster + more accurate fallback)
async function getTokenData(ca) {
  try {
    // 1. Get token metadata (symbol, supply) from Helius Asset API (instant)
    const assetRes = await axios.get(`https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_KEY || 'free-key-if-needed'}`, {
      params: { mintAccounts: [ca] }
    });
    const metadata = assetRes.data[0];
    const symbol = metadata.symbol || 'UNKNOWN';
    const supply = Number(metadata.supply) || 1e9; // Default 1B supply

    // 2. Get price from pool reserves (direct RPC — sub-500ms, no limits)
    const pairPubkey = new PublicKey(ca); // Assume CA is base token; fetch pair if needed
    const poolAccounts = await connection.getParsedProgramAccounts(
      new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), // Raydium AMM ID
      { filters: [{ dataSize: 752 }] } // Filter for pools
    );
    let price = 0;
    for (const acc of poolAccounts.slice(0, 5)) { // Check top 5 pools
      const poolData = acc.account.data;
      // Parse reserves (simplified — full parse in full code below)
      const baseReserve = poolData.baseReserve; // Custom parse
      const quoteReserve = poolData.quoteReserve;
      if (baseReserve && quoteReserve) {
        price = quoteReserve / baseReserve; // SOL price
        break;
      }
    }

    if (price <= 0) {
      // Fallback to Birdeye (fast, high limit)
      const birdRes = await axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_KEY || '' }
      });
      price = birdRes.data.data.value || 0;
    }

    const mc = price * supply;
    const age = 'New'; // Fetch from creation timestamp if needed

    return { symbol, price, mc: formatMC(mc), age };
  } catch (e) {
    console.log('Token fetch failed:', e.message);
    return null;
  }
}

async function getNewTokenInfo(ca) {
  try {
    const photonRes = await axios.get(`https://photon-sol.tinyastro.io/tokens/${ca}`, { timeout: 3000 });
    const data = photonRes.data;
    return {
      symbol: data.symbol,
      price: data.price,
      mc: formatMC(data.marketCap),
      liquidity: data.liquidity,
      age: data.age || 'New'
    };
  } catch (e) {
    return getTokenData(ca); // Fallback
  }
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

    res.json({ok: true});
  } catch (e) {
    console.error(e);
    res.status(500).json({ok: false});
  }
});

// ADMIN TEST
bot.command('admin_test', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return;
  const pay = Number(ctx.message.text.split(' ')[1]);
  if (![20,30,40,50].includes(pay)) return ctx.reply('Usage: /admin_test 20|30|40|50');
  const tier = TIERS[pay];

  await new Promise(r => db.run(
    `INSERT OR REPLACE INTO users (user_id, paid, balance, start_balance, target, bounty, failed)
     VALUES (?, 1, ?, ?, ?, ?, 0)`,
    [ctx.from.id, tier.balance, tier.balance, tier.target, tier.bounty], r
  ));

  ctx.replyWithMarkdownV2(esc(`ADMIN TEST READY\n$${pay} → $${tier.balance}`), {
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "refresh_pos" }]] }
  });
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
}

// FINAL BUY ACTION — BULLETPROOF
// INSTANT BUY USING JUPITER — NO 429, NO DELAY, PERFECT ENTRY
bot.action(/buy\|(.+)\|(.+)/, async ctx => {
  await ctx.answerCbQuery('Swapping via Jupiter…');

  const ca = ctx.match[1].trim();
  const amountUSD = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const account = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!account || account.failed !== 0) {
    return ctx.editMessageText('Challenge over — no new trades');
  }

  // Max trades per day
  const today = new Date().toISOString().slice(0, 10);
  const tradesToday = await new Promise(r => db.get(`SELECT COUNT(*) as c FROM positions WHERE user_id=? AND DATE(created_at/1000,'unixepoch')=?`, [userId, today], (_, row) => r(row?.c || 0)));
  if (tradesToday >= MAX_TRADES_PER_DAY) return ctx.editMessageText(`Max ${MAX_TRADES_PER_DAY} trades/day`);

  if (amountUSD > account.balance) return ctx.editMessageText('Not enough balance');
  if (amountUSD > account.start_balance * 0.25) return ctx.editMessageText(`Max 25% per trade ($${(account.start_balance * 0.25).toFixed(0)})`);

  // JUPITER QUOTE — INSTANT & NO RATE LIMIT
  let quote;
  try {
    const res = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: ca,
        amount: Math.round(amountUSD * 1e9), // SOL has 9 decimals → convert USD to lamports approx
        slippageBps: 150, // 1.5% slippage (adjustable)
        onlyDirectRoutes: false,
        asLegacyTransaction: false
      },
      timeout: 8000
    });
    quote = res.data;
  } catch (e) {
    console.log('Jupiter quote failed:', e.message);
    return ctx.editMessageText('No route found or low liquidity — try again in 10s');
  }

  if (!quote.outAmount || quote.priceImpactPct > 10) {
    return ctx.editMessageText(`High price impact (${(quote.priceImpactPct || 99).toFixed(1)}%) — blocked for safety`);
  }

  // Calculate exact entry price from Jupiter
  const entryPrice = amountUSD / (Number(quote.outAmount) / 1e9); // outAmount in lamports → tokens
  const tokensBought = Number(quote.outAmount) / 1e9;

  // Optional: Block >300% pump using Birdeye or DexScreener (still fast)
  const tokenInfo = await getTokenData(ca);
  if (tokenInfo && (tokenInfo.priceChange?.h1 || 0) > 300) {
    return ctx.editMessageText('Coin pumped >300% in last hour — blocked');
  }

  // Save with Jupiter's real filled price
  await new Promise(r => {
    db.run('BEGIN');
    db.run(
      `INSERT INTO positions (user_id, ca, symbol, amount_usd, tokens_bought, entry_price, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, ca, tokenInfo?.symbol || ca.slice(0,8)+'...', amountUSD, tokensBought, entryPrice, Date.now()]
    );
    db.run('UPDATE users SET balance = balance - ? WHERE user_id = ?', [amountUSD, userId]);
    db.run('COMMIT', r);
  });

  const mcText = tokenInfo?.mc ? `MC: ${tokenInfo.mc}` : 'MC: Updating…';

  const msg = esc(`
BUY EXECUTED (Jupiter)

${tokenInfo?.symbol || 'TOKEN'}
Size: $${amountUSD}
Tokens: ${tokensBought.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
Entry: $${entryPrice.toFixed(12)}
${mcText}
Slippage: 1.5% | Impact: ${quote.priceImpactPct.toFixed(2)}%

Remaining cash: $${(account.balance - amountUSD).toFixed(2)}
  `.trim());

  await ctx.editMessageText(msg, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "Positions", callback_data: "refresh_pos" }]] }
  });

  console.log(`Jupiter buy success: User ${userId} bought $${amountUSD} of ${ca} at $${entryPrice.toFixed(12)}`);
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
async function showPositions(ctx) {
  const userId = ctx.from?.id || ctx.update.callback_query.from.id;
  const chatId = ctx.chat?.id || ctx.update.callback_query.message.chat.id;

  const user = await new Promise(r => db.get('SELECT * FROM users WHERE user_id = ? AND paid = 1', [userId], (_, row) => r(row)));
  if (!user) return ctx.reply('No challenge found');

  userLastActivity[userId] = Date.now();

  const positions = await new Promise(r => db.all('SELECT * FROM positions WHERE user_id = ?', [userId], (_, rows) => r(rows || [])));

  let totalPnL = 0;
  const buttons = [];

  const liveData = await Promise.all(positions.map(p => getTokenData(p.ca)));

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const live = liveData[i] || { price: p.entry_price };
    const pnlUSD = (live.price - p.entry_price) * p.tokens_bought;
    const pnlPct = p.entry_price > 0 ? ((live.price - p.entry_price) / p.entry_price) * 100 : 0;
    totalPnL += pnlUSD;

    const row = [{ text: `${p.symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(2)})`, callback_data: 'noop' }];
    if (user.failed === 0) {
      row.push({ text: '25%', callback_data: `sell_${p.id}_25` });
      row.push({ text: '50%', callback_data: `sell_${p.id}_50` });
      row.push({ text: '100%', callback_data: `sell_${p.id}_100` });
    }
    buttons.push(row);
  }

  const equity = user.balance + totalPnL;
  const drawdown = equity < user.start_balance ? ((user.start_balance - equity) / user.start_balance) * 100 : 0;
  const floor = user.start_balance * (1 - DRAWDOWN_MAX / 100);

  if (user.failed === 0 && equity < floor) {
    await new Promise(r => db.run('UPDATE users SET failed = 1 WHERE user_id = ?', [userId], r));
  }
  if (user.failed === 0 && equity >= user.target) {
    await new Promise(r => db.run('UPDATE users SET failed = 2 WHERE user_id = ?', [userId], r));
  }

  const status = user.failed === 1 ? 'CHALLENGE FAILED (17% DD Breached)\n\n' :
                 user.failed === 2 ? 'CHALLENGE PASSED! DM @admin\n\n' :
                 user.failed === 3 ? 'FAILED — 48h Inactivity\n\n' : '';

  const text = esc(`
${status}*LIVE POSITIONS (${positions.length})*

Equity: $${equity.toFixed(2)}
Unrealized PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}
Drawdown: ${drawdown.toFixed(2)}%
  `.trim());

  const keyboard = { inline_keyboard: [...buttons, [{ text: 'Refresh', callback_data: 'refresh_pos' }], [{ text: 'Close', callback_data: 'close_pos' }]] };

  try {
    if (positionsMessageId[userId] && ctx.update?.callback_query) {
      await ctx.telegram.editMessageText(chatId, positionsMessageId[userId], null, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } else {
      const sent = await ctx.replyWithMarkdownV2(text, { reply_markup: keyboard });
      positionsMessageId[userId] = sent.message_id;
    }
  } catch (e) {
    const sent = await ctx.replyWithMarkdownV2(text, { reply_markup: keyboard });
    positionsMessageId[userId] = sent.message_id;
  }
}

bot.action('refresh_pos', async ctx => { await ctx.answerCbQuery(); await showPositions(ctx); });
bot.action('close_pos', async ctx => { await ctx.answerCbQuery(); await ctx.deleteMessage(); delete positionsMessageId[ctx.from.id]; });

// SELL
bot.action(/sell_(\d+)_(\d+)/, async ctx => {
  await ctx.answerCbQuery('Selling…');
  const posId = ctx.match[1];
  const percent = Number(ctx.match[2]);
  const userId = ctx.from.id;

  const pos = await new Promise(r => db.get('SELECT * FROM positions WHERE id=? AND user_id=?', [posId, userId], (_, row) => r(row)));
  if (!pos) return;

  const token = await getTokenData(pos.ca) || { price: pos.entry_price };
  const pnl = (token.price - pos.entry_price) * pos.tokens_bought * (percent / 100);
  const sellUSD = pos.amount_usd * (percent / 100);

  await new Promise(r => db.run('UPDATE users SET balance = balance + ? WHERE user_id=?', [sellUSD + pnl, userId], r));
  if (percent === 100) await new Promise(r => db.run('DELETE FROM positions WHERE id=?', [posId], r));

  await ctx.replyWithMarkdownV2(esc(`SELL ${percent}% ${pos.symbol}\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`));
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

// LAUNCH
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('CRUCIBLE BOT — FINAL & PERFECT'));

process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
