require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const bs58 = require('bs58');
const { PublicKey } = require('@solana/web3.js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
const db = new sqlite3.Database('challenges.db');

// DB Init
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    balance REAL DEFAULT 500,
    target REAL DEFAULT 1150,
    bounty REAL DEFAULT 190,
    start_date TEXT,
    positions TEXT DEFAULT '[]',
    drawdown REAL DEFAULT 0,
    failed INTEGER DEFAULT 0,
    paid INTEGER DEFAULT 0
  )`);
});

// Helper Functions (getUser, updateUser, etc.)
async function getUser(userId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM users WHERE user_id=?', [userId], (err, row) => {
      if (!row) {
        db.run('INSERT INTO users (user_id, start_date) VALUES (?, ?)', [userId, new Date().toISOString()]);
        resolve({ user_id: userId, balance: 500, positions: [], paid: 0, failed: 0, start_date: new Date().toISOString() });
      } else {
        row.positions = JSON.parse(row.positions || '[]');
        resolve(row);
      }
    });
  });
}

async function updateUser(userId, user) {
  return new Promise((resolve) => {
    db.run('UPDATE users SET balance=?, positions=?, drawdown=? WHERE user_id=?',
      [user.balance, JSON.stringify(user.positions), user.drawdown || 0, userId], resolve);
  });
}

async function setPaidDynamic(userId, amount, virtualBalance, target, bounty) {
  db.run('UPDATE users SET paid=1, balance=?, target=?, bounty=? WHERE user_id=?',
    [virtualBalance, target, bounty, userId]);
  bot.telegram.sendMessage(process.env.ADMIN_ID, `New payment: User ${userId} - $${amount} tier (Virtual: $${virtualBalance})`);
  bot.telegram.sendMessage(userId, `✅ Payment confirmed! Challenge started. Virtual Balance: $${virtualBalance} | Target: $${target.toFixed(0)} | Bounty: $${bounty}\n\n/buy TOKEN AMOUNT\n/portfolio`);
}

async function failUser(userId) {
  db.run('UPDATE users SET failed=1 WHERE user_id=?', [userId]);
  bot.telegram.sendMessage(process.env.ADMIN_ID, `User ${userId} failed.`);
}

async function checkWin(userId, ctx) {
  const user = await getUser(userId);
  let equity = user.balance;
  for (let pos of user.positions) {
    const price = await getPrice(pos.token);
    equity += pos.amount * price;
  }
  if (equity >= user.target) {
    await failUser(userId);
    bot.telegram.sendMessage(userId, '🎉 WINNER! DM admin for payout.');
    bot.telegram.sendMessage(process.env.ADMIN_ID, `WINNER: ${userId} hit target! Payout $${user.bounty}.`);
  }
}

async function checkDrawdown(userId, ctx) {
  const user = await getUser(userId);
  let equity = user.balance;
  for (let pos of user.positions) {
    const price = await getPrice(pos.token);
    equity += pos.amount * price;
  }
  const dd = (user.balance - equity) / user.balance * 100;  // Fixed calc
  if (dd > 12) {
    await failUser(userId);
    bot.telegram.sendMessage(userId, '💥 Drawdown >12%! Challenge failed.');
    return;
  }
  user.drawdown = dd;
  await updateUser(userId, user);
}

// UPGRADED: Full Token Info API Chain (price, metadata, liquidity, holders, rug risk)
async function getTokenInfo(tokenOrAddress) {
  let info = { price: 0, name: 'Unknown', symbol: '', supply: 0, liquidity: 0, holders: 0, rugRisk: 'Medium' };

  // 1. Price: Jupiter (fastest for new tokens, 99% coverage)
  try {
    const res = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenOrAddress}`);
    info.price = res.data.data[tokenOrAddress]?.price || 0;
  } catch (e) {
    console.log('Jupiter price fail, trying DexScreener...');
  }

  if (!info.price) {
    try {
      const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenOrAddress}`);
      const pair = res.data.pairs[0];
      info.price = pair?.priceUsd || 0;
      info.liquidity = pair?.liquidity?.usd || 0;
    } catch (e) {
      console.log('DexScreener price fail');
    }
  }

  // 2. Metadata: Helius (free, detailed name/symbol/supply)
  try {
    const res = await axios.get(`https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY || ''}&mintAccounts=${tokenOrAddress}`);
    const meta = res.data[0];
    info.name = meta.name || 'Unknown';
    info.symbol = meta.symbol || '';
    info.supply = meta.supply / 1e9 || 0;  // In billions for memes
  } catch (e) {
    console.log('Helius metadata fail, using Birdeye fallback...');
    try {
      const res = await axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${tokenOrAddress}`);
      info.name = res.data.data.name || 'Unknown';
      info.symbol = res.data.data.symbol || '';
      info.supply = res.data.data.supply || 0;
    } catch (e2) {}
  }

  // 3. Holders & Rug Risk: Quick Helius or fallback calc
  try {
    const res = await axios.get(`https://api.helius.xyz/v0/addresses/${tokenOrAddress}/balances?api-key=${process.env.HELIUS_API_KEY || ''}`);
    info.holders = res.data.length || 0;
    info.rugRisk = info.holders < 50 ? 'High' : info.liquidity < 10000 ? 'Medium' : 'Low';
  } catch (e) {
    info.holders = 0;
    info.rugRisk = 'Unknown';
    info.price = Number(info.price) || 0;
  }

  return info;
}

