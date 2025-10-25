// $ChopBot — ChopstixsBNBbot — Full featured Telegram bot WITH daily leader & summaries
// Features: claims (/offer), tweet intent with working preview link, referrals (DM),
// oracle/fortune, feast leaderboard, hourly reminders, anti-link/forward, admin tools,
// username display (no numeric IDs), daily auto leaderboard, daily claim summary,
// Render keep-alive.
//
// ENV REQUIRED: BOT_TOKEN, GROUP_ID, BOT_USERNAME
// ENV OPTIONAL: TWITTER_HANDLE, WEBSITE_URL, AURA_HOURS, CLAIM_COOLDOWN_MIN, PORT
//               DAILY_LEADER_HOUR, DAILY_SUMMARY_HOUR

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import http from 'http';

// ------------ ENV --------------
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GROUP_ID     = Number(process.env.GROUP_ID); // e.g. -10028xxxxxxxx
const BOT_USERNAME = process.env.BOT_USERNAME || 'ChopstixsBNBbot';
const TWITTER      = process.env.TWITTER_HANDLE || 'ChopstixsBNB';
const WEBSITE_URL  = process.env.WEBSITE_URL || 'https://www.ChopstixsBNB.com';
let   AURA_HOURS   = Number(process.env.AURA_HOURS || 24);
let   COOLDOWN_MIN = Number(process.env.CLAIM_COOLDOWN_MIN || 1440); // once/day
const DAILY_LEADER_HOUR  = Number(process.env.DAILY_LEADER_HOUR  || 20);
const DAILY_SUMMARY_HOUR = Number(process.env.DAILY_SUMMARY_HOUR || 23);
const PORT        = Number(process.env.PORT || 10000);

if (!BOT_TOKEN || !GROUP_ID || !BOT_USERNAME) {
  throw new Error('Missing required env: BOT_TOKEN, GROUP_ID, BOT_USERNAME');
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90_000 });

// ------------ DB --------------
const DB_PATH = './db.json';
const DB = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
if(!DB.users) DB.users = {};            // uid -> {username,name,joined,offers,refs,auraTill,lastOfferTs,refBy}
if(!DB.referrals) DB.referrals = {};    // inviterUid -> { referredUid: ts }
if(!DB.offers) DB.offers = {};          // "u:uid" -> lastClaimTs
if(!DB.tweets) DB.tweets = {};          // uid -> { waiting, url, ts }
if(!DB.aura) DB.aura = {};
if(!DB.lastSeen) DB.lastSeen = {};
if(typeof DB.reminderOn !== 'boolean') DB.reminderOn = true;
if(!DB.warnedLinks) DB.warnedLinks = {}; // uid -> true once warned
if(!DB.groupBound) DB.groupBound = false;
if(!DB.groupLink) DB.groupLink = '';
// Daily tracking
if(!DB.daily) DB.daily = { date: todayStr(), claims: [], counts: {} }; // per-day
if(!DB._posted) DB._posted = {}; // { 'YYYY-MM-DD': { leader:true, summary:true } }

saveDB();

