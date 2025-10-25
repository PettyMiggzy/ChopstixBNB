// Feast Hall Monk Bot — FULL BUILD for Render (Web Service)
// Features:
//  - Bilingual CN/EN throughout
//  - Join gate (must be in group to claim)
//  - /offer (tweet -> paste URL -> claim 1/day)
//  - /referrals (shows personal referral link & count)
//  - /feast (simple leaderboard: claims + referrals*3)
//  - /bind (run inside group to bind it), /whereami, /ping
//  - Hourly reminder in bound group (configurable)
//  - Persistent JSON DB via DB_FILE (use Render Disk at /data)
//  - Keep-alive HTTP server so Render doesn't kill the process

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import fs from 'fs';

// ------------------- Keep-alive Web Server (required on Render Web) ------
const app = express();
app.get('/', (_, res) => res.send('Feast Hall Monk Bot is alive'));
app.get('/health', (_, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Keep-alive server listening on :${PORT}`));

// ---------------------------- ENV ----------------------------------------
const BOT_TOKEN      = process.env.BOT_TOKEN;             // e.g. 1234:AA...
const BOT_USERNAME   = process.env.BOT_USERNAME;          // e.g. FeastofHallMonkBot (NO @)
const COMMUNITY_LINK = process.env.COMMUNITY_LINK || 'https://t.me/ChopstixsBNB';
const GROUP_ID       = Number(process.env.GROUP_ID || 0); // e.g. -100xxxxxxxxxx
const DB_FILE        = process.env.DB_FILE || './data.json';
const REMIND_MIN     = Number(process.env.REMIND_EVERY_MINUTES || 60);

if (!BOT_TOKEN || !BOT_USERNAME) throw new Error('Missing BOT_TOKEN or BOT_USERNAME in env');

// ---------------------------- BOT ----------------------------------------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90000 });

// ------------------------ Tiny JSON "DB" (persistent) --------------------
let DB = {
  users: {},        // uid -> { referredBy?:string, refs:[], claims:{'YYYY-MM-DD':true}, tweet?:{date,url} }
  lastSeen: {},     // uid -> ISO
  boundGroup: GROUP_ID || null // allow binding via /bind or use env GROUP_ID
};
try { if (fs.existsSync(DB_FILE)) DB = { ...DB, ...JSON.parse(fs.readFileSync(DB_FILE,'utf8')||'{}') }; }
catch(e){ console.error('DB load error:', e.message); }
function saveDB(){ try{ fs.writeFileSync(DB_FILE, JSON.stringify(DB,null,2)); }catch(e){ console.error('DB save error:', e.message); } }
function today(){ return new Date().toISOString().slice(0,10); }
function touch(uid){ DB.lastSeen[uid] = new Date().toISOString(); if(!DB.users[uid]) DB.users[uid] = { refs:[], claims:{} }; saveDB(); }
function user(uid){ if(!DB.users[uid]) DB.users[uid] = { refs:[], claims:{} }; return DB.users[uid]; }

const WAITING_TWEET = new Set(); // users waiting to paste tweet URL

// --------------------------- Helpers -------------------------------------
function both(zh, en){ return `${zh}\n${en}`; }
function refLink(uid){ return `https://t.me/${BOT_USERNAME}?start=ref_${uid}`; }
function looksLikeTweetURL(s){ return /^https?:\/\/(x|twitter)\.com\/[^\/]+\/status\/\d+/.test((s||'').trim()); }
function isAllowedGroupId(id){ return !!(DB.boundGroup && id === DB.boundGroup); }

// robust membership check:
// 1) If command sent inside bound group => pass
// 2) Else query bound group membership
async function isMember(ctx, uid){
  const gid = DB.boundGroup || GROUP_ID;
  if(!gid) return true; // no group set -> skip gate
  if (ctx.chat && isAllowedGroupId(ctx.chat.id)) return true;
  try{
    const m = await ctx.telegram.getChatMember(gid, uid);
    return ['member','creator','administrator','restricted'].includes(m.status);
  }catch{
    return false;
  }
}

// --------------------------- /start (ref capture) ------------------------
bot.start(async (ctx) => {
  const uid = String(ctx.from.id);
  touch(uid);
  const payload = (ctx.startPayload || '').trim();
  if (payload.startsWith('ref_')) {
    const hostUid = payload.slice(4);
    if (hostUid !== uid) {
      const me = user(uid);
      if (!me.referredBy) {
        me.referredBy = hostUid;
        const host = user(hostUid);
        if (!host.refs.includes(uid)) host.refs.push(uid);
        saveDB();
        // best-effort notify host in DM
        try {
          await ctx.telegram.sendMessage(Number(hostUid), both(
            `🎉 你的邀请链接新增一位来客：${ctx.from.first_name || ''}`,
            `🎉 New referral joined via your link: ${ctx.from.first_name || ''}`
          ));
        } catch {}
      }
    }
  }

  const rl = refLink(uid);
  await ctx.reply(
    both('🙏 欢迎来到筷子宴！','🙏 Welcome to the Feast Hall!') + '\n\n' +
    both('使用 /offer 领取每日供奉（需加入群）','Use /offer to claim daily offering (must join group).') + '\n' +
    both('使用 /referrals 查看你的邀请与专属链接','Use /referrals to view your referrals & link.') + '\n\n' +
    both('📎 你的邀请链接：','📎 Your referral link:') + `\n${rl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('加入筷子宴 · Join Feast Hall', COMMUNITY_LINK)],
      [
        Markup.button.callback('领取供奉 · Claim (/offer)', 'offer_btn'),
        Markup.button.callback('筷子宴榜单 · Feast (/feast)', 'feast_btn')
      ],
      [
        Markup.button.callback('我的邀请 · My Referrals', 'refs_btn'),
        Markup.button.url('发推 · Tweet', `https://twitter.com/intent/tweet?text=${encodeURIComponent('JUST CLAIMED ANOTHER OFFERING 💸\nRISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n'+rl)}`)
      ]
    ])
  );
});

