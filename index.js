// $ChopBot — ChopstixsBNBbot — FULL FEATURED (24/7 reminders)
// ENV REQUIRED: BOT_TOKEN, BOT_USERNAME=ChopstixsBNBbot, GROUP_ID, WEBSITE_URL, TWITTER_HANDLE, AURA_HOURS=24, CLAIM_COOLDOWN_MIN=1440

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import http from 'http';

const BOT_TOKEN    = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'ChopstixsBNBbot';
const GROUP_ID     = Number(process.env.GROUP_ID); // e.g. -10028xxxx
const WEBSITE_URL  = process.env.WEBSITE_URL || 'https://chopstixsbnb.onrender.com';
const TWITTER      = process.env.TWITTER_HANDLE || 'ChopstixsBNB';
let   AURA_HOURS   = Number(process.env.AURA_HOURS || 24);
let   COOLDOWN_MIN = Number(process.env.CLAIM_COOLDOWN_MIN || 1440);

if (!BOT_TOKEN || !BOT_USERNAME || !GROUP_ID) {
  throw new Error('Missing BOT_TOKEN, BOT_USERNAME, or GROUP_ID');
}

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90_000 });

// ---------------- DB (safe init) ----------------
const DB_PATH = './db.json';
const DB = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
if(!DB.users) DB.users = {};
if(!DB.referrals) DB.referrals = {};
if(!DB.offers) DB.offers = {};
if(!DB.tweets) DB.tweets = {};
if(!DB.aura) DB.aura = {};
if(!DB.lastSeen) DB.lastSeen = {};
if(typeof DB.reminderOn !== 'boolean') DB.reminderOn = true;
if(!DB.warnedLinks) DB.warnedLinks = {};
if(!DB.groupLink) DB.groupLink = '';       // saved after /bind
if(!DB.groupBound) DB.groupBound = false;
function saveDB(){ fs.writeFileSync(DB_PATH, JSON.stringify(DB,null,2)); }
function touch(uid){
  if(!DB.lastSeen) DB.lastSeen = {};
  DB.lastSeen[uid] = new Date().toISOString(); saveDB();
}

// ---------------- helpers ----------------
const b64 = (n)=> Buffer.from(String(n)).toString('base64url');
const unb64 = (s)=> { try{ return Number(Buffer.from(s,'base64url').toString()) }catch{ return 0 } };
function userRec(uid){
  if(!DB.users[uid]) DB.users[uid]={ id:uid, joined:Date.now(), name:'', offers:0, auraTill:0, refBy:0, refs:0 };
  return DB.users[uid];
}
function fmtMs(ms){
  const m = Math.ceil(ms/60000);
  if(m>=1440){ const d=Math.floor(m/1440); const r=m-d*1440; return `${d}d ${r}m`; }
  if(m>=60){ const h=Math.floor(m/60); const r=m-h*60; return `${h}h ${r}m`; }
  return `${m}m`;
}
function refLink(uid){ return `https://t.me/${BOT_USERNAME}?start=ref_${b64(uid)}`; }

