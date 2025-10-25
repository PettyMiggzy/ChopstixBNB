// Feast Hall Monk Bot — FULL FEATURE BUILD for Render (Web Service)
// Includes:
//  • Bilingual (CN/EN) replies everywhere
//  • Join gate (must be in group to claim)
//  • /offer (tweet -> paste tweet URL -> claim once/day)
//  • /referrals (personal referral link & count)
//  • /feast (leaderboard: claims + referrals*3)
//  • /lore (Legend of 筷子)  • /site (website)  • /mint (mint section link)
//  • /fortune (daily fortune slip)  • /oracle (poetic Q&A)
//  • /bind (bind this group)  • /whereami  • /help  • /ping
//  • Hourly reminder in bound group
//  • Persistent JSON DB via DB_FILE (attach Render Disk at /data recommended)
//  • Keep-alive HTTP server (Render Web Service requirement)

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import fs from 'fs';

// ------------------- Keep-alive Web Server -------------------
const app = express();
app.get('/', (_, res) => res.send('Feast Hall Monk Bot is alive'));
app.get('/health', (_, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Keep-alive server listening on :${PORT}`));

// ---------------------------- ENV ----------------------------
const BOT_TOKEN       = process.env.BOT_TOKEN;                 // e.g. 1234:AA...
const BOT_USERNAME    = process.env.BOT_USERNAME;              // e.g. FeastofHallMonkBot (NO @)
const COMMUNITY_LINK  = process.env.COMMUNITY_LINK || 'https://t.me/ChopstixsBNB';
const GROUP_ID_ENV    = Number(process.env.GROUP_ID || 0);     // e.g. -100xxxxxxxxxx
const DB_FILE         = process.env.DB_FILE || '/data/feast-hall-data.json';
const REMIND_MIN      = Number(process.env.REMIND_EVERY_MINUTES || 60);
const SITE_URL        = process.env.SITE_URL || 'https://www.ChopstixsBNB.com';

if (!BOT_TOKEN || !BOT_USERNAME) throw new Error('Missing BOT_TOKEN or BOT_USERNAME in env');

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90000 });

// ------------------------- Tiny JSON DB -----------------------
let DB = {
  users: {},        // uid -> { referredBy?:string, refs:[], claims:{'YYYY-MM-DD':true}, tweet?:{date,url}, lastFortune?:'YYYY-MM-DD' }
  lastSeen: {},     // uid -> ISO
  boundGroup: GROUP_ID_ENV || null
};
try {
  if (fs.existsSync(DB_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE,'utf8')||'{}');
    DB = { ...DB, ...loaded };
  }
} catch(e){ console.error('DB load error:', e.message); }
function saveDB(){ try{ fs.writeFileSync(DB_FILE, JSON.stringify(DB,null,2)); }catch(e){ console.error('DB save error:', e.message); } }
function today(){ return new Date().toISOString().slice(0,10); }
function touch(uid){ DB.lastSeen[uid] = new Date().toISOString(); if(!DB.users[uid]) DB.users[uid] = { refs:[], claims:{} }; saveDB(); }
function user(uid){ if(!DB.users[uid]) DB.users[uid]={ refs:[], claims:{} }; return DB.users[uid]; }

const WAITING_TWEET   = new Set(); // users waiting to paste tweet URL for /offer
const WAITING_ORACLE  = new Set(); // users waiting to submit a question for /oracle

// --------------------------- Helpers --------------------------
const both = (zh, en) => `${zh}\n${en}`;
const refLink = (uid) => `https://t.me/${BOT_USERNAME}?start=ref_${uid}`;
const looksLikeTweetURL = (s) => /^https?:\/\/(x|twitter)\.com\/[^\/]+\/status\/\d+/.test((s||'').trim());
const isAllowedGroupId = (id) => !!(DB.boundGroup && id === DB.boundGroup);

async function isMember(ctx, uid){
  const gid = DB.boundGroup || GROUP_ID_ENV;
  if(!gid) return true;                                 // no gate if not bound
  if (ctx.chat && isAllowedGroupId(ctx.chat.id)) return true;
  try {
    const m = await ctx.telegram.getChatMember(gid, uid);
    return ['member','creator','administrator','restricted'].includes(m.status);
  } catch { return false; }
}

const mainButtons = (uid) => {
  const rl = refLink(uid);
  return Markup.inlineKeyboard([
    [Markup.button.url('进入筷子宴 · Join Feast Hall', COMMUNITY_LINK)],
    [
      Markup.button.callback('领取供奉 · Claim (/offer)', 'offer_btn'),
      Markup.button.callback('筷子宴榜单 · Feast (/feast)', 'feast_btn')
    ],
    [
      Markup.button.callback('我的邀请 · My Referrals', 'refs_btn'),
      Markup.button.url('网站 · Website', SITE_URL)
    ],
    [
      Markup.button.callback('传说 · Lore', 'lore_btn'),
      Markup.button.url('发推 · Tweet', `https://twitter.com/intent/tweet?text=${encodeURIComponent('JUST CLAIMED ANOTHER OFFERING 💸\nRISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n'+rl)}`)
    ]
  ]);
};

// ---------------------- Content: Lore/Fortune/Oracle ----------------------
const LORE_TEXT = both(
`🐉 筷子传说 — BNB 的财富僧侣

龙与王朝的年代，长安南市来一位僧人。
他不携刀杖，只持两根以龙须化金所铸之筷。

世人称之为「筷子僧」。

🧧 平衡之象
僧曰：左筷为勇，右筷为智；双筷并举，起财不贪。
红灯下他静坐，铜钱环绕，对众低语：财富非天降，须一口一口拾取。

🪙 繁荣之龙
鲁班金龙盘踞其后，护创者与筑者。龙息为交易之焰，龙吟为历史之块。
市海崩落时，龙仍低语：灰烬亦可餵下一簇火。

🥠 现代重生 — Meme 王朝
今日，筷子之魂归来，不由庙堂，而由链上。
他不以米易，而以 Token 易；不奉茶，而奉 Alpha。

#CHOPSTIX 遵其戒：
· 乱中守纪 · 技巧致富 · 社群先于贪欲`,
`🐉 The Legend of 筷子 — The Fortune Monk of BNB

In the age of dragons and dynasties, a monk wandered into Chang’an’s southern market.
He carried no blade—only two golden chopsticks, forged from the dragon’s whiskers of fortune.

They called him the Chopstick Monk.

🧧 A Symbol of Balance
“The left chopstick is courage; the right is wisdom. Together, they lift fortune—never greed.”
Beneath red lanterns, coins floated as he whispered: “Fortune is picked up—one bite at a time.”

🪙 The Dragon of Prosperity
Behind him coils the Golden Dragon of Lu Ban—guardian of builders. Each flame a transaction; each roar a block.
When markets crashed, the dragon whispered: “Even ashes can feed the next flame.”

🥠 Modern Rebirth — The Meme Dynasty
Today, the spirit returns on-chain. He trades not rice, but tokens; not tea, but alpha.

The #CHOPSTIX code:
· Discipline in chaos · Fortune through skill · Community before greed`
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
const ORA_OPEN = ['龙曰：','师父言：','炉火传讯：','钟声回荡：'];
const ORA_A = ['红灯未灭，心火勿旺。','米袋渐满，不必急食。','筹码如潮，退亦是进。','竹影东移，时至自明。'];
const ORA_B = ['看一日线，慎一小时心。','小胜亦胜，切莫求满。','手稳如筷，步轻如风。','让利三分，得势七成。'];
const ORA_CLOSE = ['去吧，食一口，留一口。','灯下定神，再上。','守戒一日，自见其益。','与众同宴，勿独食。'];

function seededPick(arr, seed){
  let t = seed>>>0;
  t = (t*1664525 + 1013904223)>>>0;
  return arr[t % arr.length];
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
        try {
          await ctx.telegram.sendMessage(Number(hostUid),
            both(`🎉 你的邀请新增一位：${ctx.from.first_name || ''}`,
                 `🎉 New referral joined: ${ctx.from.first_name || ''}`));
        } catch {}
      }
    }
  }

  await ctx.reply(
    both('🙏 欢迎来到筷子宴！','🙏 Welcome to the Feast Hall!') + '\n' +
    both('• /offer 领取每日供奉（需加入群）','• /offer claim daily offering (join group required)') + '\n' +
    both('• /referrals 邀请与专属链接','• /referrals your link & stats') + '\n' +
    both('• /lore 传说 · /fortune 签语 · /oracle 神谕','• /lore legend · /fortune fortune · /oracle oracle') + '\n' +
    both('• /site 网站 · /mint 铸造','• /site website · /mint mint'),
    mainButtons(uid)
  );
});