function saveDB(){ fs.writeFileSync(DB_PATH, JSON.stringify(DB,null,2)); }
function touch(uid){ DB.lastSeen[uid] = new Date().toISOString(); saveDB(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }

function ensureDaily(){
  const d = todayStr();
  if(DB.daily?.date !== d){
    DB.daily = { date: d, claims: [], counts: {} };
    // reset posted flags for new date
    if(!DB._posted) DB._posted = {};
    DB._posted[d] = { leader:false, summary:false };
    saveDB();
  }
  if(!DB._posted[d]) DB._posted[d] = { leader:false, summary:false };
  return d;
}

// ------------ helpers --------------
function userRec(uid){
  if(!DB.users[uid]) DB.users[uid] = { id:uid, joined:Date.now(), offers:0, refs:0, auraTill:0, name:'', username:'' };
  return DB.users[uid];
}
function updateUserFromCtx(u, from){
  if(!from) return;
  const full = `${from.first_name||''} ${from.last_name||''}`.trim();
  if(from.username) u.username = from.username;
  if(full) u.name = full;
}
function displayUser(uid){
  const u = userRec(uid);
  if(u.username) return `@${u.username}`;
  if(u.name) return u.name;
  return `[user](tg://user?id=${uid})`;
}
function fmtMs(ms){
  const m = Math.ceil(ms/60000);
  if(m>=1440){ const d=Math.floor(m/1440); const r=m-d*1440; return `${d}d ${r}m`; }
  if(m>=60){ const h=Math.floor(m/60); const r=m-h*60; return `${h}h ${r}m`; }
  return `${m}m`;
}
function cooldownLeft(uid){
  const last = DB.offers[`u:${uid}`]||0;
  const left = last ? (last + COOLDOWN_MIN*60*1000) - Date.now() : 0;
  return Math.max(0,left);
}
async function isGroupAdmin(uid){
  try{
    const m = await bot.telegram.getChatMember(GROUP_ID, uid);
    return ['administrator','creator'].includes(m.status);
  }catch{ return false; }
}
async function ensureMember(uid){
  try{
    const m = await bot.telegram.getChatMember(GROUP_ID, uid);
    return ['member','administrator','creator'].includes(m.status);
  }catch{ return false; }
}

// ------------ tweet builder (uses proven preview link) --------------
function tweetIntent(/* uid */){
  const botLink = "https://t.me/ChopstixsBNBbot?ref=x1"; // stable link that unfurls
  const text = encodeURIComponent(
`${botLink}

JUST CLAIMED ANOTHER OFFERING 💸
RISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @${TWITTER}`
  );
  return `https://twitter.com/intent/tweet?text=${text}`;
}

// ------------ UI --------------
function mainMenu(ctx){
  const kb = [
    [Markup.button.url('网站 · Website', WEBSITE_URL), Markup.button.url('X · Twitter', `https://x.com/${TWITTER}`)],
    [Markup.button.callback('领取供奉 /offer','cb_offer'), Markup.button.callback('筷子宴榜单 /feast','cb_feast')],
    [Markup.button.callback('我的邀请 /referrals','cb_refs')],
    [Markup.button.callback('传说 /lore','cb_lore'), Markup.button.callback('神谕 /oracle','cb_oracle')]
  ];
  return ctx.reply(
`🙏 欢迎来到筷子宴 · Welcome to the Feast of $CHOP

• /offer 领取每日供奉（需入群 + 推文）
  Claim daily offering (must be group member + tweet)

• /referrals 获取私聊专属邀请链接
  Get your personal referral link in DM

• /feast 榜单 · /lore 传说 · /fortune 签语 · /oracle 神谕
• /stats 我的数据 · /burn 光环（外观）

${WEBSITE_URL}`, Markup.inlineKeyboard(kb));
}

// ------------ Anti-spam (group) --------------
bot.on('message', async (ctx, next)=>{
  touch(ctx.from.id);
  const uid = ctx.from.id;
  updateUserFromCtx(userRec(uid), ctx.from);
  saveDB();

  if(ctx.chat.id !== GROUP_ID) return next();

  // Block forwarded messages from non-admins
  const forwarded = ctx.message.forward_from || ctx.message.forward_from_chat;
  if(forwarded && !(await isGroupAdmin(uid))){
    try{ await ctx.deleteMessage(); }catch{}
    return;
  }

  // Block external links from non-admins (one-time warn)
  const text = ctx.message.text || ctx.message.caption || '';
  const hasLink = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text);
  if(hasLink && !(await isGroupAdmin(uid))){
    try{ await ctx.deleteMessage(); }catch{}
    if(!DB.warnedLinks[uid]){
      DB.warnedLinks[uid] = true; saveDB();
      try{
        await ctx.reply(
          `🚫 ${displayUser(uid)} 请勿在群内发链接 / No links in group. 继续将被静音。\n领取供奉请私聊：@${BOT_USERNAME}`,
          { parse_mode:'Markdown' }
        );
      }catch{}
    }
    return;
  }

  return next();
});

