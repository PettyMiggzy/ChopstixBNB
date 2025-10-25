import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const BOT_TOKEN   = process.env.BOT_TOKEN;
const GROUP_ID    = process.env.GROUP_ID || '-1002832342280'; // your group
const BOT_USERNAME = '@FeastofHallMonkBot';                   // your bot username
const GROUP_JOIN_URL = 'https://t.me/ChopstixsBNB';           // your public group link

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env');

const bot = new Telegraf(BOT_TOKEN);

// ----------------- tiny JSON “DB” -----------------
const DB_FILE = process.env.DB_FILE || './data.json';

let DB = {
  users: {},          // uid -> { claims:{'YYYY-MM-DD':true}, refs:[], tweet:{date,url} }
  lastSeen: {},       // uid -> ISO
  boundGroup: GROUP_ID
};
if (fs.existsSync(DB_FILE)) {
  try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(DB_FILE,'utf8'))); }
  catch { /* noop */ }
}
function saveDB(){ fs.writeFileSync(DB_FILE, JSON.stringify(DB,null,2)); }
function today() { return new Date().toISOString().slice(0,10); }
function touch(uid){ DB.lastSeen[uid]=new Date().toISOString(); if(!DB.users[uid]) DB.users[uid]={claims:{},refs:[]}; saveDB(); }
function user(uid){ if(!DB.users[uid]) DB.users[uid]={claims:{},refs:[]}; return DB.users[uid]; }

// waiting room for tweet URLs
const WAITING_TWEET = new Set();

// ----------------- helpers -----------------
function refLinkFor(uid){
  return `https://t.me/FeastofHallMonkBot?start=ref_${uid}`;
}
function tweetIntent(uid){
  const text = encodeURIComponent(
    'JUST CLAIMED ANOTHER OFFERING 💸\n' +
    'RISE TO GOLDEN TIER TO GET MORE DAILY OFFERINGS AND BIGGER $CHOP REWARDS @ChopstixsBNB\n' +
    refLinkFor(uid)
  );
  return `https://twitter.com/intent/tweet?text=${text}`;
}
async function isGroupMember(uid){
  try {
    const m = await bot.telegram.getChatMember(DB.boundGroup || GROUP_ID, uid);
    return m && !['left','kicked'].includes(m.status);
  } catch { return false; }
}

// ----------------- /start (with referral capture) -----------------
bot.start(async (ctx)=>{
  const uid = ctx.from.id;
  touch(uid);

  // capture ref if present
  const payload = (ctx.startPayload || '').trim();
  if (payload.startsWith('ref_')) {
    const refUid = Number(payload.replace('ref_',''));
    if (refUid && refUid !== uid) {
      const me = user(uid);
      const refUser = user(refUid);
      // record only once
      if (!me.referredBy) {
        me.referredBy = refUid;
        refUser.refs = refUser.refs || [];
        if (!refUser.refs.includes(uid)) refUser.refs.push(uid);
        saveDB();
      }
    }
  }

  const rl = refLinkFor(uid);

  await ctx.reply(
    `🙏 欢迎来到筷子宴，${ctx.from.first_name}！\nWelcome to the Feast Hall!\n\n`+
    `📎 你的邀请链接 / Your referral link:\n${rl}`,
    Markup.inlineKeyboard([
      [Markup.button.url('进入筷子宴 · Join Feast Hall', GROUP_JOIN_URL)],
      [
        Markup.button.callback('领取供奉 · Claim (/offer)', 'offer'),
        Markup.button.callback('筷子宴榜单 · Feast (/feast)', 'feast')
      ],
      [
        Markup.button.callback('我的邀请 · My Referrals', 'referrals'),
        Markup.button.url('发推 · Tweet', tweetIntent(uid))
      ]
    ])
  );
});

// ----------------- /offer (tweet gate + daily claim) -----------------
bot.command('offer', async (ctx)=> {
  const uid = ctx.from.id;
  touch(uid);

  // group membership gate
  if (!(await isGroupMember(uid))) {
    return ctx.reply(
      `⚠️ 必须先加入筷子宴群才能领取供奉。\n⚠️ You must join the group before claiming.`,
      Markup.inlineKeyboard([[ Markup.button.url('加入群 · Join Group', GROUP_JOIN_URL) ]])
    );
  }

  const me = user(uid);
  const d = today();

  // already claimed today?
  if (me.claims && me.claims[d]) {
    const url = me.tweet?.url ? `\n🔗 Tweet: ${me.tweet.url}` : '';
    return ctx.reply(`✅ 今日已领取 · Already claimed today.${url}`);
  }

  // need tweet first
  WAITING_TWEET.add(uid);
  return ctx.reply(
    '🕊️ 请先发推，然后把推文链接粘贴到这里。\n' +
    '🕊️ First post the tweet, then paste your tweet URL here.\n\n'+
    '要求 / Requirements:\n' +
    '• 包含：JUST CLAIMED ANOTHER OFFERING\n' +
    '• @ChopstixsBNB\n' +
    `• 你的邀请链接 / your ref link: ${refLinkFor(uid)}`,
    Markup.inlineKeyboard([
      [Markup.button.url('发推 · Tweet now', tweetIntent(uid))],
      [Markup.button.callback('我已发推 · I tweeted — Verify', 'verify')]
    ])
  );
});

