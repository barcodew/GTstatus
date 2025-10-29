// Made with ❤️ by Barcodew (durasi tracking version)

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

// Files for persistence
const modStateFile = "./mod_state.json";

// ====== TIME HELPERS ======

// Dapatkan waktu sekarang dalam timezone kamu, tapi kita simpan sebagai ISO string + offset kira-kira.
// Node.js Date ga punya native timezone convert tanpa lib tambahan, jadi kita simpan UTC ISO
// dan untuk tampilan jam HH:mm kita format pakai locale "id-ID" + timezone.
function nowDate() {
  return new Date();
}

// format HH:mm di timezone lokal
function fmtHHMM(d) {
  return d.toLocaleTimeString("id-ID", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// format durasi antara dua Date -> "X jam Y menit" / "Z menit"
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours} jam ${minutes} menit`;
  } else if (hours > 0 && minutes === 0) {
    return `${hours} jam`;
  } else {
    return `${minutes} menit`;
  }
}

// full timestamp for footer
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

// date string harian untuk reset state, pakai timezone kamu
function getLocalDateString() {
  const now = new Date();
  const ymd = now.toLocaleString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }); // e.g. "2025-10-29"
  return ymd;
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

    // if stale day => reset
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

  // kailyx-undercover / kailyx_undercover / kailyx undercover
  const m = name.match(/^(.+?)[\-_ ]?undercover$/i);
  if (m) {
    return { cleanName: m[1].trim(), undercover: true };
  }

  // kailyx (undercover) / kailyx-Undercover / kailyx[undercover]
  const m2 = name.match(/^(.+?)\s*[\(\[\-]?undercover[\)\]\-]?$/i);
  if (m2) {
    return { cleanName: m2[1].trim(), undercover: true };
  }

  return { cleanName: name, undercover: false };
}

// ====== SCRAPE CURRENT ONLINE MOD NAMES FROM GIST ======
async function fetchCurrentlyOnlineNames() {
  const res = await fetch(moderatorSourcePage, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Gagal fetch moderatorSourcePage: HTTP ${res.status}`);
  }

  const html = await res.text();

  // Kalau gist diblokir Cloudflare / error page, ya sudah -> return empty list
  if (!html.includes("blob-code")) {
    console.warn("[WARN] Gist tidak mengandung blob-code (mungkin rate limited)");
    return [];
  }

  const lineMatches = [
    ...html.matchAll(
      /<td[^>]*class="blob-code[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
    ),
  ];

  const names = lineMatches
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

  // names = ["misthios", "kailyx-undercover", "windyplay", ...]
  return names;
}

// ====== UPDATE STATE DENGAN ONLINE SEKARANG ======
function updateModStateWithOnlineList(state, currentNames, now) {
  // 1. Tandai semua offline dulu
  for (const modName in state.mods) {
    state.mods[modName].online = false;
  }

  // 2. Masukkan / update yang online sekarang
  for (const rawName of currentNames) {
    const { cleanName, undercover } = parseNameForUndercover(rawName);

    // kalau mod belum pernah ada di state hari ini → inisialisasi
    if (!state.mods[cleanName]) {
      state.mods[cleanName] = {
        firstSeen: now.toISOString(), // pertama kali terdeteksi online hari ini
        lastSeen: now.toISOString(),  // juga set initial lastSeen
        undercover,
        online: true,
      };
    } else {
      // sudah ada, update lastSeen dan status + undercover (kalau undercover berubah)
      state.mods[cleanName].lastSeen = now.toISOString();
      state.mods[cleanName].online = true;
      state.mods[cleanName].undercover = undercover || state.mods[cleanName].undercover;
    }
  }
}

// ====== REBUILD OUTPUT DATA UNTUK EMBED ======
function buildModeratorSummary(state) {
  // state.mods = {
  //   "kailyx": {
  //      firstSeen: "2025-10-29T14:36:12.000Z",
  //      lastSeen:  "2025-10-29T16:35:10.000Z",
  //      undercover: true,
  //      online: true
  //   },
  //   "windyplay": {...}
  // }

  const now = nowDate();

  // helper: make clean display for one mod
  function modDisplayBlock(name, data, includeOnlineBadge) {
    const first = new Date(data.firstSeen);
    const last = new Date(data.lastSeen);

    // durasi total = lastSeen - firstSeen
    const durText = formatDuration(last - first);

    // range jam: HH:mm–HH:mm
    const rangeText = `${fmtHHMM(first)}–${fmtHHMM(last)}`;

    // undercover tag
    const undercoverLabel = data.undercover
      ? " (<:undercover:1404369826293747834> Undercover)"
      : "";

    const statusLabel = includeOnlineBadge ? " (<a:ONLINE:1196722325463248937> Online)" : "";


    return `${name}${undercoverLabel}${statusLabel} — ${durText} (${rangeText})`;
  }

  const currentlyOnlineLines = Object.entries(state.mods)
    .filter(([_, data]) => data.online)
    .sort((a, b) => a[0].localeCompare(b[0])) // urut alfabet
    .map(([name, data]) => modDisplayBlock(name, data, true));

  const seenTodayLines = Object.entries(state.mods)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => {
      return modDisplayBlock(name, data, false);
    });

  return {
    currentlyOnlineText:
      currentlyOnlineLines.length > 0
        ? currentlyOnlineLines.join("\n")
        : "Tidak ada moderator online.",
    seenTodayText:
      seenTodayLines.length > 0 ? seenTodayLines.join("\n") : "—",
  };
}

// ====== GET PLAYER COUNT ======
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
    raw: data,
  };
}

// ====== BUILD EMBED ======
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
        title: `Growtopia Status`,
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

// ====== PATCH SATU PESAN SAJA ======
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

    // 1. ambil state lama
    let state = loadModState();

    // 2. ambil daftar nama online saat ini dari gist
    const currentOnlineNames = await fetchCurrentlyOnlineNames();

    // 3. update state dengan daftar nama tersebut
    updateModStateWithOnlineList(state, currentOnlineNames, now);

    // 4. simpan state setelah update
    saveModState(state);

    // 5. generate summary text (online sekarang dan riwayat hari ini)
    const summary = buildModeratorSummary(state);

    // 6. ambil jumlah pemain online
    const playerInfo = await getPlayerData();

    // 7. bentuk payload embed
    const payload = buildEmbed({
      playerInfo,
      summary,
    });

    // 8. kirim PATCH ke webhook
    await sendOrEditWebhook(payload);

    console.log(
      `[OK] Update terkirim ${new Date().toISOString()} | OnlinePlayers:${playerInfo.online} | ModsOnlineNow:${Object.values(state.mods).filter(m => m.online).length} | ModsSeenToday:${Object.keys(state.mods).length}`
    );
  } catch (err) {
    console.error("[FATAL]", err.message);
  }
}

// jalankan sekali
postStatusOnce();

// lalu ulangi tiap interval detik
if (postIntervalSeconds && Number(postIntervalSeconds) > 0) {
  setInterval(postStatusOnce, Number(postIntervalSeconds) * 1000);
}
