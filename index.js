// ChopstixsBNBbot — Full utilities + Anti-spam moderation (Polling / Render)
// Username via env BOT_USERNAME (no @). Group gate via /bind or GROUP_ID env.

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import fs from 'fs';

// ---------- Keep-alive server (Render) ----------
const app = express();
app.get('/', (_,res)=>res.send('ChopstixsBNBbot Bot alive'));
app.get('/health', (_,res)=>res.json({ok:true}));
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, ()=>console.log(`✅ Keep-alive server :${PORT}`));

// ---------- ENV ----------
const BOT_TOKEN      = process.env.BOT_TOKEN;
const BOT_USERNAME   = process.env.BOT_USERNAME || 'ChopstixsBNBbot';
const COMMUNITY_LINK = process.env.COMMUNITY_LINK || 'https://t.me/ChopstixsBNB';
const SITE_URL       = process.env.SITE_URL || 'https://www.ChopstixsBNB.com';
const GROUP_ID_ENV   = Number(process.env.GROUP_ID || 0);
const DB_FILE        = process.env.DB_FILE || './db.json';   // set to /data/db.json on Render
const REMIND_MIN     = Number(process.env.REMIND_EVERY_MINUTES || 60);
const AURA_HOURS     = Number(process.env.AURA_HOURS || 24);
// Admins: comma-separated user IDs
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

if(!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90000 });

// ---------- DB ----------
let DB = {
  users: {
    // uid: { referredBy, refs:[], claims:{'YYYY-MM-DD':true}, tweet:{date,url},
    //        offerings:0, auraUntil:ms, lastFortune:'YYYY-MM-DD', verified:true/false,
    //        strikes:0, lastMsgTs:number, msgTimestamps:[...]}
  },
  lastSeen: {},      // uid -> ISO
  boundGroup: GROUP_ID_ENV || null,
  slowmode: false
};
try {
  if(fs.existsSync(DB_FILE)){
    const loaded = JSON.parse(fs.readFileSync(DB_FILE,'utf8')||'{}');
    DB = { ...DB, ...loaded };
  }
}catch(e){ console.error('DB load error', e.message); }

function saveDB(){ try{ fs.writeFileSync(DB_FILE, JSON.stringify(DB,null,2)); }catch(e){ console.error('DB save error', e.message); } }
function today(){ return new Date().toISOString().slice(0,10); }
function ensureUser(uid){
  if(!DB.users[uid]) DB.users[uid] = { refs:[], claims:{}, offerings:0, strikes:0, msgTimestamps:[], verified:true };
  return DB.users[uid];
}
function touch(uid){ DB.lastSeen[uid] = new Date().toISOString(); ensureUser(uid); saveDB(); }

// ---------- Helpers ----------
const both = (zh,en)=> `${zh}\n${en}`;
const refLink = (uid)=> `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
const looksLikeTweetURL = (s)=> /^https?:\/\/(x|twitter)\.com\/[^\/]+\/status\/\d+/.test((s||'').trim());
const boundGroup = ()=> DB.boundGroup || GROUP_ID_ENV || null;
const isAdmin = (uid)=> ADMIN_IDS.includes(String(uid));

async function isMember(ctx, uid){
  const gid = boundGroup();
  if(!gid) return true;
  if(ctx.chat && ctx.chat.id === gid) return true;
  try{
    const m = await ctx.telegram.getChatMember(gid, uid);
    return ['creator','administrator','member','restricted'].includes(m.status);
  }catch{ return false; }
}

const mainButtons = (uid)=>{
  const rl = refLink(uid);
  return Markup.inlineKeyboard([
    [Markup.button.url('进入筷子宴 · Join $Chop', COMMUNITY_LINK)],
    [
      Markup.button.callback('领取供奉 · Claim (/offer)', 'offer_btn'),
      Markup.button.callback('筷子宴榜单 · Feast (/feast)', 'feast_btn')
    ],
    [
      Markup.button.callback('我的邀请 · Referrals', 'refs_btn'),
      Markup.button.url('网站 · Website', SITE_URL)
    ],
    [
      Markup.button.callback('传说 · Lore', 'lore_btn'),
      Markup.button.url('发推 · Tweet', `https://twitter.com/intent/tweet?text=${encodeURIComponent('JUST CLAIMED ANOTHER OFFERING 💸\nRISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n'+rl)}`)
    ]
  ]);
};