// ------------ Start & referrals --------------
bot.start(async (ctx)=>{
  const uid = ctx.from.id;
  const u = userRec(uid);
  updateUserFromCtx(u, ctx.from);
  touch(uid);

  // optional: parse /start payload "ref_xxx"
  if(ctx.startPayload && ctx.startPayload.startsWith('ref_')){
    const payload = ctx.startPayload.slice(4);
    const inviter = Number(Buffer.from(payload, 'base64url').toString() || 0);
    if(inviter && inviter !== uid){
      if(!u.refBy) u.refBy = inviter;
      if(!DB.referrals[inviter]) DB.referrals[inviter] = {};
      if(!DB.referrals[inviter][uid]){
        DB.referrals[inviter][uid] = Date.now();
        userRec(inviter).refs++;
      }
      saveDB();
    }
  }

  return mainMenu(ctx);
});

bot.action('cb_offer', (ctx)=> ctx.answerCbQuery().then(()=> offerEntry(ctx)));
bot.action('cb_refs',  (ctx)=> ctx.answerCbQuery().then(()=> sendReferralDM(ctx)));
bot.action('cb_lore',  (ctx)=> ctx.answerCbQuery().then(()=> lore(ctx)));
bot.action('cb_feast', (ctx)=> ctx.answerCbQuery().then(()=> feast(ctx)));
bot.action('cb_oracle',(ctx)=> ctx.answerCbQuery().then(()=> oracle(ctx)));

bot.command('menu', mainMenu);

// ------------ Content commands --------------
function lore(ctx){
  const uid = ctx.from.id;
  updateUserFromCtx(userRec(uid), ctx.from); saveDB();
  return ctx.reply(
`📜 筷子传说 · The Legend of Chopstix

“左筷为勇，右筷为智；双筷并举，财富自来。”
"The left chopstick is courage, the right is wisdom — together they lift fortune."

更多 · More: ${WEBSITE_URL}`,
    Markup.inlineKeyboard([[Markup.button.url('阅读全文 · Read full', WEBSITE_URL)]])
  );
}
bot.command('lore', lore);

function oracle(ctx){
  const uid=ctx.from.id; updateUserFromCtx(userRec(uid), ctx.from); saveDB();
  const O=['龙曰：','师父言：','炉火传讯：','钟声回荡：'];
  const A=['红灯未灭，心火勿旺。','米袋渐满，不必急食。','筹码如潮，退亦是进。','竹影东移，时至自明。'];
  const B=['看一日线，慎一小时心。','小胜亦胜，切莫求满。','手稳如筷，步轻如风。','与众同宴，勿独食。'];
  const zh=`${O[Math.floor(Math.random()*O.length)]}${A[Math.floor(Math.random()*A.length)]}${B[Math.floor(Math.random()*B.length)]}`;
  const en=['Calm your fire under red lanterns.','A small win is still a win.','Hold steady like chopsticks; move lightly.','Share the feast; do not eat alone.'][Math.floor(Math.random()*4)];
  return ctx.reply(`🧙‍♂️ 筷子神谕\n${zh}\n\nOracle: ${en}`);
}
bot.command('oracle', oracle);

bot.command('fortune', (ctx)=>{
  const uid=ctx.from.id; updateUserFromCtx(userRec(uid), ctx.from); saveDB();
  const picks=[
    ['龙须拂盘，金粒自聚。','Dragon whisk sweeps — grains of gold gather.'],
    ['红灯常明，心定财来。','When the red lantern glows, calm brings fortune.'],
    ['左勇右智，筷起富至。','Courage left, wisdom right — lift and wealth arrives.'],
    ['守得云开，方见金鳞。','Hold through the clouds and see golden scales.'],
  ];
  const [zh,en]=picks[Math.floor(Math.random()*picks.length)];
  return ctx.reply(`🥠 财富签语\n${zh}\n${en}`);
});