// --------------------------- Diagnostics ---------------------------------
bot.command('whereami', async (ctx)=> ctx.reply(`Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}\nBound: ${DB.boundGroup||'(none)'}\nGROUP_ID env: ${GROUP_ID||'(none)'}`));
bot.command('ping', (ctx)=> ctx.reply('pong'));

// --------------------------- /bind (run inside group) --------------------
bot.command('bind', async (ctx) => {
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'){
    DB.boundGroup = ctx.chat.id;
    saveDB();
    await ctx.reply(`✅ 已绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\n链接 / Link = ${COMMUNITY_LINK}`);
  } else {
    await ctx.reply(both('⚙️ 请在目标群里发送 /bind 进行绑定。','⚙️ Send /bind inside the target group to bind.'));
  }
});

// --------------------------- /offer (tweet-gated daily) ------------------
bot.command('offer', async (ctx) => {
  const uid = String(ctx.from.id);
  touch(uid);

  if (!(await isMember(ctx, Number(uid)))) {
    return ctx.reply(
      both('⚠️ 你必须先加入筷子宴群才能领取供奉。','⚠️ You must join the Feast Hall before claiming.'),
      Markup.inlineKeyboard([[Markup.button.url('加入群 · Join Group', COMMUNITY_LINK)]])
    );
  }

  const me = user(uid);
  const d = today();
  if (me.claims && me.claims[d]) {
    const url = me.tweet?.url ? `\n🔗 Tweet: ${me.tweet.url}` : '';
    return ctx.reply(both('✅ 今日已领取。','✅ Already claimed today.') + url);
  }

  // ask to tweet then paste URL
  WAITING_TWEET.add(uid);
  const rl = refLink(uid);
  const tweetText =
    `JUST CLAIMED ANOTHER OFFERING 💸\n` +
    `RISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n` +
    `${rl}`;
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  return ctx.reply(
    both(
      '🕊️ 领取前：请先发推并包含你的邀请链接，然后把推文链接粘贴到这里验证。',
      '🕊️ Before claiming: post a tweet with your referral link, then paste the tweet URL here to verify.'
    ) + '\n\n' +
    both('要求：包含 “JUST CLAIMED ANOTHER OFFERING” / @ChopstixsBNB / 你的邀请链接：','Requirements: include the slogan, @ChopstixsBNB, and your referral link:') +
    `\n${rl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('发推 · Tweet now', intent)],
      [Markup.button.callback('我已发推 · I tweeted — Verify', 'verify_btn')]
    ])
  );
});

// Inline buttons
bot.action('offer_btn', (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/offer'); });
bot.action('feast_btn', (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/feast'); });
bot.action('refs_btn',  (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/referrals'); });
bot.action('verify_btn',(ctx)=> { ctx.answerCbQuery(); WAITING_TWEET.add(String(ctx.from.id)); ctx.reply(both('把你的推文链接发过来。','Paste your tweet URL here.')); });

// Capture pasted tweet URL & record claim
bot.on('text', async (ctx) => {
  const uid = String(ctx.from.id);
  if (!WAITING_TWEET.has(uid)) return;

  const url = (ctx.message.text || '').trim();
  if (!looksLikeTweetURL(url)) {
    return ctx.reply(both('这不像推文链接，请再试一次。','That does not look like a tweet URL. Try again.'));
  }

  const me = user(uid);
  const d = today();
  if (me.claims && me.claims[d]) {
    WAITING_TWEET.delete(uid);
    return ctx.reply(both('✅ 今日已领取。','✅ Already claimed today.'));
  }

  me.claims = me.claims || {};
  me.claims[d] = true;
  me.tweet = { date: new Date().toISOString(), url };
  WAITING_TWEET.delete(uid);
  saveDB();

  return ctx.reply(both('✅ 已验证！今日供奉已记录。','✅ Verified! Today’s offering recorded.') + `\n🔗 ${url}`);
});

// --------------------------- /referrals ----------------------------------
bot.command('referrals', async (ctx) => {
  const uid = String(ctx.from.id);
  touch(uid);
  const me = user(uid);
  const link = refLink(uid);
  const count = (me.refs || []).length;
  await ctx.reply(
    both('📜 你的邀请链接：','📜 Your referral link:') + `\n${link}\n\n` +
    both(`👥 已邀请：${count} 人`,`👥 Referrals: ${count}`),
    Markup.inlineKeyboard([[Markup.button.url('复制发推 · Tweet', `https://twitter.com/intent/tweet?text=${encodeURIComponent(link)}`)]])
  );
});

