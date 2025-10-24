// Feast Hall Monk Bot — Webhook/Local Hybrid
// Features: /start, /offer (tweet-to-claim), referrals, join gate, hourly reminder, /bind, /where, bilingual ZH/EN
// Run locally (polling): node index.js
// Run on Render (webhook): set WEBHOOK_URL + PORT env and deploy

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import fs from 'fs';

// ===== Config =====
const BOT_TOKEN    = process.env.BOT_TOKEN;
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '');
const ENV_GID      = process.env.FEAST_GROUP_ID ? Number(process.env.FEAST_GROUP_ID) : null;

// Default group link (your community)
const DEFAULT_GROUP_LINK = 'https://t.me/ChopstixsBNB';

// Webhook config (for Render)
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';  // e.g. https://your-bot.onrender.com
const PORT        = Number(process.env.PORT || 0);  // Render provides this
const SECRET_PATH = process.env.SECRET_PATH || `/bot${Math.random().toString(36).slice(2,10)}`; // optional secret

if (!BOT_TOKEN || !BOT_USERNAME) {
  throw new Error('Missing BOT_TOKEN or BOT_USERNAME in .env');
}

const bot = new Telegraf(BOT_TOKEN);

// ===== Tiny JSON DB =====
const DB_FILE = './db.json';
function loadDB() {
  try {
    const raw = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : '';
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      users:      parsed.users      || {},
      referredBy: parsed.referredBy || {},
      referrals:  parsed.referrals  || {},
      claims:     parsed.claims     || {},
      lastSeen:   parsed.lastSeen   || {},
      config:     parsed.config     || { groupId: ENV_GID || null, groupLink: parsed?.config?.groupLink || DEFAULT_GROUP_LINK }
    };
  } catch {
    return { users:{}, referredBy:{}, referrals:{}, claims:{}, lastSeen:{}, config:{ groupId: ENV_GID || null, groupLink: DEFAULT_GROUP_LINK } };
  }
}
const DB = loadDB();
const saveDB = ()=> fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));

// ===== Helpers =====
const today   = ()=> new Date().toISOString().slice(0,10);
const both    = (zh, en)=> `${zh}\n${en}`;
const isNum   = (x)=> /^\d+$/.test(String(x));
const refKey  = (id)=> `ref_${id}`;
const linkFor = (uid)=> `https://t.me/${BOT_USERNAME}?start=${refKey(uid)}`;
const dname   = (u)=> `${u.first_name||''}${u.last_name?(' '+u.last_name):''}${u.username?(' (@'+u.username+')'):''}`.trim();
const boundGroupId   = ()=> DB.config.groupId ?? null;
const boundGroupLink = ()=> DB.config.groupLink || DEFAULT_GROUP_LINK;

function touch(uid){ DB.lastSeen[uid] = new Date().toISOString(); saveDB(); }

function tweetPack(uid){
  const link = linkFor(uid);
  const text = `JUST CLAIMED ANOTHER OFFERING 💸
RISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB
${link}`;
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  return { link, text, intent };
}

async function isMember(ctx){
  const gid = boundGroupId();
  if (!gid) return false;
  try{
    const m = await ctx.telegram.getChatMember(gid, ctx.from.id);
    return ['member','administrator','creator'].includes(m.status);
  }catch(e){
    console.log('getChatMember error:', e?.description || e?.message);
    return false;
  }
}
async function requireJoin(ctx, next){
  const gid = boundGroupId();
  const glink = boundGroupLink();
  if (!gid) {
    await ctx.reply(
      both('尚未绑定筷子宴群组。请在目标群里发送 /bind。','Feast Hall group not bound yet. Send /bind inside your target group.'),
      Markup.inlineKeyboard([[Markup.button.url('加入 ChopstixsBNB 群 · Join Group', glink)]])
    );
    return;
  }
  if(!(await isMember(ctx))){
    await ctx.reply(
      both('请先加入我们的群组以继续。','Join our group to continue.'),
      Markup.inlineKeyboard([
        [Markup.button.url('进入筷子宴 · Join Feast Hall', glink)],
        [Markup.button.callback('我已加入 · I have joined', 'verify_join')]
      ])
    );
    return;
  }
  return next();
}