bot.command('stats', (ctx)=>{
  const uid=ctx.from.id; const u=userRec(uid); updateUserFromCtx(u, ctx.from); saveDB();
  const auraLeft=Math.max(0,(u.auraTill||0)-Date.now());
  return ctx.reply(
`📊 统计 · Stats
Offers: ${u.offers||0}
Referrals: ${u.refs||0}
Aura: ${auraLeft?fmtMs(auraLeft):'off'}
Joined: ${new Date(u.joined).toLocaleString()}

(Your referral link is sent **by DM** with /referrals)`
  );
});

bot.command('burn', (ctx)=>{
  const uid=ctx.from.id; const u=userRec(uid); updateUserFromCtx(u, ctx.from);
  u.auraTill = Date.now() + AURA_HOURS*3600*1000; saveDB();
  return ctx.reply(`✨ 光环已点亮 · Aura on for ${AURA_HOURS}h (cosmetic).`);
});

bot.command('referrals', sendReferralDM);
async function sendReferralDM(ctx){
  const uid=ctx.from.id; const u=userRec(uid); updateUserFromCtx(u, ctx.from); saveDB();
  try{
    await bot.telegram.sendMessage(uid,
`🔗 邀请 · Referrals

你的邀请链接（仅私聊展示） · Your referral link (DM only):
https://t.me/${BOT_USERNAME}?start=ref_${Buffer.from(String(uid)).toString('base64url')}

邀请人数 Ref count: ${u.refs||0}`,
      { disable_web_page_preview:true }
    );
    if(ctx.chat.id === GROUP_ID){
      await ctx.reply('🔐 已私信你的邀请链接 · I DM’d you your referral link.');
    }
  }catch{
    if(ctx.chat.id === GROUP_ID){
      await ctx.reply(`请先私聊我启动机器人，然后再用 /referrals。\nOpen DM: https://t.me/${BOT_USERNAME}`);
    } else {
      await ctx.reply('无法发送私信，请检查隐私设置。');
    }
  }
}

// ------------ Feast leaderboard --------------
function feast(ctx){
  const uid=ctx.from.id; updateUserFromCtx(userRec(uid), ctx.from); saveDB();
  const list=Object.values(DB.users)
    .sort((a,b)=>(b.offers||0)-(a.offers||0))
    .slice(0,15)
    .map((u,i)=>`${i+1}. ${u.username?('@'+u.username):(u.name||u.id)} — ${u.offers||0} offers, ${u.refs||0} refs`)
    .join('\n') || 'No data yet.';
  return ctx.reply(`🍜 筷子宴榜单 · Feast Hall Leaderboard\n${list}`);
}
bot.command('feast', feast);

// ------------ OFFER flow (DM only) --------------
bot.command('offer', (ctx)=> offerEntry(ctx));

async function offerEntry(ctx){
  const uid=ctx.from.id; const u=userRec(uid); updateUserFromCtx(u, ctx.from); saveDB();

  // Only in DM
  if(ctx.chat.type !== 'private'){
    return ctx.reply(
`⚠️ 领取供奉请在私聊进行 / Claim in DM only.
👉 @${BOT_USERNAME}`,
      { disable_web_page_preview:true }
    );
  }

  // must be a member of the group
  if(!(await ensureMember(uid))){
    const link = DB.groupLink || 'https://t.me/ChopstixsBNB';
    return ctx.reply(
`请先加入官方社群再领取。
Join the group first to claim.`,
      Markup.inlineKeyboard([[Markup.button.url('加入社群 · Join Group', link)]])
    );
  }

  const left = cooldownLeft(uid);
  if(left>0){
    return ctx.reply(`🕓 今日已领 · Already claimed. Come back in ${fmtMs(left)}.`);
  }

  // Step 1: open tweet intent
  const url = tweetIntent(uid);
  await ctx.reply(
`点此发推（自动带机器人链接）。
Tap to tweet (auto-includes the bot link):\n\n${url}\n\n发布后把推文链接粘贴在这里完成领取。
After posting, paste your tweet URL here to complete.`,
    { disable_web_page_preview:false }
  );

  // Wait for tweet URL
  DB.tweets[uid] = { waiting:true, ts:Date.now() }; saveDB();
}