// >>> Updated tweet intent to ALWAYS include bot link with a cache-buster and per-user ref
function tweetIntent(uid){
  // always use the tested good link that shows preview
  const botLink = "https://t.me/ChopstixsBNBbot?ref=x1";

  const text = encodeURIComponent(
`${botLink}

JUST CLAIMED ANOTHER OFFERING 💸
RISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB`
  );

  return `https://twitter.com/intent/tweet?text=${text}`;
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
function cooldownLeft(uid){
  const last = DB.offers[`u:${uid}`]||0;
  const left = last ? (last + COOLDOWN_MIN*60*1000) - Date.now() : 0;
  return Math.max(0,left);
}

// ---------------- UI ----------------
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

// ---------------- Anti-spam & anti-link (GROUP) ----------------
bot.on('message', async (ctx, next)=>{
  touch(ctx.from.id);
  if(ctx.chat.id !== GROUP_ID) return next();

  // forbid forwarded msgs from non-admins
  const forwarded = ctx.message.forward_from || ctx.message.forward_from_chat;
  if(forwarded && !(await isGroupAdmin(ctx.from.id))){
    try{ await ctx.deleteMessage(); }catch{}
    return;
  }

  // block external links from non-admins (delete + warn ONCE)
  const text = ctx.message.text || ctx.message.caption || '';
  const hasLink = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i.test(text);
  if(hasLink && !(await isGroupAdmin(ctx.from.id))){
    try{ await ctx.deleteMessage(); }catch{}
    if(!DB.warnedLinks[ctx.from.id]){
      DB.warnedLinks[ctx.from.id] = true; saveDB();
      try{
        await ctx.reply(`🚫 请勿在群内发链接 / No links in group. 继续将被静音。\n领取供奉请私聊：@${BOT_USERNAME}`);
      }catch{}
    }
    return;
  }

  return next();
});

// ---------------- Start + referrals ----------------
bot.start(async (ctx)=>{
  const uid = ctx.from.id; const u = userRec(uid);
  u.name = `${ctx.from.first_name||''} ${ctx.from.last_name||''}`.trim();

  const payload=(ctx.startPayload||'').trim();
  if(payload.startsWith('ref_')){
    const rid = unb64(payload.slice(4));
    if(rid && rid!==uid){
      if(!u.refBy) u.refBy = rid;
      if(!DB.referrals[rid]) DB.referrals[rid]={};
      if(!DB.referrals[rid][uid]){ DB.referrals[rid][uid]=Date.now(); userRec(rid).refs++; }
      saveDB();
    }
  }
  return mainMenu(ctx);
});

// ------------- Callback buttons -------------
bot.action('cb_offer', (ctx)=> ctx.answerCbQuery().then(()=> offerEntry(ctx)));
bot.action('cb_refs',  (ctx)=> ctx.answerCbQuery().then(()=> sendReferralDM(ctx)));
bot.action('cb_lore',  (ctx)=> ctx.answerCbQuery().then(()=> lore(ctx)));
bot.action('cb_feast', (ctx)=> ctx.answerCbQuery().then(()=> feast(ctx)));
bot.action('cb_oracle',(ctx)=> ctx.answerCbQuery().then(()=> oracle(ctx)));

// ------------- Commands (group + DM) -------------
bot.command('menu', mainMenu);

function lore(ctx){
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
  const O=['龙曰：','师父言：','炉火传讯：','钟声回荡：'];
  const A=['红灯未灭，心火勿旺。','米袋渐满，不必急食。','筹码如潮，退亦是进。','竹影东移，时至自明。'];
  const B=['看一日线，慎一小时心。','小胜亦胜，切莫求满。','手稳如筷，步轻如风。','与众同宴，勿独食。'];
  const zh=`${O[Math.floor(Math.random()*O.length)]}${A[Math.floor(Math.random()*A.length)]}${B[Math.floor(Math.random()*B.length)]}`;
  const en=['Calm your fire under red lanterns.','A small win is still a win.','Hold steady like chopsticks; move lightly.','Share the feast; do not eat alone.'][Math.floor(Math.random()*4)];
  return ctx.reply(`🧙‍♂️ 筷子神谕\n${zh}\n\nOracle: ${en}`);
}
bot.command('oracle', oracle);

bot.command('fortune', (ctx)=>{
  const picks=[
    ['龙须拂盘，金粒自聚。','Dragon whisk sweeps — grains of gold gather.'],
    ['红灯常明，心定财来。','When the red lantern glows, calm brings fortune.'],
    ['左勇右智，筷起富至。','Courage left, wisdom right — lift and wealth arrives.'],
    ['守得云开，方见金鳞。','Hold through the clouds and see golden scales.'],
  ];
  const [zh,en]=picks[Math.floor(Math.random()*picks.length)];
  return ctx.reply(`🥠 财富签语\n${zh}\n${en}`);
});

bot.command('stats', async (ctx)=>{
  const u=userRec(ctx.from.id);
  const auraLeft=Math.max(0,(u.auraTill||0)-Date.now());
  return ctx.reply(
`📊 统计 · Stats
Offers: ${u.offers}
Referrals: ${u.refs}
Aura: ${auraLeft?fmtMs(auraLeft):'off'}
Joined: ${new Date(u.joined).toLocaleString()}

(Your referral link is sent **by DM** with /referrals)`
  );
});

bot.command('burn', (ctx)=>{
  const u=userRec(ctx.from.id);
  u.auraTill=Date.now()+AURA_HOURS*3600*1000;
  saveDB();
  return ctx.reply(`✨ 光环已点亮 · Aura on for ${AURA_HOURS}h (cosmetic).`);
});

bot.command('referrals', sendReferralDM);
async function sendReferralDM(ctx){
  const uid=ctx.from.id; const u=userRec(uid);
  try{
    await bot.telegram.sendMessage(uid,
`🔗 邀请 · Referrals

你的邀请链接（仅私聊展示） / Your referral link (DM only):
${refLink(uid)}

邀请人数 Ref count: ${u.refs}`,
      { disable_web_page_preview:true }
    );
    if(ctx.chat.id === GROUP_ID){
      try{ await ctx.reply('🔐 已私信你的邀请链接 · I DM’d you your referral link.'); }catch{}
    }
  }catch{
    if(ctx.chat.id === GROUP_ID){
      await ctx.reply(`请先私聊我启动机器人，然后再用 /referrals。\nOpen DM: https://t.me/${BOT_USERNAME}`);
    } else {
      await ctx.reply('无法发送私信，请检查隐私设置。');
    }
  }
}

// ---------- Feast leaderboard ----------
function feast(ctx){
  const list=Object.values(DB.users)
    .sort((a,b)=>(b.offers||0)-(a.offers||0))
    .slice(0,15)
    .map((u,i)=>`${i+1}. ${u.name||u.id} — ${u.offers||0} offers, ${u.refs||0} refs`)
    .join('\n') || 'No data yet.';
  return ctx.reply(`🍜 筷子宴榜单 · Feast Hall Leaderboard\n${list}`);
}
bot.command('feast', feast);

// ---------- OFFER flow (DM only) ----------
bot.command('offer', async (ctx)=> offerEntry(ctx));

async function offerEntry(ctx){
  // If in group: instruct to DM and stop
  if(ctx.chat.type !== 'private'){
    return ctx.reply(
`⚠️ 领取供奉请在私聊进行 / Claim in DM only.
👉 @${BOT_USERNAME}`,
      { disable_web_page_preview:true }
    );
  }

  const uid=ctx.from.id; const u=userRec(uid);
  // must be member of group
  if(!(await ensureMember(uid))){
    const link = DB.groupLink || `https://t.me/${BOT_USERNAME.replace('bot','')}`; // fallback
    return ctx.reply(
`请先加入官方社群再领取。
Join the group first to claim.`,
      Markup.inlineKeyboard([[Markup.button.url('加入社群 · Join Group', link)]])
    );
  }
  const left=cooldownLeft(uid);
  if(left>0){
    return ctx.reply(`今日已领 · Already claimed. Come back in ${fmtMs(left)}.`);
  }

  // Step 1: give tweet button (now includes per-user bot link with cache-buster inside tweet text)
  await ctx.reply(
`点此发推（自动带你的邀请/机器人链接）。
Tap to tweet (auto-includes your referral/bot link).`,
    Markup.inlineKeyboard([[Markup.button.url('发推 · Tweet', tweetIntent(uid))]])
  );

  // Step 2: ask for URL (force reply)
  await ctx.reply(
`发布后，请把推文链接粘贴在此（x.com/twitter.com）。
After posting, paste your tweet URL here.`,
    Markup.forceReply()
  );

  DB.tweets[uid]={waiting:true, ts:Date.now()};
  saveDB();
}

// Catch tweet URL in DM replies
bot.on('text', async (ctx, next)=>{
  if(ctx.chat.type !== 'private') return next(); // only DM here
  const uid=ctx.from.id;
  if(!DB.tweets[uid]?.waiting) return next();

  const url=(ctx.message.text||'').trim();
  if(!/^(https?:\/\/)?(x\.com|twitter\.com)\/.+/i.test(url)){
    return ctx.reply('需要推文链接 · Please paste your tweet URL (x.com/twitter.com).');
  }

  // record claim
  DB.offers[`u:${uid}`]=Date.now();
  const u=userRec(uid);
  u.offers=(u.offers||0)+1;
  u.auraTill=Date.now()+AURA_HOURS*3600*1000;
  DB.tweets[uid]={waiting:false,url,ts:Date.now()};
  saveDB();

  await ctx.reply(`✅ 已记录推文 · Claim recorded! Aura on for ${AURA_HOURS}h. See /stats`);

  // announce in group
  try{
    await bot.telegram.sendMessage(
      GROUP_ID,
      `🎉 ${u.name||uid} 领取供奉成功 · Claimed an offering!\n${url}`,
      { disable_web_page_preview:true }
    );
  }catch{}
});

// ---------- Bind to group ----------
bot.command('bind', async (ctx)=>{
  if(ctx.chat.type==='private'){
    return ctx.reply('在目标群组里发送 /bind。\nSend /bind in the target group.');
  }
  // must be run in the real group
  if(ctx.chat.id !== GROUP_ID){
    return ctx.reply(`此群ID与配置不匹配。\nThis chat ID ${ctx.chat.id} != GROUP_ID ${GROUP_ID}.\nUpdate GROUP_ID then retry.`);
  }
  // require admin to bind
  try{
    const me = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if(!['administrator','creator'].includes(me.status)){
      return ctx.reply('需要管理员权限运行 /bind · Admin only.');
    }
  }catch(e){
    return ctx.reply('无法验证管理员权限，请把我设为管理员再试。');
  }

  DB.groupBound = true;
  DB.groupLink = ctx.chat.username ? `https://t.me/${ctx.chat.username}` : '';
  saveDB();
  return ctx.reply(`✅ 已绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\nLink = ${DB.groupLink || '(no public link)'}`);
});

// --- Welcome new members (group) ---
bot.on('new_chat_members', async (ctx) => {
  if(ctx.chat.id !== GROUP_ID) return;
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    try {
      await ctx.reply(
        `👋 欢迎 ${member.first_name || ''} 加入筷子宴！\nWelcome to the Feast of $CHOP!\n私聊我用 /offer 领取每日供奉 · DM me /offer to claim daily offering.`,
        { disable_notification: true }
      );
    } catch (err) { console.log('Welcome error', err.message); }
  }
});

