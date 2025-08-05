// Dependencies
const { DateTime } = require('luxon');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const { google } = require('googleapis');

// ========== Config ==========
const USER_DATA_FILE = './userData.json';
const SPREADSHEET_ID = '1bTqN2BJ-aud6R1zgy5x3rlBdH9YWYo7BZfEzv8jL6bc';
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const MAX_SHEET_RETRIES = 5;
const SHEET_BACKOFF_BASE_MS = 500;

// ========== State ==========
let userData = {};
let saveQueue = Promise.resolve();
let sheets;
const checkIns = {};

// ========== Safe JSON Load ==========
const userDataReady = (async function loadUserData() {
  if (!existsSync(USER_DATA_FILE)) return;
  try {
    const raw = await fs.readFile(USER_DATA_FILE, 'utf8');
    userData = JSON.parse(raw);
    console.log('✅ userData loaded.');
  } catch (e) {
    console.warn('⚠️ Failed to parse userData.json, starting fresh.', e);
    userData = {};
  }
})();

// ========== Serialized Save ==========
function saveUserData() {
  saveQueue = saveQueue
    .then(() => fs.writeFile(USER_DATA_FILE, JSON.stringify(userData, null, 2), 'utf8'))
    .catch(err => console.error('❌ Failed writing userData.json:', err));
}

// ========== Google Sheets Init ==========
const sheetsReady = (async () => {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'google-credentials.json',
      scopes: GOOGLE_SCOPES
    });
    const client = await auth.getClient();
    sheets = google.sheets({ version: 'v4', auth: client });
    console.log('✅ Google Sheets initialized.');
  } catch (err) {
    console.error('❌ Google Sheets init failed:', err.message);
    sheets = null;
  }
})();

// ========== Helpers ==========
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getNowMinutes(zone) {
  const dt = DateTime.now().setZone(zone);
  return dt.hour * 60 + dt.minute;
}

function formatDate(dt, fmt) {
  return dt.toFormat(fmt);
}

async function appendToSheet(discordUser, username, result) {
  await sheetsReady;
  if (!sheets) {
    console.warn('⚠️ Sheets unavailable, skipping log.');
    return;
  }

  const user = userData[discordUser];
  const zone = user?.timezone || 'UTC';
  const now = DateTime.now().setZone(zone);
  const row = [
    discordUser,
    username,
    formatDate(now, 'dd/MM/yyyy'),
    formatDate(now, 'HH:mm'),
    result,
    zone
  ];

  for (let attempt = 1; attempt <= MAX_SHEET_RETRIES; attempt++) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] }
      });
      console.log('✅ Logged to Google Sheet.');
      return;
    } catch (err) {
      const delay = SHEET_BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`⚠️ Sheet append error (attempt ${attempt}): ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.error('❌ All retries failed for Google Sheets append.');
}

// ========== Discord Client Setup ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

console.log("🤖 Bot script starting...");

// ========== Role Management ==========
const roleThresholds = [
  { threshold: 100, name: "🔥🧠 Chống Lười LV10" },
  { threshold: 50,  name: "⚡👑 Chống Lười LV9" },
  { threshold: 30,  name: "🌄💪 Chống Lười LV8" },
  { threshold: 21,  name: "☀️🧘 Chống Lười LV7" },
  { threshold: 14,  name: "🐓🔔 Chống Lười LV6" },
  { threshold: 10,  name: "🎯⏰ Chống Lười LV5" },
  { threshold: 7,   name: "😎🌅 Chống Lười LV4" },
  { threshold: 5,   name: "😴🔓 Chống Lười LV3" },
  { threshold: 3,   name: "🐢⏳ Chống Lười LV2" },
  { threshold: 1,   name: "🛌💤 Chống Lười LV1" }
];

async function updateRole(member, streak) {
  if (!member || !member.guild) return;
  const guild = member.guild;

  const toRemove = roleThresholds
    .map(r => guild.roles.cache.find(role => role.name === r.name))
    .filter(Boolean);

  const matched = roleThresholds
    .filter(r => streak >= r.threshold)
    .sort((a, b) => b.threshold - a.threshold)[0];
  if (!matched) return;

  const role = guild.roles.cache.find(r => r.name === matched.name);
  if (!role) {
    console.warn(`⚠️ Missing role "${matched.name}" in server.`);
    return;
  }

  try {
    await member.roles.remove(toRemove);
    await member.roles.add(role);
    console.log(`🎖 Assigned "${matched.name}" to ${member.user.username}.`);
  } catch (e) {
    console.error(`❌ Role update failed for ${member.user.username}:`, e.message);
  }
}

// ========== Message Handler ==========
client.on('messageCreate', async message => {
  await userDataReady;

  if (message.author.bot) return;
  const userId = message.author.id;
  const username = message.author.username;

  // Always use user timezone for date calculations!
  const zone = userData[userId]?.timezone || "UTC";
  const now = DateTime.now().setZone(zone);
  const today = now.toISODate();
  const yesterday = now.minus({ days: 1 }).toISODate();

  // ====== Register Command ======
  if (message.content.startsWith('!register')) {
    const re = /^!register\s+wake\s+(\d{2}:\d{2})\s+sleep\s+(\d{2}:\d{2})\s+timezone\s+(.+)$/i;
    const m = message.content.match(re);
    if (!m) {
      return message.reply(
        "⚠️ Usage: `!register wake HH:MM sleep HH:MM timezone Region/City`"
      );
    }

    const [_, wake, sleep, tz] = m;
    const test = DateTime.now().setZone(tz);
    if (!test.isValid) {
      return message.reply(`❌ Invalid timezone \`${tz}\`. Use IANA like \`Asia/Ho_Chi_Minh\`.`);
    }

    // If user already exists, update schedule but keep their streak/logs
    if (userData[userId]) {
      userData[userId].wake = wake;
      userData[userId].sleep = sleep;
      userData[userId].timezone = tz;
      saveUserData();
      return message.reply(
        `✅ Schedule updated!\n• Wake: ${wake}\n• Sleep: ${sleep}\n• TZ: ${tz}\n• Streak: ${userData[userId].streak} days`
      );
    }

    // If not, create new user entry
    userData[userId] = {
      wake, sleep, timezone: tz,
      streak: 0, lastSuccessDate: null,
      logs: []
    };
    saveUserData();

    return message.reply(
      `✅ Registered!\n• Wake: ${wake}\n• Sleep: ${sleep}\n• TZ: ${tz}`
    );
  }