// Catch tweet URL in DM replies
bot.on('text', async (ctx, next)=>{
  if(ctx.chat.type !== 'private') return next();
  const uid = ctx.from.id;

  if(!DB.tweets[uid]?.waiting) return next();

  const raw = (ctx.message.text||'').trim();
  const ok = /^(https?:\/\/)?(x\.com|twitter\.com)\/.+/i.test(raw);
  if(!ok){
    return ctx.reply('需要推文链接 · Please paste your tweet URL (x.com/twitter.com).');
  }

  // record claim + aura
  DB.offers[`u:${uid}`] = Date.now();
  const u = userRec(uid); u.offers=(u.offers||0)+1; u.auraTill=Date.now()+AURA_HOURS*3600*1000;

  // ---- DAILY RECORD ----
  const d = ensureDaily();
  DB.daily.claims.push({ uid, url: raw, ts: Date.now() });
  DB.daily.counts[uid] = (DB.daily.counts[uid]||0) + 1;

  DB.tweets[uid] = { waiting:false, url:raw, ts:Date.now() }; saveDB();

  await ctx.reply(`✅ 已记录推文 · Claim recorded! Aura on for ${AURA_HOURS}h. See /stats`);

  // Announce in group
  try{
    await bot.telegram.sendMessage(
      GROUP_ID,
      `🎉 ${displayUser(uid)} 领取供奉成功 · Claimed an offering!\n${raw}`,
      { disable_web_page_preview:true, parse_mode:'Markdown' }
    );
  }catch{}
});

// ------------ Bind to the real group --------------
bot.command('bind', async (ctx)=>{
  if(ctx.chat.type==='private'){
    return ctx.reply('在目标群组里发送 /bind。\nSend /bind in the target group.');
  }
  if(ctx.chat.id !== GROUP_ID){
    return ctx.reply(`此群ID与配置不匹配。\nThis chat ID ${ctx.chat.id} != GROUP_ID ${GROUP_ID}.\nUpdate GROUP_ID then retry.`);
  }
  // Require admin
  try{
    const me = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if(!['administrator','creator'].includes(me.status)){
      return ctx.reply('需要管理员权限运行 /bind · Admin only.');
    }
  }catch{ return ctx.reply('无法验证管理员权限，请把我设为管理员再试。'); }

  DB.groupBound = true;
  DB.groupLink  = ctx.chat.username ? `https://t.me/${ctx.chat.username}` : DB.groupLink;
  saveDB();
  return ctx.reply(`✅ 已绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\nLink = ${DB.groupLink || '(no public link)'}`);
});

// ------------ Welcome new members --------------
bot.on('new_chat_members', async (ctx)=>{
  if(ctx.chat.id !== GROUP_ID) return;
  for (const m of ctx.message.new_chat_members){
    if(m.is_bot) continue;
    try{
      await ctx.reply(
        `👋 欢迎 ${m.first_name||''} 加入筷子宴！\nWelcome to the Feast of $CHOP!\n私聊我用 /offer 领取每日供奉 · DM me /offer to claim daily offering.`,
        { disable_notification:true }
      );
    }catch{}
  }
});