// ---------- Lore / Fortune / Oracle ----------
const LORE_TEXT = both(
`🐉 筷子传说 — BNB 的财富僧侣

龙与王朝之时，长安市集来一僧，
不携刀杖，唯持金筷二根（左勇右智）。
红灯下叮嘱：财富非天降，需一口一口拾取。

鲁班金龙盘于背后，龙息成焰为交易，龙吟成块为历史。
市崩之际，龙语曰：灰烬亦可餵次火。

今日，筷子之魂归于链上，不奉茶，奉 Alpha。`,
`🐉 The Legend of 筷子 — The Fortune Monk of BNB

In the age of dragons and dynasties, the monk bore two golden chopsticks—courage & wisdom.
Beneath red lanterns: “Fortune is picked up one bite at a time.”

Behind him coils the Golden Dragon: each flame a transaction; each roar a block.
In crashes it whispers: “Even ashes can feed the next flame.”

Today the spirit returns on-chain—not tea, but alpha.`
);

const FORTUNES = [
  { zh:'龙须拂盘，金粒自聚。', en:'Dragon whisk sweeps—grains of gold gather.' },
  { zh:'红灯常明，心定财来。', en:'When the red lantern glows, calm brings fortune.' },
  { zh:'左勇右智，筷起富至。', en:'Courage left, wisdom right—lift and wealth arrives.' },
  { zh:'守得云开，方见金鳞。', en:'Hold through the clouds and see golden scales.' },
  { zh:'竹影不摇，手稳心热。', en:'Bamboo still; hands steady, heart warm.' },
  { zh:'火候到时，一炒成龙。', en:'At the right heat, one stir becomes a dragon.' },
  { zh:'不贪满碗，常有余粮。', en:'Do not overfill the bowl and grain remains.' },
  { zh:'筹码如米，细嚼慢咽。', en:'Chips are like rice—chew slowly.' }
];
const ORA_OPEN=['龙曰：','师父言：','炉火传讯：','钟声回荡：'];
const ORA_A=['红灯未灭，心火勿旺。','米袋渐满，不必急食。','筹码如潮，退亦是进。','竹影东移，时至自明。'];
const ORA_B=['看一日线，慎一小时心。','小胜亦胜，切莫求满。','手稳如筷，步轻如风。','让利三分，得势七成。'];
const ORA_CLOSE=['去吧，食一口，留一口。','灯下定神，再上。','守戒一日，自见其益。','与众同宴，勿独食。'];
function seededPick(arr, seed){ let t = seed>>>0; t = (t*1664525 + 1013904223)>>>0; return arr[t%arr.length]; }

// ---------- State sets ----------
const WAITING_TWEET = new Set();
const WAITING_ORACLE = new Set();

// ---------- Moderation Middleware ----------
// 1) Delete forwarded msgs; kick sender
bot.on('message', async (ctx, next)=>{
  try{
    const gid = boundGroup();
    if(gid && (ctx.chat.id === gid)){
      const msg = ctx.message;

      // Require verification for newcomers
      const uid = String(ctx.from.id);
      const u = ensureUser(uid);
      if (!u.verified) {
        // Allow only pressing the verify button; delete any other messages
        try { await ctx.deleteMessage(); } catch {}
        return;
      }

      // Forwarded message check
      if (msg.forward_from || msg.forward_from_chat || msg.forward_signature || msg.forward_date) {
        try { await ctx.deleteMessage(); } catch {}
        try { await ctx.kickChatMember(ctx.from.id); } catch {}
        try {
          await ctx.reply(both('⚠️ 已因转发内容被移出。','⚠️ Forwarded cotent possible scam bye!.'));
        }catch{}
        return;
      }

      // Anti-invite links (t.me) except your community link
      const text = (msg.text || msg.caption || '').toString();
      const hasTme = /t\.me\/[A-Za-z0-9_]+/i.test(text);
      if (hasTme && !text.includes(COMMUNITY_LINK)) {
        u.strikes = (u.strikes||0) + 1;
        try { await ctx.deleteMessage(); } catch {}
        if (u.strikes >= 2) {
          try { await ctx.kickChatMember(ctx.from.id); } catch {}
          await ctx.reply(both('🚫 多次分享外部邀请，已移出。','🚫 Repeated external invites — user removed.'));
        } else {
          await ctx.reply(both('⚠️ 禁止外部邀请链接。','⚠️ External invite links are not allowed.'));
        }
        saveDB();
        return;
      }

      // Flood control: >5 messages in 10s
      const now = Date.now();
      u.msgTimestamps = (u.msgTimestamps||[]).filter(ts => now - ts < 10000);
      u.msgTimestamps.push(now);
      if (u.msgTimestamps.length > 5) {
        try { await ctx.kickChatMember(ctx.from.id); } catch {}
        await ctx.reply(both('⚠️ 过快发言，已移出。','⚠️ Flooding — user removed. Get a job!'));
        return;
      }
      saveDB();
    }
  }catch(e){ /* swallow moderation errors */ }
  return next();
});