// Keyboards
function kbHome(uid){
  const { intent, link } = tweetPack(uid);
  const glink = boundGroupLink();
  return Markup.inlineKeyboard([
    [Markup.button.url('进入筷子宴 · Join Feast Hall', glink)],
    [
      Markup.button.callback('领取供奉 · Claim (/offer)', 'offer_flow'),
      Markup.button.callback('筷子宴榜单 · Feast (/feast)', 'feast_board')
    ],
    [
      Markup.button.callback('我的邀请 · My Referrals', 'my_referrals'),
      Markup.button.callback('我的链接 · My Link', 'my_ref_link')
    ],
    [Markup.button.url('发推 · Tweet', intent), Markup.button.url('邀请链接 · Referral', link)]
  ]);
}
function kbOfferGate(uid){
  const { intent, link } = tweetPack(uid);
  return Markup.inlineKeyboard([
    [Markup.button.url('🧵 发推 · Tweet Now', intent)],
    [Markup.button.callback('我已发推，领取供奉 · I tweeted, claim now', 'confirm_tweet')],
    [Markup.button.url('邀请链接 · Referral Link', link)]
  ]);
}

// /start — capture referral
bot.start(async (ctx)=>{
  const me = ctx.from.id.toString();
  DB.users[me] = DB.users[me] || { username: ctx.from.username||'', first_name: ctx.from.first_name||'' };

  const payload = (ctx.startPayload || '').trim();
  if (payload.startsWith('ref_')) {
    const inviter = payload.slice(4);
    if (isNum(inviter) && inviter !== me && !DB.referredBy[me]) {
      DB.referredBy[me] = inviter;
      DB.referrals[inviter] = (DB.referrals[inviter] || 0) + 1;
      saveDB();
      try {
        await ctx.telegram.sendMessage(Number(inviter),
          both(`🎉 新邀请加入：${dname(ctx.from)}`, `🎉 New referral joined: ${dname(ctx.from)}`));
      } catch {}
    }
  }
  touch(me);

  const glink = boundGroupLink();
  if(!boundGroupId()){
    await ctx.reply(
      both('🧧 欢迎来到筷子宴！请在目标群发送 /bind 绑定群组，或先加入默认社区群后再使用。', '🧧 Welcome! Send /bind inside your target group to bind, or join our default community group first.'),
      Markup.inlineKeyboard([[Markup.button.url('加入 ChopstixsBNB 群 · Join Group', glink)]])
    );
    return;
  }

  const { link } = tweetPack(me);
  await ctx.reply(
    both(`欢迎！你的邀请链接：\n${link}`, `Welcome! Your referral link:\n${link}`),
    kbHome(me)
  );
});

// verify join
bot.action('verify_join', async (ctx)=>{
  await ctx.answerCbQuery();
  const me = ctx.from.id.toString();
  if(!(await isMember(ctx))){
    const glink = boundGroupLink();
    await ctx.editMessageText(
      both('仍未检测到加入，请先加入群组，再点击“我已加入”。','Still not a member. Join the group, then tap “I have joined”.'),
      Markup.inlineKeyboard([
        [Markup.button.url('进入筷子宴 · Join Feast Hall', glink)],
        [Markup.button.callback('我已加入 · I have joined', 'verify_join')]
      ])
    );
    return;
  }
  const { link } = tweetPack(me);
  await ctx.editMessageText(
    both(`✅ 已验证加入！你的邀请链接：\n${link}`, `✅ Membership verified! Your referral link:\n${link}`),
    kbHome(me)
  );
});

// /offer — tweet-to-claim (1/day)
bot.command('offer', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  const key = `${me}:${today()}`;
  if (DB.claims[key]) {
    const { text, intent, link } = tweetPack(me);
    await ctx.reply(
      both('今日已领取。你仍可发推分享你的邀请链接：','You already claimed today. You can still tweet and share your link:') +
      `\n\n${text}`,
      Markup.inlineKeyboard([
        [Markup.button.url('🧵 再发一条 · Tweet Again', intent)],
        [Markup.button.url('邀请链接 · Referral Link', link)]
      ])
    );
    return;
  }
  const { text } = tweetPack(me);
  await ctx.reply(
    both('领取前须先发推（自动带上你的邀请链接）。发推后点击“我已发推”。','Before claiming, please tweet (auto-fills your referral link). After tweeting, tap “I tweeted”.') +
    `\n\n${text}`,
    kbOfferGate(me)
  );
});