// --------------------------- Diagnostics ---------------------------------
bot.command('whereami', async (ctx)=> ctx.reply(`Chat ID: ${ctx.chat.id}\nType: ${ctx.chat.type}\nBound: ${DB.boundGroup||'(none)'}\nGROUP_ID env: ${GROUP_ID_ENV||'(none)'}`));
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
      both('⚠️ 你必须先加入筷子宴群才能领取供奉。','⚠️ Join the Feast Hall before claiming.'),
      Markup.inlineKeyboard([[Markup.button.url('加入群 · Join Group', COMMUNITY_LINK)]])
    );
  }

  const me = user(uid);
  const d = today();
  if (me.claims && me.claims[d]) {
    const url = me.tweet?.url ? `\n🔗 Tweet: ${me.tweet.url}` : '';
    return ctx.reply(both('✅ 今日已领取。','✅ Already claimed today.') + url);
  }

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
    ) + `\n${rl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('发推 · Tweet now', intent)],
      [Markup.button.callback('我已发推 · I tweeted — Verify', 'verify_btn')]
    ])
  );
});

// Inline buttons for main menu
bot.action('offer_btn', (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/offer'); });
bot.action('feast_btn', (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/feast'); });
bot.action('refs_btn',  (ctx)=> { ctx.answerCbQuery(); ctx.telegram.sendMessage(ctx.chat.id, '/referrals'); });
bot.action('lore_btn',  async (ctx)=> { ctx.answerCbQuery(); await ctx.reply(LORE_TEXT + `\n\n🔗 ${SITE_URL}`); });
bot.action('verify_btn',(ctx)=> { ctx.answerCbQuery(); WAITING_TWEET.add(String(ctx.from.id)); ctx.reply(both('把你的推文链接发过来。','Paste your tweet URL here.')); });

// Capture pasted tweet URL & record claim
bot.on('text', async (ctx) => {
  const uid = String(ctx.from.id);
  const txt = (ctx.message.text || '').trim();
  // tweet verification flow
  if (WAITING_TWEET.has(uid)) {
    if (!looksLikeTweetURL(txt)) {
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
    me.tweet = { date: new Date().toISOString(), url: txt };
    WAITING_TWEET.delete(uid);
    saveDB();
    return ctx.reply(both('✅ 已验证！今日供奉已记录。','✅ Verified! Today’s offering recorded.') + `\n🔗 ${txt}`);
  }

  // oracle follow-up
  if (WAITING_ORACLE.has(uid)) {
    WAITING_ORACLE.delete(uid);
    const seed = (uid.length + txt.length + Date.now())|0;
    const zh = `${seededPick(ORA_OPEN, seed)}${seededPick(ORA_A, seed+1)}${seededPick(ORA_B, seed+2)}${seededPick(ORA_CLOSE, seed+3)}`;
    const en = 'Oracle: ' + [
      'Calm your fire under red lanterns.',
      'A small win is still a win.',
      'Hold steady like chopsticks; move lightly.',
      'Share the feast; do not eat alone.'
    ][Math.abs(seed)%4];
    return ctx.reply(`${zh}\n${en}`);
  }
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
  const rows = Object.entries(DB.users).map(([uid, u])=>{
    const claims = Object.keys(u.claims || {}).length;
    const refs   = (u.refs || []).length;
    return { uid, claims, refs, score: claims + refs*3 };
  }).sort((a,b)=> b.score - a.score).slice(0,15);

  const zh = rows.length ? rows.map((r,i)=> `${i+1}. ${r.uid} — 供奉${r.claims}次 · 邀请${r.refs}人 · 分数${r.score}`).join('\n') : '暂无数据。';
  const en = rows.length ? rows.map((r,i)=> `${i+1}. ${r.uid} — claims ${r.claims} · refs ${r.refs} · score ${r.score}`).join('\n') : 'No entries yet.';
  await ctx.reply(`🍜 筷子宴榜单 / Feast Board (Top 15)\n${zh}\n\n${en}`);
});

// --------------------------- /lore /site /mint ---------------------------
bot.command('lore', async (ctx)=> { await ctx.reply(LORE_TEXT + `\n\n🔗 ${SITE_URL}`); });
bot.command('site', async (ctx)=> { await ctx.reply(both('🔗 网站：','🔗 Website:') + `\n${SITE_URL}`); });
bot.command('mint', async (ctx)=> {
  await ctx.reply(both('🥢 铸造入口即将开启（仅 BNB 链）。','🥢 Mint coming soon (BNB only).') + `\n${SITE_URL}#mint`);
});

