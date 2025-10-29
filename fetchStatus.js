// Made with ❤️ by Barcodew

import fetch from "node-fetch";
import fs from "fs";
import path from "path";

// ====== CONFIG LOAD ======
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

const savedMsgFile = "./last_message_id.txt";
const seenTodayFile = "./seen_today.json";

// ====== UTIL WAKTU ======
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

function formatShortTime(d) {
  return d.toLocaleTimeString("id-ID", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// YYYY-MM-DD lokal (biar reset harian bener sesuai zona kamu)
function getLocalDateString() {
  const now = new Date();
  // toLocaleDateString, tapi kita mau format 2025-10-29
  const y = now.toLocaleString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }); // "2025-10-29"
  return y;
}

// ====== SEEN TODAY STORAGE ======
function loadSeenTodayStore() {
  const today = getLocalDateString();
  try {
    if (!fs.existsSync(seenTodayFile)) {
      return { date: today, names: [] };
    }
    const raw = fs.readFileSync(seenTodayFile, "utf8");
    const parsed = JSON.parse(raw);

    // kalau tanggal beda -> reset
    if (parsed.date !== today) {
      return { date: today, names: [] };
    }
    if (!Array.isArray(parsed.names)) {
      return { date: today, names: [] };
    }
    return parsed;
  } catch {
    return { date: today, names: [] };
  }
}

function saveSeenTodayStore(store) {
  fs.writeFileSync(
    seenTodayFile,
    JSON.stringify(store, null, 2),
    "utf8"
  );
}

// ====== SCRAPE MODERATOR DARI GIST (LIVE) ======
async function getModeratorData() {
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

  // Ambil baris kode di gist (tiap baris di dalam <td class="blob-code ...">)
  const lineMatches = [
    ...html.matchAll(
      /<td[^>]*class="blob-code[^"]*"[^>]*>([\s\S]*?)<\/td>/gi
    ),
  ];

  const rawLines = lineMatches
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

  // Parser undercover
  function parseNameForUndercover(rawName) {
    const name = rawName.trim();

    // kailyx-undercover | kailyx_undercover | kailyx undercover
    const m = name.match(/^(.+?)[\-_ ]?undercover$/i);
    if (m) {
      return { cleanName: m[1].trim(), isUndercover: true };
    }

    // kailyx (undercover), kailyx-Undercover, kailyx[undercover]
    const m2 = name.match(/^(.+?)\s*[\(\[\-]?undercover[\)\]\-]?$/i);
    if (m2) {
      return { cleanName: m2[1].trim(), isUndercover: true };
    }

    return { cleanName: name, isUndercover: false };
  }

  // Ambil store lama (supaya "seen today" gak hilang pas mereka offline)
  const store = loadSeenTodayStore();
  const stillOnlineMods = [];

  for (const rawLine of rawLines) {
    const p = parseNameForUndercover(rawLine);

    // Masukkan ke list online saat ini
    stillOnlineMods.push({
      name: rawLine,
      cleanName: p.cleanName,
      undercover: p.isUndercover,
      seenRange: "", // bisa diisi nanti kalau kamu punya jam range
      durationText: "", // bisa diisi nanti kalau punya durasi aktif
    });

    // Simpan ke store names (union)
    if (!store.names.includes(p.cleanName)) {
      store.names.push(p.cleanName);
    }
  }

  // Simpan kembali store harian (persist)
  saveSeenTodayStore(store);

  return {
    modsOnline: stillOnlineMods,
    seenTodayList: store.names, // <- pakai store, bukan hanya online sekarang
  };
}

// ====== PLAYER COUNT / ONLINE USER ======
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

// ====== BIKIN EMBED ======
function buildEmbed({ playerInfo, modsOnline, seenTodayList }) {
  const now = new Date();

  const onlineCount = playerInfo?.online ?? "N/A";

  // Baris moderator online
  let onlineModsLines = "Tidak ada moderator online.";
  if (modsOnline.length > 0) {
    onlineModsLines = modsOnline
      .map((m) => {
        const base = m.cleanName || m.name || "unknown";

        const undercoverLabel = m.undercover
          ? " (<:undercover:1404369826293747834> Undercover)"
          : "";

        let suffix = "";
        if (m.durationText) suffix += ` — ${m.durationText}`;
        if (m.seenRange) suffix += ` (${m.seenRange})`;

        return `${base}${undercoverLabel}${suffix}`;
      })
      .join("\n");
  }

  // List "Mods Seen Today" -> pakai store.names (persist)
  const seenTodayBlock =
    seenTodayList && seenTodayList.length
      ? seenTodayList.join("\n")
      : "—";

  const todayStr = now.toLocaleDateString("id-ID", {
    timeZone: timezone,
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const lastUpdateHuman = formatFullDateTime(now);
  const lastUpdateShort = formatShortTime(now);

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
            value: onlineModsLines,
            inline: false,
          },
          {
            name: `📅 Mods Seen Today (${todayStr})`,
            value: seenTodayBlock,
            inline: false,
          },
        ],
        footer: {
          text: `Last Update: ${lastUpdateHuman} ${lastUpdateShort}`,
        },
        timestamp: now.toISOString(),
      },
    ],
  };
}

// ====== DISCORD MESSAGE MANAGEMENT ======
function getExistingMessageId() {
  if (staticMessageId && staticMessageId.trim() !== "") {
    return staticMessageId.trim();
  }
  if (fs.existsSync(savedMsgFile)) {
    const fromFile = fs.readFileSync(savedMsgFile, "utf8").trim();
    if (fromFile) return fromFile;
  }
  return null;
}

function saveMessageId(id) {
  if (staticMessageId && staticMessageId.trim() !== "") return;
  fs.writeFileSync(savedMsgFile, id);
}

async function sendOrEditWebhook(payload) {
  const msgId = getExistingMessageId();

  if (msgId) {
    const editUrl = `${webhookUrl}/messages/${msgId}`;
    const res = await fetch(editUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      console.warn(
        `[WARN] Gagal edit message ${msgId} (${res.status}): ${bodyText}`
      );

      // fallback kirim pesan baru
      const newRes = await fetch(webhookUrl + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!newRes.ok) {
        const t2 = await newRes.text();
        throw new Error(
          `Gagal POST fallback: HTTP ${newRes.status} ${t2}`
        );
      }

      const newData = await newRes.json();
      saveMessageId(newData.id);
      console.log(`[INFO] New message posted with id ${newData.id}`);
    } else {
      console.log(`[INFO] Edited message ${msgId}`);
    }
  } else {
    // pertama kali post
    const res = await fetch(webhookUrl + "?wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gagal POST pertama: ${res.status} ${t}`);
    }

    const data = await res.json();
    saveMessageId(data.id);
    console.log(`[INFO] First message posted with id ${data.id}`);
  }
}

// ====== MAIN LOOP ======
async function postStatusOnce() {
  try {
    const [modData, playerInfo] = await Promise.all([
      getModeratorData(),
      getPlayerData(),
    ]);

    const payload = buildEmbed({
      playerInfo,
      modsOnline: modData.modsOnline,
      seenTodayList: modData.seenTodayList,
    });

    await sendOrEditWebhook(payload);
    console.log(`[OK] Update terkirim ${new Date().toISOString()}`);
  } catch (err) {
    console.error("[ERR]", err.message);
  }
}

postStatusOnce();

if (postIntervalSeconds && Number(postIntervalSeconds) > 0) {
  setInterval(postStatusOnce, Number(postIntervalSeconds) * 1000);
}