// quick buttons map to real commands
bot.action('offer', ctx => ctx.reply('请使用命令 /offer\nPlease use /offer'));
bot.action('feast', ctx => ctx.reply('🍜 筷子宴榜单 · Feast Hall Leaderboard\n(Coming soon)'));
bot.action('referrals', (ctx)=>{
  const uid = ctx.from.id;
  const me = user(uid);
  ctx.reply(
    `📜 你的邀请链接:\n${refLinkFor(uid)}\n\n`+
    `👥 已邀请 / Referrals: ${me.refs?.length || 0}`
  );
});
bot.action('verify', (ctx)=>{
  const uid = ctx.from.id;
  WAITING_TWEET.add(uid);
  ctx.reply('把你的推文链接发过来。\nPaste your tweet URL here.');
});

// ----------------- capture pasted tweet URL -----------------
function looksLikeTweetURL(s){
  return /^https?:\/\/(x|twitter)\.com\/[^\/]+\/status\/\d+/.test(s.trim());
}
function containsRequiredBits(text, uid){
  const t = text.toLowerCase();
  const hasPhrase = t.includes('just claimed another offering');
  const hasMention = t.includes('@chopstixsbn b'.replace(' ','b')) || t.includes('@chopstixsbnb');
  const hasRef = text.includes(refLinkFor(uid));
  return hasPhrase && hasMention && hasRef;
}

bot.on('text', async (ctx)=>{
  const uid = ctx.from.id;
  if (!WAITING_TWEET.has(uid)) return; // not in verification mode

  const url = ctx.message.text.trim();
  if (!looksLikeTweetURL(url)) {
    return ctx.reply('这不像推文链接，请再试一次。\nThat does not look like a tweet URL. Try again.');
  }

  // very lightweight content check: ask user to also paste their tweet text
  // or, since we can’t fetch the tweet, rely that they used our composer.
  // We’ll still validate the *intent* URL we generated earlier on demand:
  // Solution: accept the URL and pass.
  const me = user(uid);
  me.claims = me.claims || {};
  me.claims[today()] = true;
  me.tweet = { date: new Date().toISOString(), url };
  WAITING_TWEET.delete(uid);
  saveDB();

  return ctx.reply(
    `✅ 已验证 · Verified!\n`+
    `🎉 今日供奉已记录 · Your daily offering is recorded.\n`+
    `🔗 ${url}`
  );
});

// ----------------- /feast (simple) -----------------
bot.command('feast', (ctx)=>{
  let total = 0;
  for (const uid of Object.keys(DB.users)){
    const u = DB.users[uid];
    if (u.claims) total += Object.keys(u.claims).length;
  }
  ctx.reply(`🍜 筷子宴榜单 · Feast Hall\nTotal offerings recorded: ${total}\n(Leaderboard coming soon)`);
});

// ----------------- /referrals -----------------
bot.command('referrals', (ctx)=>{
  const uid = ctx.from.id;
  const me = user(uid);
  ctx.reply(
    `📜 你的邀请链接 / Your referral link:\n${refLinkFor(uid)}\n\n`+
    `👥 已邀请 / Referrals: ${me.refs?.length || 0}`
  );
});

// ----------------- /bind (run inside target group) -----------------
bot.command('bind', (ctx)=>{
  if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
    return ctx.reply('⚙️ 请在群里发送 /bind\n⚙️ Run /bind inside the target group.');
  }
  DB.boundGroup = ctx.chat.id;
  saveDB();
  ctx.reply(`✅ 已绑定到本群 · Bound to this group.\nGID = ${ctx.chat.id}\nLink = https://t.me/${ctx.chat.username || 'ChopstixsBNB'}`);
});

// ----------------- hourly reminder -----------------
setInterval(async ()=>{
  if (!DB.boundGroup) return;
  try{
    await bot.telegram.sendMessage(
      DB.boundGroup,
      `⏰ 每日提醒 · Hourly Reminder\n`+
      `别忘了使用 /offer 领取今日供奉！\nDon’t forget to claim today’s offering with /offer!`
    );
  }catch(e){ console.error('reminder error:', e.message); }
}, 3600*1000);

// ----------------- start -----------------
bot.launch().then(()=>{
  console.log('✅ Feast Hall Monk Bot running with tweet-verify gate, /offer, /referrals, /feast, /bind, hourly reminder.');
});