//wake up 
  if (message.content === '!wakeup') {
    if (!userData[userId]) {
      return message.reply(
        "❌ You need to register first with `!register wake HH:MM sleep HH:MM timezone Region/City`."
      );
    }

    // Use user's timezone for all calculations!
    const zone = userData[userId].timezone;
    const now = DateTime.now().setZone(zone);
    const today = now.toISODate();
    const yesterday = now.minus({ days: 1 }).toISODate();

    // Prevent double check-in for today!
    if (userData[userId].lastSuccessDate === today) {
      return message.reply("⏰ Already checked in today!");
    }

    let member;
    if (message.guild) {
      try { member = await message.guild.members.fetch(userId); } catch {}
    }

    const nowMin = getNowMinutes(zone);
    const goalMin = toMinutes(userData[userId].wake);
    const grace = 30;
    const onTime = nowMin >= goalMin - grace && nowMin <= goalMin + grace;
    const status = onTime ? '✅ On Time' : '❌ Late';

    let streak = userData[userId].streak || 0;
    const lastDay = userData[userId].lastSuccessDate;

    if (onTime) {
      if (lastDay === yesterday) {
        streak += 1;
      } else {
        streak = 1;
      }
      userData[userId].lastSuccessDate = today;
      userData[userId].streak = streak;
      if (member) await updateRole(member, streak);
    } else {
      // If late, reset streak if missed a day (not today or yesterday)
      if (lastDay && lastDay !== today && lastDay !== yesterday) {
        streak = 0;
        userData[userId].streak = 0;
        userData[userId].lastSuccessDate = null;
        message.reply("⚠️ You missed yesterday. Streak reset to 0.");
      }
      // If just late but not missed a day, keep current streak and lastSuccessDate.
    }

    const nowStr = now.toFormat('HH:mm');
    userData[userId].logs = [
      `${today} – ${nowStr} – ${status}`,
      ...userData[userId].logs
    ].slice(0, 5);

    checkIns[userId] = checkIns[userId] || {};
    checkIns[userId][today] = true;
    saveUserData();

    appendToSheet(userId, username, status);

    return message.reply(
      `${status} – Logged at ${nowStr}\nCurrent streak: ${userData[userId].streak}`
    );
  }

  // ====== Profile Command ======
  if (message.content === '!profile') {
    const d = userData[userId];
    if (!d) return message.reply("❌ Not registered yet.");
    const logs = d.logs.length
      ? d.logs.map((l, i) => `#${i+1}: ${l}`).join('\n')
      : 'No logs yet.';
    return message.reply(
      `📊 Your Profile\n• Wake: ${d.wake}\n• Sleep: ${d.sleep}\n` +
      `• Streak: ${d.streak} days\n• Recent:\n${logs}`
    );
  }

  // ====== Top Command ======
  if (message.content === '!top') {
    if (!message.guild) return message.reply("❌ Leaderboard works only in a server.");

    const entries = Object.entries(userData)
      .map(([uid, d]) => ({ uid, streak: d.streak }))
      .filter(x => x.streak > 0)
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 10);

    if (!entries.length) return message.reply("📉 No active streaks yet!");

    const board = await Promise.all(
      entries.map(async (e, i) => {
        let name;
        try {
          const m = await message.guild.members.fetch(e.uid);
          name = m.user.username;
        } catch {
          name = `<@${e.uid}>`;
        }
        return `**${i+1}.** ${name} – 🔥 ${e.streak}`;
      })
    );

    return message.reply(`🏆 Top Wake Streaks:\n${board.join('\n')}`);
  }
});

// ========== Start Bot ==========
client.login(process.env.TOKEN)
  .then(() => console.log("🚀 Bot login successful"))
  .catch(err => console.error("❌ Bot login failed:", err));