// Button mirror for /offer
bot.action('offer_flow', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  const key = `${me}:${today()}`;
  await ctx.answerCbQuery();
  if (DB.claims[key]) {
    const { text, intent, link } = tweetPack(me);
    await ctx.editMessageText(
      both('今日已领取。你仍可发推分享你的邀请链接：','You already claimed today. You can still tweet and share your link:') +
      `\n\n${text}`,
      Markup.inlineKeyboard([
        [Markup.button.url('🧵 再发一条 · Tweet Again', intent)],
        [Markup.button.url('邀请链接 · Referral Link', link)]
      ])
    );
    return;
  }
  const { text } = tweetPack(me);
  await ctx.editMessageText(
    both('领取前须先发推（自动带上你的邀请链接）。发推后点击“我已发推”。','Before claiming, please tweet (auto-fills your referral link). After tweeting, tap “I tweeted”.') +
    `\n\n${text}`,
    kbOfferGate(me)
  );
});

// Confirm tweet → record claim
bot.action('confirm_tweet', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  const key = `${me}:${today()}`;
  if (DB.claims[key]) {
    await ctx.answerCbQuery(both('今日已领取','Already claimed today'), { show_alert: true });
    return;
  }
  DB.claims[key] = 1; saveDB();
  await ctx.answerCbQuery('✅');
  const { text, intent, link } = tweetPack(me);
  await ctx.editMessageText(
    both('🥢 已领取今日供奉！继续发推邀请好友，升级以获得更高奖励。','🥢 Daily Offering claimed! Keep tweeting & inviting to climb tiers.') + `\n\n${text}`,
    Markup.inlineKeyboard([
      [Markup.button.url('🧵 再发一条 · Tweet Again', intent)],
      [Markup.button.url('邀请链接 · Referral Link', link)]
    ])
  );
});

// Info commands
bot.command('referrals', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  const n = DB.referrals[me] || 0;
  await ctx.reply(both(`你的邀请：${n} 位`,`Your referrals: ${n}`));
});
bot.command('myref', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  await ctx.reply(both(`你的邀请链接：\n${linkFor(me)}`, `Your referral link:\n${linkFor(me)}`));
});
bot.command('feast', requireJoin, async (ctx)=>{
  const claimCount = {};
  Object.keys(DB.claims).forEach(k=>{
    const uid = k.split(':')[0];
    claimCount[uid] = (claimCount[uid]||0) + 1;
  });
  const rows = Object.keys(DB.users).map(uid=>{
    const claims = claimCount[uid] || 0;
    const refs = DB.referrals[uid] || 0;
    const score = claims + refs*3;
    return { uid, claims, refs, score };
  }).sort((a,b)=> b.score - a.score).slice(0,20);

  if(!rows.length) return ctx.reply(both('暂无榜单。','No entries yet.'));
  const zh = rows.map((r,i)=> `${i+1}. ${r.uid} — 供奉${r.claims}次 · 邀请${r.refs}人 · 分数${r.score}`).join('\n');
  const en = rows.map((r,i)=> `${i+1}. ${r.uid} — claims ${r.claims} · refs ${r.refs} · score ${r.score}`).join('\n');
  await ctx.reply(`🍜 筷子宴榜单（前20）：\n${zh}\n\n🍜 Feast Leaderboard (Top 20):\n${en}`);
});
bot.command('help', async (ctx)=>{
  await ctx.reply(both(
`指令：
/offer 领取供奉（需先发推） 
/myref 获取我的邀请链接
/referrals 查看我的邀请数量
/feast 查看榜单
/bind 在目标群绑定机器人
/where 显示当前聊天ID
/help 帮助`,
`Commands:
/offer Claim offering (tweet required)
/myref Get my referral link
/referrals See my referral count
/feast View leaderboard
/bind Bind the bot in your target group
/where Show current chat ID
/help Help`
  ));
});