// ------------ Hourly reminder (24/7) --------------
async function hourlyReminder(){
  ensureDaily();
  if(!DB.reminderOn) return;
  try{
    await bot.telegram.sendMessage(
      GROUP_ID,
      `⏰ 每小时提醒 · Hourly reminder\n还没领取今日供奉的朋友可用 /offer 领取（在私聊）。\nIf you haven’t claimed today, use /offer (DM).`,
      { disable_notification:true }
    );
  }catch{}
}
setInterval(hourlyReminder, 60*60*1000);

// ------------ DAILY AUTOS: Leaderboard & Summary --------------
async function postDailyLeaderboard(){
  const d = ensureDaily();
  if(DB._posted[d]?.leader) return; // already posted today

  const topCumulative = Object.values(DB.users)
    .sort((a,b)=>(b.offers||0)-(a.offers||0))
    .slice(0,15)
    .map((u,i)=>`${i+1}. ${u.username?('@'+u.username):(u.name||u.id)} — ${u.offers||0} offers, ${u.refs||0} refs`)
    .join('\n') || 'No data yet.';

  const todayCounts = Object.entries(DB.daily.counts||{})
    .sort((a,b)=>(b[1]-a[1]))
    .slice(0,10)
    .map(([uid,c],i)=>`${i+1}. ${displayUser(uid)} — ${c}`)
    .join('\n') || 'No claims recorded today.';

  const msg = `🍜 每日榜单 · Daily Leaderboard (${d})
【总累计 · Cumulative】
${topCumulative}

【今日 · Today】
${todayCounts}`;

  try{
    await bot.telegram.sendMessage(GROUP_ID, msg, { parse_mode:'Markdown' });
    DB._posted[d].leader = true; saveDB();
  }catch{}
}

async function postDailySummary(){
  const d = ensureDaily();
  if(DB._posted[d]?.summary) return;

  const totalClaimsToday = DB.daily.claims.length;
  const uniqueClaimers = Object.keys(DB.daily.counts||{}).length;
  // newest 5 referrals system-wide today
  const todayStart = new Date(`${d}T00:00:00.000Z`).getTime();
  const referralsToday = [];
  for(const inviter of Object.keys(DB.referrals)){
    for(const refUid of Object.keys(DB.referrals[inviter])){
      const ts = DB.referrals[inviter][refUid];
      if(ts>=todayStart) referralsToday.push({inviter, refUid, ts});
    }
  }
  referralsToday.sort((a,b)=>b.ts-a.ts);
  const recentRefs = referralsToday.slice(0,5).map(r=>`• ${displayUser(r.inviter)} → ${displayUser(r.refUid)}`).join('\n') || 'No new referrals today.';

  const msg = `🧧 每日总结 · Daily Summary (${d})
• 今日供奉次数 · Claims today: ${totalClaimsToday}
• 今日独立地址 · Unique claimers: ${uniqueClaimers}
• 最新推荐 · Recent referrals:
${recentRefs}

🔗 更多 / More: /feast · /stats · /referrals`;

  try{
    await bot.telegram.sendMessage(GROUP_ID, msg, { parse_mode:'Markdown' });
    DB._posted[d].summary = true; saveDB();
  }catch{}
}

// scheduler: check every minute which hour it is; post once/day
setInterval(async ()=>{
  const d = ensureDaily();
  const now = new Date();
  const hr = now.getHours();

  if(hr === DAILY_LEADER_HOUR && !DB._posted[d].leader){
    await postDailyLeaderboard();
  }
  if(hr === DAILY_SUMMARY_HOUR && !DB._posted[d].summary){
    await postDailySummary();
  }
}, 60*1000);

