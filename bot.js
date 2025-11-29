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

async function getPrice(token) {
  try {
    const res = await axios.get(`https://public-api.birdeye.so/defi/price?address=${getTokenAddress(token)}`);
    return res.data.data.value;
  } catch (e) {
    return 0.001;  // Fallback
  }
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
  let total = user.balance;
  let msg = `💼 Portfolio\nCash: $${user.balance.toFixed(2)}\n\nPositions:\n`;
  for (let pos of user.positions) {
    const price = await getPrice(pos.token);
    const value = pos.amount * price;
    const unreal = value - (pos.amount * pos.buyPrice);
    total += value;
    msg += `${pos.token}: ${pos.amount.toFixed(2)} @ $${pos.buyPrice.toFixed(4)} → $${value.toFixed(2)} (${unreal > 0 ? '+' : ''}$${unreal.toFixed(2)})\n`;
  }
  msg += `\nTotal: $${total.toFixed(2)} / Target: $${user.target}`;
  ctx.reply(msg);
  checkDrawdown(ctx.from.id, ctx);
});

bot.command('rules', (ctx) => {
  ctx.reply(`📜 Rules:\n1. Pay $20-$50 for virtual balance (10x pay).\n2. Hit 2.3x target.\n3. Fixed bounty payout.\n4. 10 days max.\n5. -12% drawdown = fail.\n6. Max 25% per trade.\n7. 5 winners/day cap.\n8. No bots.\n9. Max 2 active.\n10. Final decision ours.`);
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