// --------------------------- /fortune (daily) ----------------------------
bot.command('fortune', async (ctx) => {
  const uid = String(ctx.from.id);
  const me = user(uid);
  const d = today();
  if (me.lastFortune === d) {
    return ctx.reply(both('📜 今日签语已抽取。','📜 You already pulled today\'s fortune.'));
  }
  me.lastFortune = d;
  const seed = (uid.length*10007 + Date.now())|0;
  const f = seededPick(FORTUNES, seed);
  await ctx.reply(`🥠 ${f.zh}\n${f.en}`);
  saveDB();
});

// --------------------------- /oracle (Q&A) -------------------------------
bot.command('oracle', async (ctx) => {
  const txt = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
  const uid = String(ctx.from.id);
  if (!txt) {
    WAITING_ORACLE.add(uid);
    return ctx.reply(both('请发来你的问题（或任意一句心声）。','Send me your question (or a short thought).'));
  }
  const seed = (uid.length + txt.length + Date.now())|0;
  const zh = `${seededPick(ORA_OPEN, seed)}${seededPick(ORA_A, seed+1)}${seededPick(ORA_B, seed+2)}${seededPick(ORA_CLOSE, seed+3)}`;
  const en = 'Oracle: ' + [
    'Calm your fire under red lanterns.',
    'A small win is still a win.',
    'Hold steady like chopsticks; move lightly.',
    'Share the feast; do not eat alone.'
  ][Math.abs(seed)%4];
  await ctx.reply(`${zh}\n${en}`);
});

// --------------------------- /help ---------------------------------------
bot.help(async (ctx)=>{
  await ctx.reply(
    '帮助 / Help\n' +
    '• /offer — 发推并粘贴链接后领取每日供奉 / Tweet & paste URL, then claim daily offering\n' +
    '• /referrals — 邀请与专属链接 / Referral stats & link\n' +
    '• /feast — 榜单 / Leaderboard\n' +
    '• /lore — 筷子传说 / Legend\n' +
    '• /site — 网站 / Website\n' +
    '• /mint — 铸造（即将开启）/ Mint (soon)\n' +
    '• /fortune — 今日签语 / Daily fortune\n' +
    '• /oracle — 神谕问答 / Poetic oracle Q&A'
  );
});

// ---------------------- Hourly reminder (cron) ---------------------------
function boundGroup(){ return DB.boundGroup || GROUP_ID_ENV || null; }
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
  console.log('🚀 Feast Hall Monk Bot is live (full build).');
  console.log('Bound Group:', DB.boundGroup ?? '(none — run /bind in your group)');
  console.log('DB file:', DB_FILE);
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