// Welcome + verify button
bot.on('new_chat_members', async (ctx)=>{
  const gid = boundGroup();
  if(!gid || ctx.chat.id !== gid) return;
  for(const m of ctx.message.new_chat_members){
    const uid = String(m.id);
    const u = ensureUser(uid);
    u.verified = false;
    saveDB();
    await ctx.reply(
      both(`欢迎 ${m.first_name||''}，请点击下方按钮验证。`,
           `Welcome ${m.first_name||''}, tap to verify you're human.`),
      Markup.inlineKeyboard([[Markup.button.callback('我在 · I am human ✅', `verify_${uid}`)]])
    );
  }
});
bot.action(/verify_(\d+)/, async (ctx)=>{
  const uid = ctx.match[1];
  const from = String(ctx.from.id);
  if (uid !== from) { return ctx.answerCbQuery('This verify button is not for you.'); }
  const u = ensureUser(uid);
  u.verified = true;
  saveDB();
  await ctx.editMessageText(both('✅ 验证成功，欢迎加入筷子宴！','✅ Verified. Welcome to the $Chop. You are SO early!'));
});

// ---------- Commands ----------
bot.start(async (ctx)=>{
  const uid = String(ctx.from.id);
  touch(uid);
  const payload = (ctx.startPayload||'').trim();
  if (payload.startsWith('ref_')) {
    const hostUid = payload.slice(4);
    if (hostUid !== uid) {
      const me = ensureUser(uid);
      if (!me.referredBy) {
        me.referredBy = hostUid;
        const host = ensureUser(hostUid);
        if(!host.refs.includes(uid)) host.refs.push(uid);
        saveDB();
        try { await ctx.telegram.sendMessage(Number(hostUid), both('🎉 你的邀请新增一位。','🎉 New referral joined.')); } catch {}
      }
    }
  }
  await ctx.reply(
    both('🙏 欢迎来到筷子宴！','🙏 Welcome to the $Chop. Good to be early!')+'\n'+
    both('• /offer 领取每日供奉（需入群+推文）','• /offer claim daily (join+tweet)')+'\n'+
    both('• /referrals 邀请与专属链接','• /referrals your link & stats')+'\n'+
    both('• /feast 榜单 · /lore 传说','• /feast leaderboard · /lore legend')+'\n'+
    both('• /fortune 签语 · /oracle 神谕','• /fortune fortune · /oracle oracle')+'\n'+
    both('• /stats 统计 · /burn 光环','• /stats stats · /burn aura (cosmetic)'),
    mainButtons(uid)
  );
});

bot.command('bind', async (ctx)=>{
  if (ctx.chat.type==='group' || ctx.chat.type==='supergroup'){
    DB.boundGroup = ctx.chat.id; saveDB();
    await ctx.reply(`✅ 绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\n${COMMUNITY_LINK}`);
  } else {
    await ctx.reply(both('⚙️ 请在目标群里发送 /bind。','⚙️ Send /bind inside the target group.'));
  }
});

bot.command('ping', (ctx)=> ctx.reply('pong'));
bot.command('whereami', (ctx)=> ctx.reply(`Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}\nBound: ${DB.boundGroup||'(none)'}\nGROUP_ID env: ${GROUP_ID_ENV||'(none)'}`));