function getTokenAddress(token) {
  const map = { WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', GOAT: 'A2tXxf7Xq1uN1kT3Q3fX6zX5fX5fX5fX5fX5fX5fX5fX' };  // Add more as needed
  return map[token] || 'So11111111111111111111111111111111111111112';  // SOL
}

// Commands
bot.start((ctx) => {
  ctx.replyWithMarkdownV2(`
*Welcome to Crucible PROP* 

To start you must:
1️ Join our channel for live rules, updates & hot coins:

@Crucibleprop

After joining, click the button below to pick your account size

Rules • Payouts • Commands → all inside the channel
  `, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "I joined — Start Challenge", web_app: { url: process.env.MINI_APP_URL } }]
      ]
    },
    disable_web_page_preview: true
  });
});

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('/buy TOKEN USD e.g. /buy WIF 100');
  const token = args[0].toUpperCase();
  const usdAmount = parseFloat(args[1]);
  const user = await getUser(ctx.from.id);
  if (!user.paid || user.failed) return ctx.reply('Start a challenge first!');
  if (usdAmount > user.balance * 0.25) return ctx.reply('Max 25% per position!');
  const price = await getPrice(token);
  if (!price) return ctx.reply('Token not found.');
  const tokenAmount = usdAmount / price;
  user.positions.push({ token, amount: tokenAmount, buyPrice: price });
  user.balance -= usdAmount;
  await updateUser(ctx.from.id, user);
  ctx.reply(`Bought ${tokenAmount.toFixed(2)} ${token} at $${price.toFixed(4)}\nBalance: $${user.balance.toFixed(2)}`);
  checkDrawdown(ctx.from.id, ctx);
});

bot.command('sell', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('/sell TOKEN USD or ALL');
  const token = args[0].toUpperCase();
  const usdAmount = args[1].toUpperCase() === 'ALL' ? 'ALL' : parseFloat(args[1]);
  const user = await getUser(ctx.from.id);
  const pos = user.positions.find(p => p.token === token);
  if (!pos) return ctx.reply('No position.');
  const currentPrice = await getPrice(token);
  const sellValue = usdAmount === 'ALL' ? pos.amount * currentPrice : usdAmount;
  const pnl = sellValue - (pos.amount * pos.buyPrice);
  user.balance += sellValue;
  user.positions = user.positions.filter(p => p.token !== token);
  await updateUser(ctx.from.id, user);
  ctx.reply(`Sold ${token}: +$${pnl.toFixed(2)}\nBalance: $${user.balance.toFixed(2)}`);
  checkWin(ctx.from.id, ctx);
});

bot.command('portfolio', async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user.paid) return ctx.reply('Start a challenge first!');

  let total = user.balance;
  let msg = `*Portfolio*\nCash: $${user.balance.toFixed(2)}\n\n*Positions:*\n`;

  if (user.positions.length === 0) {
    msg += "No open trades\n";
  } else {
    for (let pos of user.positions) {
      const price = await getPrice(pos.address || pos.token);
      const value = pos.amount * price;
      const pnl = value - (pos.amount * pos.buyPrice);
      total += value;
      const symbol = pos.address ? pos.address.slice(0,6)+'...' : pos.token;
      msg += `${symbol}: ${pos.amount.toFixed(2)} @ $${pos.buyPrice.toFixed(8)}\n → $${value.toFixed(2)} (${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)})\n`;
    }
  }

  msg += `\n*Total Equity*: $${total.toFixed(2)}\n*Target*: $${user.target.toFixed(0)}`;

  if (total >= user.target) {
    msg += "\n\nWINNER! You hit the target — DM admin for payout!";
  }

  ctx.replyWithMarkdown(msg);
});

bot.command('rules', (ctx) => {
  ctx.reply(`📜 Rules:\n1. Pay $20-$50 for virtual balance (10x pay).\n2. Hit 2.3x target.\n3. Fixed bounty payout.\n4. 10 days max.\n5. -12% drawdown = fail.\n6. Max 25% per trade.\n7. 5 winners/day cap.\n8. No bots.\n9. Max 2 active.\n10. Final decision ours.`);
});

// ——— ADMIN TEST COMMANDS (only you can use) ———
const ADMIN_ID = parseInt(process.env.ADMIN_ID);  // Your Telegram ID from .env

bot.command('admin_start', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const amount = parseInt(ctx.message.text.split(' ')[1]) || 20;
  const balance = amount * 10;
  const target = balance * 2.3;
  const bounty = amount * 7;

  // FULL CLEAN RESET + paid=1
  await db.run('DELETE FROM users WHERE user_id = ?', [ctx.from.id]);
  await db.run(`INSERT INTO users (
    user_id, paid, balance, target, bounty, start_date, positions, failed
  ) VALUES (?, 1, ?, ?, ?, ?, '[]', 0)`, 
  [ctx.from.id, balance, target, bounty, new Date().toISOString()]);

  ctx.replyWithMarkdown(`
*Test account ready!* 

Balance: $${balance}
Target: $${target.toFixed(0)}
Payout: $${bounty}

Now you can buy/sell normally
Try: /buy WIF 100
  `);
});

