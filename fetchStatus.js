// Made with ❤️ by Barcodew (durasi tracking + auto reset session + strict offline logic, fixed session continuity)

import fetch from "node-fetch";
import fs from "fs";

// ====== LOAD CONFIG ======
const cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const {
  webhookUrl,
  messageId: staticMessageId,
  moderatorSourcePage,
  playerSource,
  serverName,
  timezone,
  postIntervalSeconds,
} = cfg;

// ====== FILE STATE ======
const modStateFile = "./mod_state.json";

// ====== TIME HELPERS ======

function nowDate() {
  return new Date();
}

function fmtHHMM(d) {
  return d.toLocaleTimeString("id-ID", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours} jam ${minutes} menit`;
  } else if (hours > 0) {
    return `${hours} jam`;
  } else {
    return `${minutes} menit`;
  }
}

function formatFullDateTime(d) {
  return d.toLocaleString("id-ID", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getLocalDateString() {
  const now = new Date();
  return now.toLocaleString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
}

// ====== STATE STORAGE ======

function loadModState() {
  const today = getLocalDateString();

  try {
    if (!fs.existsSync(modStateFile)) {
      return { date: today, mods: {} };
    }

    const raw = fs.readFileSync(modStateFile, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed.date !== today) {
      return { date: today, mods: {} };
    }

    if (!parsed.mods || typeof parsed.mods !== "object") {
      return { date: today, mods: {} };
    }

    return parsed;
  } catch {
    return { date: today, mods: {} };
  }
}

function saveModState(state) {
  fs.writeFileSync(modStateFile, JSON.stringify(state, null, 2), "utf8");
}

// ====== UNDERCOVER DETECTOR ======

function parseNameForUndercover(rawName) {
  const name = rawName.trim();

  const m = name.match(/^(.+?)[\-_ ]?undercover$/i);
  if (m) {
    return { cleanName: m[1].trim(), undercover: true };
  }

  const m2 = name.match(/^(.+?)\s*[\(\[\-]?undercover[\)\]\-]?$/i);
  if (m2) {
    return { cleanName: m2[1].trim(), undercover: true };
  }

  return { cleanName: name, undercover: false };
}

// ====== FETCH CURRENT MODS ONLINE DARI GIST ======

async function fetchCurrentlyOnlineNames() {
  const res = await fetch(moderatorSourcePage, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  if (!res.ok) {
    console.warn(
      `[WARN] Gagal fetch moderatorSourcePage: HTTP ${res.status} -> anggap tidak ada mod online`
    );
    return [];
  }

  const html = await res.text();

  if (!html.includes("blob-code")) {
    console.warn(
      "[WARN] Halaman gist tidak mengandung class blob-code (kemungkinan rate limited). Anggap semua offline."
    );
    return [];
  }

  const matches = [
    ...html.matchAll(
      /<td[^>]*class="blob-code[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
    ),
  ];

  const names = matches
    .map((m) => m[1] || "")
    .map((cellHtml) =>
      cellHtml
        .replace(/<span[^>]*>/gi, "")
        .replace(/<\/span>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .trim()
    )
    .filter(Boolean);

  return names;
}

// ====== UPDATE STATE DENGAN DATA ONLINE SEKARANG ======
//
// FIX PENTING:
// - Kita ambil snapshot status sebelumnya (wasOnline)
//   supaya kita tahu siapa yang *masih online* vs siapa yang *reconnect*.
// - Baru setelah itu kita set semuanya offline, lalu apply data baru.
//
// Alur baru:
// 1. Ambil "wasOnline" untuk tiap mod dari state lama
// 2. Set semua online=false
// 3. Untuk setiap nama yang muncul sekarang:
//    - kalau belum pernah ada di state -> buat sesi baru
//    - kalau ada tapi wasOnline==false -> reconnect, RESET session
//    - kalau ada dan wasOnline==true -> lanjut, update lastSeen saja
//
function updateModStateWithOnlineList(state, currentNames, now) {
  // Snapshot status lama
  const prevOnlineStatus = {};
  for (const modName in state.mods) {
    prevOnlineStatus[modName] = state.mods[modName].online === true;
  }

  // Tandai semua offline dulu
  for (const modName in state.mods) {
    state.mods[modName].online = false;
  }

  // Update yang online sekarang
  for (const rawName of currentNames) {
    const { cleanName, undercover } = parseNameForUndercover(rawName);
    const existing = state.mods[cleanName];

    if (!existing) {
      // Pertama kali muncul hari ini -> sesi baru
      state.mods[cleanName] = {
        firstSeen: now.toISOString(),
        lastSeen: now.toISOString(),
        undercover,
        online: true,
      };
    } else {
      const wasOnline = prevOnlineStatus[cleanName] === true;

      if (!wasOnline) {
        // Dia sebelumnya OFFLINE (atau baru ada tapi offline),
        // sekarang muncul lagi -> start sesi baru
        existing.firstSeen = now.toISOString();
        existing.lastSeen = now.toISOString();
        existing.online = true;
        existing.undercover = undercover || existing.undercover;
      } else {
        // Dia masih online dari loop sebelumnya -> lanjut durasi
        existing.lastSeen = now.toISOString();
        existing.online = true;
        existing.undercover = undercover || existing.undercover;
      }
    }
  }
}

// ====== BUILD TEKS UNTUK EMBED ======

function buildModeratorSummary(state) {
  function buildLine(name, data, includeOnlineBadge) {
    const first = new Date(data.firstSeen);
    const last = new Date(data.lastSeen);

    const durText = formatDuration(last - first);
    const rangeText = `${fmtHHMM(first)}–${fmtHHMM(last)}`;

    const undercoverText = data.undercover
      ? " (<:undercover:1404369826293747834> Undercover)"
      : "";

    const onlineText = includeOnlineBadge ? " (<a:ONLINE:1196722325463248937> Online)" : "";

    return `${name}${undercoverText}${onlineText} — ${durText} (${rangeText})`;
  }

  // Moderator yang lagi online SEKARANG
  const currentlyOnlineLines = Object.entries(state.mods)
    .filter(([_, data]) => data.online)
    // urutkan menurut lama sesi sekarang (paling lama di atas)
    .sort(
      (a, b) =>
        new Date(a[1].firstSeen).getTime() -
        new Date(b[1].firstSeen).getTime()
    )
    .map(([name, data]) => buildLine(name, data, true));

  // Semua moderator yang pernah muncul hari ini
  const seenTodayLines = Object.entries(state.mods)
    // urutkan menurut lastSeen terbaru duluan (paling baru aktivitasnya di atas)
    .sort(
      (a, b) =>
        new Date(b[1].lastSeen).getTime() -
        new Date(a[1].lastSeen).getTime()
    )
    .map(([name, data]) => buildLine(name, data, false));

  return {
    currentlyOnlineText:
      currentlyOnlineLines.length > 0
        ? currentlyOnlineLines.join("\n")
        : "Tidak ada moderator online.",
    seenTodayText:
      seenTodayLines.length > 0 ? seenTodayLines.join("\n") : "—",
  };
}

// ====== PLAYER DATA ======

async function getPlayerData() {
  const res = await fetch(playerSource, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Gagal fetch playerSource: HTTP ${res.status}`);
  }

  const data = await res.json().catch(async () => {
    const fallbackText = await res.text();
    throw new Error(
      "Response playerSource bukan JSON valid: " +
        fallbackText.slice(0, 200)
    );
  });

  return {
    online: data.online_user || data.players || null,
  };
}