// --------------------------- /feast (leaderboard) ------------------------
bot.command('feast', async (ctx) => {
  // Score = claims + referrals*3
  const rows = Object.entries(DB.users).map(([uid, u])=>{
    const claims = Object.keys(u.claims || {}).length;
    const refs   = (u.refs || []).length;
    return { uid, claims, refs, score: claims + refs*3 };
  }).sort((a,b)=> b.score - a.score).slice(0,15);

  const zh = rows.length ? rows.map((r,i)=> `${i+1}. ${r.uid} — 供奉${r.claims}次 · 邀请${r.refs}人 · 分数${r.score}`).join('\n') : '暂无数据。';
  const en = rows.length ? rows.map((r,i)=> `${i+1}. ${r.uid} — claims ${r.claims} · refs ${r.refs} · score ${r.score}`).join('\n') : 'No entries yet.';
  await ctx.reply(`🍜 筷子宴榜单 / Feast Board (Top 15)\n${zh}\n\n${en}`);
});

// --------------------------- /help ---------------------------------------
bot.help(async (ctx)=>{
  await ctx.reply(
    '帮助 / Help\n' +
    '1) 加入群组 → /offer → 发推并粘贴推文链接 → 领取\n' +
    '2) /referrals 获取你的专属邀请链接\n' +
    '3) /feast 查看榜单\n\n' +
    '1) Join group → /offer → Tweet & paste URL → claim\n' +
    '2) /referrals for your personal link\n' +
    '3) /feast for the board'
  );
});

// ---------------------- Hourly reminder (cron) ---------------------------
function boundGroup(){ return DB.boundGroup || GROUP_ID || null; }
if (REMIND_MIN > 0) {
  cron.schedule(`*/${Math.max(5, REMIND_MIN)} * * * *`, async () => {
    const gid = boundGroup();
    if (!gid) return;
    try {
      await bot.telegram.sendMessage(
        gid,
        both('⏰ 每小时提醒：用 /offer 发推并领取今日供奉！','⏰ Hourly: use /offer — tweet then claim today’s offering!'),
        { reply_markup: { inline_keyboard: [[{ text: '立即领取 · Claim Now', callback_data: 'offer_btn' }]] } }
      );
    } catch (e) { console.log('reminder error:', e.message); }
  });
}

// --------------------------- Launch & Signals ----------------------------
bot.launch().then(()=>{
  console.log('🚀 Feast Hall Monk Bot is live.');
  console.log('Bound Group:', DB.boundGroup ?? '(none — run /bind in your group)');
  console.log('DB file:', DB_FILE);
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