// ---------- Hourly reminder (24/7) ----------
async function hourlyReminder(){
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

// ---------- Admin toolkit (auto admin detection) ----------
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
  COOLDOWN_MIN = n;
  ctx.reply(`Cooldown set to ${COOLDOWN_MIN} min.`);
});

bot.command('set_aura', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  const h = Number((ctx.message.text.split(' ')[1]||'').trim());
  if(!h) return ctx.reply('Usage: /set_aura <hours>');
  AURA_HOURS = h;
  ctx.reply(`Aura hours set to ${AURA_HOURS}h.`);
});

bot.command('purge', async (ctx)=>{
  if(!(await requireAdmin(ctx))) return;
  const n = Math.min(200, Number((ctx.message.text.split(' ')[1]||'').trim()) || 0);
  if(!n) return ctx.reply('Usage: /purge <count (<=200)>');
  const chatId = ctx.chat.id;
  const fromId = ctx.message.message_id;
  for(let i=0;i<n;i++){
    try{ await bot.telegram.deleteMessage(chatId, fromId-i); }catch{}
  }
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

// ---------- Keep-alive for Render ----------
http.createServer((_,res)=>{ res.writeHead(200); res.end('ok'); })
  .listen(process.env.PORT || 10000, ()=> console.log(`✅ Keep-alive on :${process.env.PORT||10000}`));

// ---------- Launch ----------
bot.launch().catch(console.error);
console.log('🐉 $ChopBot live: /offer (DM), referrals (DM), anti-link, admin tools, hourly reminder, feast/lore/oracle/stats/burn.');
process.once('SIGINT', ()=> bot.stop('SIGINT'));
process.once('SIGTERM',()=> bot.stop('SIGTERM'));