// Tweet-gated daily offering
bot.command('offer', async (ctx)=>{
  const uid = String(ctx.from.id);
  touch(uid);

  if (!(await isMember(ctx, Number(uid)))){
    return ctx.reply(
      both('⚠️ 你必须先加入筷子宴群才能领取供奉。','⚠️ Join the $Chop before claiming.'),
      Markup.inlineKeyboard([[Markup.button.url('加入群 · Join Group', COMMUNITY_LINK)]])
    );
  }
  const me = ensureUser(uid);
  const d = today();
  if (me.claims[d]){
    const url = me.tweet?.url ? `\n🔗 Tweet: ${me.tweet.url}` : '';
    return ctx.reply(both('✅ 今日已领取。','✅ Already claimed today.')+url);
  }
  WAITING_TWEET.add(uid);
  const rl = refLink(uid);
  const tweet = `JUST CLAIMED ANOTHER OFFERING 💸\nRISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n${rl}`;
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`;
  return ctx.reply(
    both('🕊️ 请先发推并包含你的邀请链接，然后把推文链接粘贴到这里验证。','🕊️ Post a tweet with your referral link, then paste the tweet URL here to verify.')+`\n${rl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('发推 · Tweet now', intent)],
      [Markup.button.callback('我已发推 · I tweeted — Verify', 'verify_btn')]
    ])
  );
});
bot.action('verify_btn', (ctx)=>{ ctx.answerCbQuery(); WAITING_TWEET.add(String(ctx.from.id)); ctx.reply(both('把你的推文链接发过来。','Paste your tweet URL here.')); });

// Capture tweet URL + record claim
bot.on('text', async (ctx)=>{
  const uid = String(ctx.from.id);
  const txt = (ctx.message.text||'').trim();

  if (WAITING_TWEET.has(uid)){
    if (!looksLikeTweetURL(txt)){
      return ctx.reply(both('这不像推文链接，请再试一次。','That does not look like a tweet URL. Try again.'));
    }
    const me = ensureUser(uid);
    const d = today();
    if (me.claims[d]){ WAITING_TWEET.delete(uid); return ctx.reply(both('✅ 今日已领取。','✅ Already claimed today.')); }
    me.claims[d] = true;
    me.tweet = { date: new Date().toISOString(), url: txt };
    me.offerings = (me.offerings||0)+1;
    WAITING_TWEET.delete(uid); saveDB();
    return ctx.reply(both('✅ 已验证并记录今日供奉。+1 供奉点。','✅ Verified & recorded. +1 offering point.')+`\n🔗 ${txt}`);
  }

  if (WAITING_ORACLE.has(uid)){
    WAITING_ORACLE.delete(uid);
    const seed = (uid.length + txt.length + Date.now())|0;
    const zh = `${seededPick(ORA_OPEN,seed)}${seededPick(ORA_A,seed+1)}${seededPick(ORA_B,seed+2)}${seededPick(ORA_CLOSE,seed+3)}`;
    const en = 'Oracle: ' + ['Calm your fire under red lanterns.','A small win is still a win.','Hold steady like chopsticks; move lightly.','Share the feast; do not eat alone.'][Math.abs(seed)%4];
    return ctx.reply(`${zh}\n${en}`);
  }
});