// Menu callbacks
bot.action('my_referrals', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  const n = DB.referrals[me] || 0;
  await ctx.answerCbQuery();
  await ctx.editMessageText(both(`你的邀请：${n} 位`,`Your referrals: ${n}`), kbHome(me));
});
bot.action('my_ref_link', requireJoin, async (ctx)=>{
  const me = ctx.from.id.toString();
  await ctx.answerCbQuery();
  await ctx.editMessageText(both(`你的邀请链接：\n${linkFor(me)}`, `Your referral link:\n${linkFor(me)}`), kbHome(me));
});
bot.action('feast_board', requireJoin, async (ctx)=>{
  await ctx.answerCbQuery();
  const claimCount = {};
  Object.keys(DB.claims).forEach(k=>{
    const uid = k.split(':')[0];
    claimCount[uid] = (claimCount[uid]||0) + 1;
  });
  const rows = Object.keys(DB.users).map(uid=>{
    const claims = claimCount[uid] || 0;
    const refs = DB.referrals[uid] || 0;
    const score = claims + refs*3;
    return { uid, claims, refs, score };
  }).sort((a,b)=> b.score - a.score).slice(0,10);

  if(!rows.length){
    await ctx.editMessageText(both('暂无榜单。','No entries yet.'), kbHome(ctx.from.id.toString()));
    return;
  }
  const zh = rows.map((r,i)=> `${i+1}. ${r.uid} — 供奉${r.claims}次 · 邀请${r.refs}人 · 分数${r.score}`).join('\n');
  const en = rows.map((r,i)=> `${i+1}. ${r.uid} — claims ${r.claims} · refs ${r.refs} · score ${r.score}`).join('\n');
  await ctx.editMessageText(`🍜 筷子宴榜单（前10）：\n${zh}\n\n🍜 Feast Leaderboard (Top 10):\n${en}`, kbHome(ctx.from.id.toString()));
});

// /bind — run inside the target group
bot.command('bind', async (ctx)=>{
  if (ctx.chat.type !== 'supergroup' && ctx.chat.type !== 'group') {
    return ctx.reply(both('请在目标群里发送 /bind 进行绑定。','Send /bind inside the target group to bind.'));
  }
  DB.config.groupId = ctx.chat.id;
  if (!DB.config.groupLink) DB.config.groupLink = DEFAULT_GROUP_LINK;
  saveDB();
  await ctx.reply(`✅ 已绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\nLink = ${boundGroupLink()}`);
});

// /where — quick debug
bot.command('where', async (ctx)=>{
  await ctx.reply(`chat.id = ${ctx.chat.id}\nchat.type = ${ctx.chat.type}`);
});

// Hourly reminder (top of hour)
async function hourlyReminder(){
  const gid = boundGroupId();
  const glink = boundGroupLink();
  if (!gid) return;
  try{
    const zh = '⏰ 每小时提醒：输入 /offer 先发推再领取今日供奉。邀请好友可加速升级！';
    const en = '⏰ Hourly: use /offer — tweet, then claim today’s Offering. Invite friends to rank up!';
    await bot.telegram.sendMessage(gid, both(zh,en), {
      reply_markup: {
        inline_keyboard: [
          [{ text:'进入筷子宴 · Join Feast Hall', url: glink }],
          [{ text:'立即领取 · Claim Now', callback_data: 'offer_flow' }]
        ]
      }
    });
  }catch(e){ console.log('reminder error:', e.message); }
}
setInterval(()=>{
  const m = new Date();
  if(m.getMinutes() === 0) hourlyReminder();
}, 60*1000);

// ===== Launch: webhook in production, polling locally =====
if (WEBHOOK_URL && PORT) {
  const app = express();
  app.get('/', (_req, res)=> res.status(200).send('Feast Hall Monk Bot · OK'));
  app.use(express.json());
  app.use(bot.webhookCallback(SECRET_PATH));
  bot.telegram.setWebhook(`${WEBHOOK_URL}${SECRET_PATH}`)
    .then(()=> console.log(`🚀 Webhook set: ${WEBHOOK_URL}${SECRET_PATH}`))
    .catch(e => console.error('Webhook error:', e.message));
  app.listen(PORT, ()=> {
    console.log(`🥢 Bot server listening on :${PORT}`);
    console.log(`Username: @${BOT_USERNAME}`);
    console.log(`Bound Group ID: ${boundGroupId() ?? '(none yet — send /bind in your group)'}`);
  });
} else {
  bot.launch().then(()=>{
    console.log('🥢 Feast Hall Monk Bot running (polling).');
    console.log(`Username: @${BOT_USERNAME}`);
    console.log(`Bound Group ID: ${boundGroupId() ?? '(none yet — send /bind in your group)'}`);
  });
}

process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
