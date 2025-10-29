// Made with ❤️ by Barcodew

import fetch from "node-fetch";
import fs from "fs";

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

async function getModeratorData() {
  const res = await fetch(moderatorSourcePage, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Gagal fetch moderatorSourcePage: HTTP ${res.status}`);
  }

  const html = await res.text();

  const lineMatches = [
    ...html.matchAll(/<td[^>]*class="blob-code[^"]*"[^>]*>([\s\S]*?)<\/td>/gi),
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

  const seenTodaySet = new Set();
  const modsOnline = [];

  function parseNameForUndercover(rawName) {
    const name = rawName.trim();
    const m = name.match(/^(.+?)[\-_ ]?undercover$/i);
    if (m) {
      return { cleanName: m[1].trim(), isUndercover: true };
    }
    const m2 = name.match(/^(.+?)\s*[\(\[\-]?undercover[\)\]\-]?$/i);
    if (m2) {
      return { cleanName: m2[1].trim(), isUndercover: true };
    }
    return { cleanName: name, isUndercover: false };
  }

  for (const rawLine of rawLines) {
    const p = parseNameForUndercover(rawLine);

    seenTodaySet.add(p.cleanName);

    modsOnline.push({
      name: rawLine,
      cleanName: p.cleanName,
      undercover: p.isUndercover,
      seenRange: "",
      durationText: "",
    });
  }

  return {
    modsOnline,
    seenTodayList: Array.from(seenTodaySet),
  };
}

async function getPlayerData() {
  const res = await fetch(playerSource, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`Gagal fetch playerSource: HTTP ${res.status}`);
  }

  const data = await res.json().catch(async () => {
    const fallbackText = await res.text();
    throw new Error(
      "Response playerSource bukan JSON valid: " + fallbackText.slice(0, 200)
    );
  });

  return {
    online: data.online_user || data.players || null,
    raw: data,
  };
}

function buildEmbed({ playerInfo, modsOnline, seenTodayList }) {
  const now = new Date();

  const onlineCount = playerInfo?.online ?? "N/A";

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

  const seenTodayBlock =
    seenTodayList && seenTodayList.length ? seenTodayList.join("\n") : "—";

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
          text: `Last Update: ${lastUpdateHuman} `,
        },
        timestamp: now.toISOString(),
      },
    ],
  };
}

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
  let msgId = getExistingMessageId();

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

      const newRes = await fetch(webhookUrl + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!newRes.ok) {
        const t2 = await newRes.text();
        throw new Error(`Gagal POST fallback: HTTP ${newRes.status} ${t2}`);
      }

      const newData = await newRes.json();
      saveMessageId(newData.id);
      console.log(`[INFO] New message posted with id ${newData.id}`);
    } else {
      console.log(`[INFO] Edited message ${msgId}`);
    }
  } else {
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