bot.command('admin_set_balance', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const newBal = parseFloat(ctx.message.text.split(' ')[1]);
  db.run('UPDATE users SET balance=? WHERE user_id=?', [newBal, ctx.from.id]);
  ctx.reply(`Balance forced to $${newBal}`);
});

bot.command('admin_reset', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  db.run('DELETE FROM users WHERE user_id=?', [ctx.from.id]);
  ctx.reply('Test challenge deleted');
});

// BUY ANY COIN BY CONTRACT ADDRESS — works even for brand-new launches
bot.command('buyca', async (ctx) => {
  const args = ctx.message.text.trim().split(' ');
  if (args.length < 3) return ctx.reply('Usage: /buyca <address> <amount>\nExample: /buyca 7dD8PjgmmCVm8NrdtYuTkbVjcDxr8nbJMkkyBbM2pump $40');

  const user = await getUser(ctx.from.id);
  if (!user.paid || user.failed) return ctx.reply('Start a challenge first!');

  const address = args[1];
  const amount = parseFloat(args[2].replace('$', ''));
  if (isNaN(amount)) return ctx.reply('Invalid amount');

  if (amount > user.balance * 0.25) return ctx.reply('Max 25% per position!');

  const info = await getTokenInfo(address);
  if (!info.price || info.price <= 0) {
    return ctx.reply('Coin not found yet — wait 10–30 seconds after launch or try again later.');
  }

  const tokenAmount = amount / info.price;

  user.positions.push({
    token: info.symbol || address.slice(0, 6) + '...',
    address: address,
    amount: tokenAmount,
    buyPrice: info.price
  });
  user.balance -= amount;
  await updateUser(ctx.from.id, user);

  const msg = `
Bought $${amount} of ${info.symbol || 'new token'}

Name: ${info.name}
Symbol: ${info.symbol || '—'}
Price: $${Number(info.price).toFixed(10)}
Liquidity: $${info.liquidity ? Number(info.liquidity).toFixed(0) : '—'}
Holders: ${info.holders || '—'}
Rug Risk: ${info.rugRisk || 'Unknown'}

New balance: $${user.balance.toFixed(2)}
  `.trim();

  ctx.replyWithMarkdown(msg);
  checkDrawdown(ctx.from.id, ctx);
});
// Webhook for Auto Payment (Helius)
app.post('/webhook', async (req, res) => {
  const txs = req.body;
  for (const tx of txs) {
    if (tx.type !== 'TRANSFER') continue;
    const transfer = tx.nativeTransfers?.[0];
    if (!transfer || transfer.toUserAccount !== process.env.WALLET_ADDRESS) continue;
    const amountSol = transfer.amount / 1e9;
    const memoInstruction = tx.instructions?.find(ins => ins.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXARzQArKDXP9s') ||
                            tx.innerInstructions?.flat()?.find(ins => ins.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXARzQArKDXP9s');
    if (!memoInstruction) continue;
    const memoData = bs58.decode(memoInstruction.data);
    const memo = new TextDecoder().decode(memoData);
    if (!memo.startsWith('challenge_')) continue;
    const [_, userIdStr, payAmtStr] = memo.split('_');
    const userId = parseInt(userIdStr);
    const payAmt = parseFloat(payAmtStr);
    if (isNaN(userId) || isNaN(payAmt) || amountSol < payAmt / 150) continue;  // Rough SOL equiv (adjust for price)
    const virtual = payAmt * 10;
    const target = virtual * 2.3;
    const bounty = payAmt * 7;
    await setPaidDynamic(userId, payAmt, virtual, target, bounty);
  }
  res.status(200).json({ success: true });
});

// Cron for Checks
cron.schedule('*/5 * * * *', async () => {
  db.all('SELECT * FROM users WHERE failed=0 AND paid=1', async (err, rows) => {
    for (let row of rows) {
      if (Date.now() - new Date(row.start_date) > 10 * 24 * 60 * 60 * 1000) await failUser(row.user_id);
      // Add inactivity check if needed
    }
  });
});

// Create Helius Webhook on Start
async function createHeliusWebhook() {
  try {
    await axios.post(`https://api.helius.xyz/v0/webhooks?api-key=${process.env.HELIUS_API_KEY}`, {
      webhookURL: `${process.env.WEBHOOK_URL || 'https://your-bot.onrender.com'}/webhook`,
      transactionTypes: ['ANY'],
      accountAddresses: [process.env.WALLET_ADDRESS],
      webhookType: 'enhanced'
    });
    console.log('Webhook created.');
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
}
createHeliusWebhook();

// Launch
bot.launch();
app.listen(process.env.PORT || 3000, () => console.log('Bot live on port 3000'));