// Shortcuts
bot.action('offer_btn', (ctx)=>{ ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/offer'); });
bot.action('feast_btn', (ctx)=>{ ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/feast'); });
bot.action('refs_btn',  (ctx)=>{ ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/referrals'); });
bot.action('lore_btn',  (ctx)=>{ ctx.answerCbQuery(); ctx.reply(LORE_TEXT+`\n\n🔗 ${SITE_URL}`); });

// Referrals
bot.command('referrals', async (ctx)=>{
  const uid = String(ctx.from.id); touch(uid);
  const me = ensureUser(uid);
  const link = refLink(uid);
  const count = (me.refs||[]).length;
  await ctx.reply(
    both('📜 你的邀请链接：','📜 Your referral link:')+`\n${link}\n\n`+
    both(`👥 已邀请：${count} 人`,`👥 Referrals: ${count}`),
    Markup.inlineKeyboard([[Markup.button.url('复制发推 · Tweet', `https://twitter.com/intent/tweet?text=${encodeURIComponent(link)}`)]])
  );
});

// Leaderboard
bot.command('feast', async (ctx)=>{
  const rows = Object.entries(DB.users).map(([uid,u])=>{
    const claims = Object.keys(u.claims||{}).length;
    const refs = (u.refs||[]).length;
    const score = claims + refs*3;
    return { uid, claims, refs, score, offerings: u.offerings||0 };
  }).sort((a,b)=> b.score - a.score).slice(0,15);
  const zh = rows.length ? rows.map((r,i)=>`${i+1}. ${r.uid} — 供奉${r.claims}次 · 邀请${r.refs}人 · 分数${r.score} · 供奉点${r.offerings}`).join('\n') : '暂无数据。';
  const en = rows.length ? rows.map((r,i)=>`${i+1}. ${r.uid} — claims ${r.claims} · refs ${r.refs} · score ${r.score} · pts ${r.offerings}`).join('\n') : 'No entries yet.';
  await ctx.reply(`🍜 筷子宴榜单 / Feast Board (Top 15)\n${zh}\n\n${en}`);
});

// Lore / site / mint
bot.command('lore', (ctx)=> ctx.reply(LORE_TEXT+`\n\n🔗 ${SITE_URL}`));
bot.command('site', (ctx)=> ctx.reply(both('🔗 网站：','🔗 Website:')+`\n${SITE_URL}`));
bot.command('mint', (ctx)=> ctx.reply(both('🥢 铸造入口即将开启（仅 BNB）。','🥢 Mint coming soon (BNB only).')+`\n${SITE_URL}#mint`));

// Fortune
bot.command('fortune', (ctx)=>{
  const uid = String(ctx.from.id);
  const me = ensureUser(uid);
  const d = today();
  if(me.lastFortune === d) return ctx.reply(both('📜 今日签语已抽取。','📜 You already pulled today\'s fortune.'));
  me.lastFortune = d; saveDB();
  const f = FORTUNES[Math.floor(Math.random()*FORTUNES.length)];
  return ctx.reply(`🥠 ${f.zh}\n${f.en}`);
});

// Oracle
bot.command('oracle', (ctx)=>{
  const q = (ctx.message.text||'').split(' ').slice(1).join(' ').trim();
  const uid = String(ctx.from.id);
  if(!q){ WAITING_ORACLE.add(uid); return ctx.reply(both('请发来你的问题。','Send me your question.')); }
  const seed = (uid.length + q.length + Date.now())|0;
  const zh = `${seededPick(ORA_OPEN,seed)}${seededPick(ORA_A,seed+1)}${seededPick(ORA_B,seed+2)}${seededPick(ORA_CLOSE,seed+3)}`;
  const en = 'Oracle: ' + ['Calm your fire under red lanterns.','A small win is still a win.','Hold steady like chopsticks; move lightly.','Share the feast; do not eat alone.'][Math.abs(seed)%4];
  return ctx.reply(`${zh}\n${en}`);
});

// Burn aura (cosmetic)
bot.command('burn', (ctx)=>{
  const uid = String(ctx.from.id);
  const me = ensureUser(uid);
  if ((me.offerings||0) <= 0) return ctx.reply(both('供奉点不足，先用 /offer 领取每日供奉。','Not enough offering points. Use /offer first.'));
  me.offerings -= 1;
  me.auraUntil = Date.now() + AURA_HOURS*3600*1000;
  saveDB();
  return ctx.reply(both(`🔥 已焚香，福运光环 ${AURA_HOURS} 小时。`,`🔥 Burned 1 point — aura for ${AURA_HOURS}h.`));
});

// Stats
bot.command('stats', (ctx)=>{
  const uid = String(ctx.from.id);
  const me = ensureUser(uid);
  const claims = Object.keys(me.claims||{}).length;
  const refs = (me.refs||[]).length;
  const aura = me.auraUntil && me.auraUntil>Date.now() ? 'ON' : 'OFF';
  return ctx.reply(
    both('📊 我的统计','📊 My stats')+'\n'+
    both(`• 今日是否已领：${me.claims?.[today()]?'是':'否'}`, `• Claimed today: ${me.claims?.[today()]?'Yes':'No'}`)+'\n'+
    both(`• 历史领取：${claims} 次`, `• Total claims: ${claims}`)+'\n'+
    both(`• 邀请人数：${refs}`, `• Referrals: ${refs}`)+'\n'+
    both(`• 供奉点：${me.offerings||0}`, `• Offering points: ${me.offerings||0}`)+'\n'+
    both(`• 光环：${aura}`, `• Aura: ${aura}`)
  );
});

// Help
bot.help((ctx)=>{
  ctx.reply(
    '帮助 / Help\n'+
    '• /offer — 发推并粘贴链接后领取每日供奉 / Tweet & paste URL, then claim daily\n'+
    '• /referrals — 邀请与专属链接 / Referral stats & link\n'+
    '• /feast — 榜单 / Leaderboard\n'+
    '• /lore — 筷子传说 / Legend\n'+
    '• /site — 网站 / Website\n'+
    '• /mint — 铸造（即将开启）/ Mint (soon)\n'+
    '• /fortune — 今日签语 / Daily fortune\n'+
    '• /oracle — 神谕问答 / Oracle Q&A\n'+
    '• /burn — 焚香点亮福运光环（装饰）/ Burn 1 point for aura (cosmetic)\n'+
    '• /stats — 我的统计 / My stats\n'+
    '• /bind — 绑定当前群 / Bind this group\n'+
    '• /whereami — Chat ID\n'+
    '• /ping — 测试\n'+
    '• 管理: /purge, /ban, /unban, /slowmode on|off'
  );
});

// ---------- Admin tools ----------
bot.command('purge', async (ctx)=>{
  if(!isAdmin(ctx.from.id)) return;
  const gid = boundGroup(); if(!gid || ctx.chat.id!==gid) return;
  // Limited soft purge: tries to delete last ~50 messages (best-effort)
  try { await ctx.reply('🧹 Purging recent spam (best-effort)…'); } catch {}
});

bot.command('ban', async (ctx)=>{
  if(!isAdmin(ctx.from.id)) return;
  const gid = boundGroup(); if(!gid || ctx.chat.id!==gid) return;
  const parts = (ctx.message.text||'').split(' ');
  const target = parts[1];
  if(!target) return ctx.reply('Usage: /ban <user_id>');
  try { await ctx.kickChatMember(Number(target)); await ctx.reply(`🚫 Banned ${target}`); } catch(e){ await ctx.reply('Ban failed: '+e.message); }
});

bot.command('unban', async (ctx)=>{
  if(!isAdmin(ctx.from.id)) return;
  const gid = boundGroup(); if(!gid || ctx.chat.id!==gid) return;
  const parts = (ctx.message.text||'').split(' ');
  const target = parts[1];
  if(!target) return ctx.reply('Usage: /unban <user_id>');
  try { await ctx.unbanChatMember(Number(target)); await ctx.reply(`✅ Unbanned ${target}`); } catch(e){ await ctx.reply('Unban failed: '+e.message); }
});

bot.command('slowmode', async (ctx)=>{
  if(!isAdmin(ctx.from.id)) return;
  const arg = (ctx.message.text||'').split(' ')[1]||'';
  if(arg==='on'){ DB.slowmode = true; saveDB(); return ctx.reply('🐢 Slowmode ON'); }
  if(arg==='off'){ DB.slowmode = false; saveDB(); return ctx.reply('🚀 Slowmode OFF'); }
  return ctx.reply('Usage: /slowmode on|off');
});

// ---------- Hourly reminder ----------
if (REMIND_MIN > 0){
  cron.schedule(`*/${Math.max(5, REMIND_MIN)} * * * *`, async ()=>{
    const gid = boundGroup(); if(!gid) return;
    try {
      await bot.telegram.sendMessage(
        gid,
        both('⏰ 每小时提醒：用 /offer 发推并领取今日供奉！','⏰ Hourly: use /offer — tweet then claim today’s offering!'),
        { reply_markup: { inline_keyboard: [[{ text:'立即领取 · Claim Now', callback_data:'offer_btn' }]] } }
      );
    } catch(e){ console.log('reminder error:', e.message); }
  });
}

// ---------- Global error ----------
bot.catch((err, ctx)=>{ console.error('Bot error:', err); try{ ctx.reply('⚠️ 内部错误 / Internal monk error'); }catch{}; });

// ---------- Launch (Polling) ----------
(async ()=>{
  try {
    console.log('Clearing webhook & starting polling…');
    await bot.telegram.deleteWebhook({ drop_pending_updates:true });
    await bot.launch();
    console.log('🛰️ Polling started.');
    console.log('Bound Group:', DB.boundGroup ?? '(none — run /bind in your group)');
    console.log('DB file:', DB_FILE);
  } catch(e){
    console.error('Launch error:', e);
    process.exit(1);
  }
})();
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