// ------------ Admin tools --------------
async function requireAdmin(ctx){
  try{
    const m = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    const ok = ['administrator','creator'].includes(m.status);
    if(!ok) ctx.reply('需要管理员权限 · Admin only.');
    return ok;
  }catch{
    ctx.reply('无法验证管理员权限 · Cannot verify admin status.');
    return false;
  }
}
bot.command('admin', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  return ctx.reply(
`🛠 管理工具 · Admin Tools

/mute <minutes>  (reply to user)
/kick            (reply to user)
/purge <count<=200>  delete last N messages
/toggle_reminder  on/off hourly reminder
/set_cooldown <minutes>  claim cooldown
/set_aura <hours>       aura duration
/force_leader           post daily leaderboard now
/force_summary          post daily summary now
/ping`
  );
});
bot.command('ping', (ctx)=> ctx.reply('pong'));
bot.command('toggle_reminder', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  DB.reminderOn = !DB.reminderOn; saveDB();
  ctx.reply(`Reminder: ${DB.reminderOn?'ON':'OFF'}`);
});
bot.command('set_cooldown', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  const n = Number((ctx.message.text.split(' ')[1]||'').trim());
  if(!n) return ctx.reply('Usage: /set_cooldown <minutes>');
  COOLDOWN_MIN = n; ctx.reply(`Cooldown set to ${COOLDOWN_MIN} min.`);
});
bot.command('set_aura', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  const h = Number((ctx.message.text.split(' ')[1]||'').trim());
  if(!h) return ctx.reply('Usage: /set_aura <hours>');
  AURA_HOURS = h; ctx.reply(`Aura hours set to ${AURA_HOURS}h.`);
});
bot.command('purge', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  const n = Math.min(200, Number((ctx.message.text.split(' ')[1]||'').trim()) || 0);
  if(!n) return ctx.reply('Usage: /purge <count (<=200)>');
  const chatId = ctx.chat.id; const fromId = ctx.message.message_id;
  for(let i=0;i<n;i++){ try{ await bot.telegram.deleteMessage(chatId, fromId-i); }catch{} }
  ctx.reply(`✅ Deleted ${n} messages.`);
});
bot.command('mute', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  if(!ctx.message.reply_to_message) return ctx.reply('Reply to user and run: /mute <minutes>');
  const mins = Number((ctx.message.text.split(' ')[1]||'').trim());
  if(!mins) return ctx.reply('Usage: /mute <minutes>');
  const target = ctx.message.reply_to_message.from.id;
  const until = Math.floor(Date.now()/1000) + mins*60;
  try{
    await bot.telegram.restrictChatMember(ctx.chat.id, target, {
      permissions: { can_send_messages:false, can_send_media_messages:false, can_send_other_messages:false, can_add_web_page_previews:false },
      until_date: until
    });
    ctx.reply(`🔇 Muted for ${mins} minutes.`);
  }catch{ ctx.reply('Failed to mute (needs admin perms).'); }
});
bot.command('kick', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  if(!ctx.message.reply_to_message) return ctx.reply('Reply to user and run: /kick');
  const target = ctx.message.reply_to_message.from.id;
  try{
    await bot.telegram.banChatMember(ctx.chat.id, target);
    await ctx.reply('👢 Kicked.');
    setTimeout(()=> bot.telegram.unbanChatMember(ctx.chat.id, target).catch(()=>{}), 10_000);
  }catch{ ctx.reply('Failed to kick (needs admin perms).'); }
});

// Manual triggers for daily posts
bot.command('force_leader', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  await postDailyLeaderboard();
  ctx.reply('Posted daily leaderboard.');
});
bot.command('force_summary', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  await postDailySummary();
  ctx.reply('Posted daily summary.');
});

// ------------ Keep-alive for Render --------------
http.createServer((_,res)=>{ res.writeHead(200); res.end('ok'); })
  .listen(PORT, ()=> console.log(`✅ Keep-alive on :${PORT}`));

// ------------ Launch --------------
bot.launch().catch(console.error);
console.log('🐉 $ChopBot live: offers/referrals/oracle/fortune/feast/stats/burn, anti-link, admin tools, hourly reminder, daily autos.');
process.once('SIGINT', ()=> bot.stop('SIGINT'));
process.once('SIGTERM',()=> bot.stop('SIGTERM'));