// ====== BIKIN EMBED DISCORD ======

function buildEmbed({ playerInfo, summary }) {
  const now = nowDate();

  const onlineCount = playerInfo?.online ?? "N/A";
  const lastUpdateHuman = formatFullDateTime(now);

  const todayStr = now.toLocaleDateString("id-ID", {
    timeZone: timezone,
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  return {
    username: serverName,
    embeds: [
      {
        title: "Growtopia Status",
        color: 5763719,
        fields: [
          {
            name: `<a:ONLINE:1196722325463248937> Online count: ${onlineCount}`,
            value: "",
            inline: false,
          },
          {
            name: "<:ubisoft:1294935740542881862> Moderator/Guardian Currently Online",
            value: summary.currentlyOnlineText,
            inline: false,
          },
          {
            name: `📅 Mods Seen Today (${todayStr})`,
            value: summary.seenTodayText,
            inline: false,
          },
        ],
        footer: {
          text: `Last Update: ${lastUpdateHuman}`,
        },
      },
    ],
  };
}

// ====== PATCH WEBHOOK MESSAGE (ANTI-SPAM) ======

function getExistingMessageId() {
  if (staticMessageId && staticMessageId.trim() !== "") {
    return staticMessageId.trim();
  }
  throw new Error(
    "config.json tidak punya 'messageId'. Tambahkan messageId agar bisa PATCH pesan yang sama."
  );
}

async function sendOrEditWebhook(payload) {
  const msgId = getExistingMessageId();

  const editUrl = `${webhookUrl}/messages/${msgId}`;
  const res = await fetch(editUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    console.error(
      `[ERR] Gagal edit message ${msgId} (${res.status}): ${bodyText}`
    );
    return;
  }

  console.log(
    `[OK] Edited message ${msgId} at ${new Date().toISOString()}`
  );
}

// ====== MAIN LOOP ======

async function postStatusOnce() {
  try {
    const now = nowDate();

    // 1. load state harian
    const state = loadModState();

    // 2. fetch daftar moderator online dari gist
    const currentOnlineNames = await fetchCurrentlyOnlineNames();

    // 3. update state + reset/lanjut sesi
    updateModStateWithOnlineList(state, currentOnlineNames, now);

    // 4. simpan state
    saveModState(state);

    // 5. buat ringkasan teks
    const summary = buildModeratorSummary(state);

    // 6. ambil info jumlah player online
    const playerInfo = await getPlayerData();

    // 7. bentuk payload
    const payload = buildEmbed({
      playerInfo,
      summary,
    });

    // 8. PATCH webhook Discord
    await sendOrEditWebhook(payload);

    console.log(
      `[OK] Update ${new Date().toISOString()} | Players:${playerInfo.online} | ModsOnlineNow:${
        Object.values(state.mods).filter((m) => m.online).length
      } | ModsSeenToday:${Object.keys(state.mods).length}`
    );
  } catch (err) {
    console.error("[FATAL]", err.message);
  }
}

// langsung jalan sekali
postStatusOnce();

// lalu ulangi tiap interval detik
if (postIntervalSeconds && Number(postIntervalSeconds) > 0) {
  setInterval(postStatusOnce, Number(postIntervalSeconds) * 1000);
}
