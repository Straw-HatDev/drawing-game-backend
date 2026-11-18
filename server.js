const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { WORD_POOL } = require("./words");
const { getBotDrawingSegments, getBotDetailSegments } = require("./botDrawings");

const PORT = Number(process.env.PORT) || 3000;

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 5;
const MAX_ROUNDS = 10;

const INTRO_SPIN_DURATION_MS = 5000;
const INTRO_POST_SPIN_HOLD_MS = 1800;
const WORD_CHOICE_SECONDS = 10;
const DRAW_SECONDS = 30;
const BLASTER_WINDOW_MS = 20 * 1000;
const ROUND_END_PAUSE_MS = 3800;

const SEAT_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"];
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Resolve CORS origin setting.
 * Set CORS_ORIGIN on Render to restrict origins (comma-separated) or omit for "*".
 */
function buildCorsOrigin() {
  const raw = (process.env.CORS_ORIGIN || "*").trim();
  if (!raw || raw === "*") {
    return "*";
  }
  const allowed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return (origin, callback) => {
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS origin not allowed"));
    }
  };
}

const corsOrigin = buildCorsOrigin();

const app = express();
app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "OPTIONS"]
  })
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "live-drawing-game-backend",
    activeRooms: rooms.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

function sanitizeNickname(rawName) {
  if (typeof rawName !== "string") return "Player";
  const cleaned = rawName
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return cleaned || "Player";
}

function makeUniqueNickname(room, desiredName) {
  const base = sanitizeNickname(desiredName);
  const existing = new Set(room.players.map((p) => p.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) {
    return base;
  }
  let counter = 2;
  while (counter < 99) {
    const suffix = ` ${counter}`;
    const candidate = `${base.slice(0, 16 - suffix.length)}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    counter += 1;
  }
  return `${base.slice(0, 12)}_${Math.floor(Math.random() * 900 + 100)}`;
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  return `${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function normalizeWord(text) {
  if (typeof text !== "string") return "";
  return text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = val;
    }
  }
  return dp[m][n];
}

function isCloseGuessMatch(rawGuess, secretWord) {
  const g = normalizeWord(rawGuess);
  const t = normalizeWord(secretWord);
  if (!g || !t) return false;
  if (g === t) return true;

  const len = t.length;
  if (len <= 2 || Math.abs(g.length - len) > 2) return false;

  const dist = damerauLevenshtein(g, t);
  if (len <= 3) {
    return dist === 1 && g.length >= 3 && (g[0] === t[0] || g.length > len);
  }
  if (len <= 5) {
    return dist <= 1;
  }
  if (len <= 7) {
    return dist <= 1 || (dist === 2 && g.length >= 5 && g[0] === t[0]);
  }
  return dist <= 2;
}

function buildWordHint(word) {
  return word
    .split("")
    .map((ch) => (ch === " " ? "  " : "_"))
    .join(" ");
}

function pickRandomWords(usedWords, count = 3) {
  let available = WORD_POOL.filter((w) => !usedWords.has(w));
  if (available.length < count) {
    usedWords.clear();
    available = [...WORD_POOL];
  }
  const pool = [...available];
  const chosen = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

function pickNextDrawer(room) {
  const candidates =
    room.players.length > 1
      ? room.players.filter((p) => p.id !== room.lastDrawerId)
      : room.players;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return pick || room.players[0];
}

function clearRoomTimers(room) {
  if (room.phaseTimeout) {
    clearTimeout(room.phaseTimeout);
    room.phaseTimeout = null;
  }
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
  if (Array.isArray(room.botTimers)) {
    room.botTimers.forEach((id) => clearTimeout(id));
    room.botTimers = [];
  }
}

function addBotTimer(room, fn, ms) {
  if (!Array.isArray(room.botTimers)) room.botTimers = [];
  const id = setTimeout(fn, ms);
  room.botTimers.push(id);
  return id;
}

const ALLOWED_HAIR_STYLES = new Set([
  "classic",
  "spiky",
  "bob",
  "bun",
  "mohawk",
  "curly",
  "ponytail",
  "anime"
]);

const ALLOWED_SHIRT_DECALS = new Set([
  "none",
  "chief",
  "cbert",
  "hunter",
  "fours",
  "tubz",
  "lenny",
  "remig"
]);

const SPECIAL_DECAL_COLORS = {
  chief: "#0ea5e9",
  cbert: "#dc2626",
  hunter: "#10b981",
  fours: "#a855f7",
  tubz: "#f97316",
  lenny: "#ef4444",
  remig: "#d6be8a"
};

function sanitizeAvatar(raw, fallbackShirtColor) {
  const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
  const rawDecal = raw && typeof raw.shirtDecal === "string" ? raw.shirtDecal.toLowerCase() : "none";
  const shirtDecal = ALLOWED_SHIRT_DECALS.has(rawDecal) ? rawDecal : "none";
  const shirtColor =
    shirtDecal !== "none"
      ? SPECIAL_DECAL_COLORS[shirtDecal]
      : raw && isHex(raw.shirtColor)
        ? raw.shirtColor
        : fallbackShirtColor;
  const hairColor = raw && isHex(raw.hairColor) ? raw.hairColor : "#4a2c18";
  const hairStyle =
    raw && ALLOWED_HAIR_STYLES.has(raw.hairStyle) ? raw.hairStyle : "classic";
  return { shirtColor, shirtDecal, hairColor, hairStyle };
}

function serializePlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    isHost: p.id === room.hostId,
    isBot: Boolean(p.isBot),
    seatColor: p.seatColor,
    shirtColor: p.shirtColor,
    shirtDecal: p.shirtDecal || "none",
    hairColor: p.hairColor,
    hairStyle: p.hairStyle
  }));
}

const BOT_PROFILES = [
  { id: "bot_leo", color: "#ef4444" },
  { id: "bot_maya", color: "#22c55e" }
];
const BOT_NAME_POOL = [
  "Leo",
  "Maya",
  "Zoe",
  "Kai",
  "Milo",
  "Nova",
  "Liam",
  "Aria",
  "Noah",
  "Chloe",
  "Evan",
  "Ruby",
  "Owen",
  "Nora",
  "Finn",
  "Ivy",
  "Sam",
  "Jude",
  "Toby",
  "Zara"
];
const BOT_HAIR_COLORS = [
  "#4a2c18",
  "#111827",
  "#eab308",
  "#d97706",
  "#2563eb",
  "#ec4899",
  "#9333ea",
  "#cbd5e1"
];

function pickRandomBotName(takenLowerSet) {
  const candidates = BOT_NAME_POOL.filter(
    (n) => !takenLowerSet.has(n.toLowerCase())
  );
  const pool = candidates.length ? candidates : BOT_NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function createBotPlayer(slotIdx, excludeStyle = null, takenLowerSet = new Set()) {
  const profile = BOT_PROFILES[slotIdx % BOT_PROFILES.length];
  const styles = [...ALLOWED_HAIR_STYLES].filter((s) => s !== excludeStyle);
  const hairStyle = styles[Math.floor(Math.random() * styles.length)] || "classic";
  const hairColor =
    BOT_HAIR_COLORS[Math.floor(Math.random() * BOT_HAIR_COLORS.length)];
  const name = pickRandomBotName(takenLowerSet);
  takenLowerSet.add(name.toLowerCase());
  return {
    id: profile.id,
    name,
    score: 0,
    isHost: false,
    isBot: true,
    seatColor: profile.color,
    shirtColor: profile.color,
    hairColor,
    hairStyle
  };
}

function syncRoomBots(room, desiredCount) {
  const clamped = Math.max(0, Math.min(1, Number(desiredCount) || 0));
  const humans = room.players.filter((p) => !p.isBot);
  const maxAllowedBots = Math.min(1, Math.max(0, MAX_PLAYERS - humans.length));
  const finalBots = Math.min(clamped, maxAllowedBots);

  const existingBots = room.players.filter((p) => p.isBot);
  const takenLower = new Set(humans.map((h) => String(h.name || "").toLowerCase()));
  const nextBots = [];
  for (let i = 0; i < finalBots; i += 1) {
    const profile = BOT_PROFILES[i];
    const existing = existingBots.find((b) => b.id === profile.id);
    if (existing) {
      takenLower.add(String(existing.name || "").toLowerCase());
      nextBots.push(existing);
    } else {
      const otherStyle = nextBots[0] ? nextBots[0].hairStyle : null;
      nextBots.push(createBotPlayer(i, otherStyle, takenLower));
    }
  }
  room.players = [...humans, ...nextBots];
  return finalBots;
}

function buildRoomState(room) {
  const timeLeft =
    room.phaseEndsAt > 0
      ? Math.max(0, Math.ceil((room.phaseEndsAt - Date.now()) / 1000))
      : 0;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    players: serializePlayers(room),
    drawerId: room.drawerId,
    timeLeft,
    wordLength: room.currentWord ? room.currentWord.length : 0,
    wordHint: room.currentWord ? buildWordHint(room.currentWord) : ""
  };
}

function emitRoomState(room) {
  io.to(room.code).emit("room_state", buildRoomState(room));
}

function emitSystemChat(room, text, type = "system") {
  io.to(room.code).emit("chat_message", {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    senderId: "system",
    senderName: "System",
    text,
    type
  });
}

function computeRankings(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted.map((p, index) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    rank: index + 1,
    seatColor: p.seatColor
  }));
}

function startCountdownTicker(room, phaseName, onExpire) {
  clearRoomTimers(room);
  let lastSent = Math.max(0, Math.ceil((room.phaseEndsAt - Date.now()) / 1000));
  io.to(room.code).emit("timer_tick", { phase: phaseName, timeLeft: lastSent });

  room.tickInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((room.phaseEndsAt - Date.now()) / 1000));
    if (remaining !== lastSent) {
      lastSent = remaining;
      io.to(room.code).emit("timer_tick", { phase: phaseName, timeLeft: remaining });
    }
    if (Date.now() >= room.phaseEndsAt) {
      clearRoomTimers(room);
      onExpire();
    }
  }, 200);
}

function startNewMatch(room) {
  clearRoomTimers(room);
  room.round = 1;
  room.drawerId = null;
  room.lastDrawerId = null;
  room.currentWord = null;
  room.wordOptions = [];
  room.usedWords = new Set();
  room.strokes = [];
  room.roundWinnerId = null;
  const now = Date.now();
  room.players.forEach((p) => {
    p.score = 0;
    // Random initial Paint Blaster wait between 50s and 120s per player
    const waitSec = 50 + Math.floor(Math.random() * 71);
    p.blasterReadyAt = now + waitSec * 1000;
  });

  // Randomly select first drawer for the Round 1 spinwheel
  const firstDrawer = room.players[Math.floor(Math.random() * room.players.length)];
  room.pendingFirstDrawerId = firstDrawer.id;
  room.phase = "intro_spin";
  room.phaseEndsAt = 0;

  emitRoomState(room);
  io.to(room.code).emit("clear_board");
  emitSystemChat(room, "Match started! Spinning the wheel for Round 1 Drawer...");

  io.to(room.code).emit("intro_spin", {
    round: 1,
    players: serializePlayers(room),
    winnerId: firstDrawer.id,
    winnerName: firstDrawer.name,
    durationMs: INTRO_SPIN_DURATION_MS
  });

  room.players.forEach((p) => {
    if (!p.isBot) {
      io.to(p.id).emit("blaster_state", { readyAt: p.blasterReadyAt });
    }
  });

  room.phaseTimeout = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.players.length < 2) {
      finishGame(room, "Not enough players remaining.");
      return;
    }
    const chosen =
      room.players.find((p) => p.id === room.pendingFirstDrawerId) ||
      room.players[0];
    beginWordChoice(room, chosen);
  }, INTRO_SPIN_DURATION_MS + INTRO_POST_SPIN_HOLD_MS);
}

function beginWordChoice(room, drawer) {
  clearRoomTimers(room);
  room.phase = "word_choice";
  room.drawerId = drawer.id;
  room.lastDrawerId = drawer.id;
  room.currentWord = null;
  room.strokes = [];
  room.roundWinnerId = null;
  room.wordOptions = pickRandomWords(room.usedWords, 3);
  room.phaseEndsAt = Date.now() + WORD_CHOICE_SECONDS * 1000;

  io.to(room.code).emit("clear_board");
  emitRoomState(room);
  io.to(room.code).emit("phase_word_choice", {
    round: room.round,
    maxRounds: MAX_ROUNDS,
    drawerId: drawer.id,
    drawerName: drawer.name,
    timeLeft: WORD_CHOICE_SECONDS
  });

  // Send the 3 word options privately to human drawer, or auto-pick for a bot
  if (drawer.isBot) {
    addBotTimer(room, () => {
      if (!rooms.has(room.code) || room.phase !== "word_choice") return;
      const botWord =
        room.wordOptions[Math.floor(Math.random() * room.wordOptions.length)] ||
        WORD_POOL[0];
      beginDrawingPhase(room, botWord);
    }, 1600);
  } else {
    io.to(drawer.id).emit("drawer_word_options", {
      words: room.wordOptions,
      timeLeft: WORD_CHOICE_SECONDS
    });
  }

  emitSystemChat(room, `Round ${room.round}: ${drawer.name} is choosing a word...`);

  startCountdownTicker(room, "word_choice", () => {
    if (!rooms.has(room.code) || room.phase !== "word_choice") return;
    const autoWord =
      room.wordOptions[Math.floor(Math.random() * room.wordOptions.length)] ||
      WORD_POOL[0];
    beginDrawingPhase(room, autoWord);
  });
}

function beginDrawingPhase(room, chosenWord) {
  clearRoomTimers(room);
  room.phase = "drawing";
  room.currentWord = chosenWord;
  room.usedWords.add(chosenWord);
  room.wordOptions = [];
  room.strokes = [];
  room.drawInkDistance = 0;
  room.drawStrokeCount = 0;
  room.roundStartTime = Date.now();
  room.phaseEndsAt = room.roundStartTime + DRAW_SECONDS * 1000;

  const drawer = room.players.find((p) => p.id === room.drawerId);
  if (!drawer) {
    finishRound(room, "drawer_left", null);
    return;
  }

  emitRoomState(room);

  // Public payload never includes the secret word
  io.to(room.code).emit("phase_drawing", {
    round: room.round,
    maxRounds: MAX_ROUNDS,
    drawerId: drawer.id,
    drawerName: drawer.name,
    timeLeft: DRAW_SECONDS,
    wordLength: chosenWord.length,
    wordHint: buildWordHint(chosenWord)
  });

  if (!drawer.isBot) {
    // Private payload only for human drawer
    io.to(drawer.id).emit("drawer_secret_word", {
      word: chosenWord
    });
  }

  emitSystemChat(room, `${drawer.name} started drawing! Guess the word!`);

  startCountdownTicker(room, "drawing", () => {
    if (!rooms.has(room.code) || room.phase !== "drawing") return;
    finishRound(room, "timeout", null);
  });

  if (drawer.isBot) {
    scheduleServerBotDrawing(room, chosenWord);
    scheduleServerBotsGuessingBot(room, drawer.id, chosenWord);
  } else {
    scheduleServerBotsGuessingHuman(room, chosenWord);
  }
}

function getRoomDrawCompleteness(room) {
  const distFactor = Math.min(1, (room.drawInkDistance || 0) / 1.8);
  const countFactor = Math.min(1, (room.drawStrokeCount || 0) / 4);
  return Math.min(1, distFactor * 0.75 + countFactor * 0.25);
}

function scheduleServerBotDrawing(room, word) {
  const segments = getBotDrawingSegments(word);
  if (!segments.length) return;

  const rawTotal = segments.reduce((sum, s) => sum + (s.delayMs || 50), 0);
  const targetTotal = Math.min(22000, Math.max(12500, rawTotal * 1.25));
  const timeScale = rawTotal > 0 ? targetTotal / rawTotal : 1;
  let idx = 0;

  const emitSeg = (seg) => {
    const stroke = {
      x0: seg.x0,
      y0: seg.y0,
      x1: seg.x1,
      y1: seg.y1,
      color: seg.color,
      size: seg.size,
      isDot: Boolean(seg.isDot)
    };
    room.strokes.push(stroke);
    io.to(room.code).emit("draw_stroke", stroke);
  };

  const startDetailPass = () => {
    if (!rooms.has(room.code) || room.phase !== "drawing") return;
    const detailSegs = getBotDetailSegments(word, segments._transformMeta);
    if (!detailSegs.length) return;
    let dIdx = 0;

    const detailTick = () => {
      if (!rooms.has(room.code) || room.phase !== "drawing") return;
      if (dIdx >= detailSegs.length) {
        addBotTimer(room, startDetailPass, 500);
        return;
      }
      emitSeg(detailSegs[dIdx]);
      dIdx += 1;
      if (dIdx >= detailSegs.length) {
        addBotTimer(room, startDetailPass, 500);
        return;
      }
      const nextDelay = Math.max(60, (detailSegs[dIdx].delayMs || 100) * 1.2);
      addBotTimer(room, detailTick, nextDelay);
    };

    addBotTimer(room, detailTick, 160);
  };

  const drawTick = () => {
    if (!rooms.has(room.code) || room.phase !== "drawing") return;
    if (idx >= segments.length) {
      addBotTimer(room, startDetailPass, 7000);
      return;
    }

    emitSeg(segments[idx]);
    idx += 1;
    if (idx >= segments.length) {
      addBotTimer(room, startDetailPass, 7000);
      return;
    }
    const nextDelay = Math.max(26, (segments[idx].delayMs || 45) * timeScale);
    addBotTimer(room, drawTick, nextDelay);
  };

  const initialDelay = Math.max(350, (segments[0].delayMs || 450) * timeScale);
  addBotTimer(room, drawTick, initialDelay);
}

function scheduleServerBotsGuessingBot(room, botDrawerId, secretWord) {
  const otherBots = room.players.filter((p) => p.isBot && p.id !== botDrawerId);
  if (!otherBots.length) return;

  const decoys = WORD_POOL.filter((w) => w !== secretWord);
  const pickDecoy = () => decoys[Math.floor(Math.random() * decoys.length)];
  const guesserBot = otherBots[0];

  [8500, 17500, 24000].forEach((delay) => {
    addBotTimer(room, () => {
      if (!rooms.has(room.code) || room.phase !== "drawing") return;
      io.to(room.code).emit("chat_message", {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        senderId: guesserBot.id,
        senderName: guesserBot.name,
        text: pickDecoy(),
        type: "guess"
      });
    }, delay);
  });

  const solveAt = 26500 + Math.random() * 2500;
  addBotTimer(room, () => {
    if (!rooms.has(room.code) || room.phase !== "drawing") return;
    finishRound(room, "guessed", guesserBot);
  }, solveAt);
}

function scheduleServerBotsGuessingHuman(room, secretWord) {
  const bots = room.players.filter((p) => p.isBot);
  if (!bots.length) return;

  const decoys = WORD_POOL.filter((w) => w !== secretWord);
  const usedDecoys = new Set();
  const pickDecoy = () => {
    for (let i = 0; i < 15; i += 1) {
      const w = decoys[Math.floor(Math.random() * decoys.length)];
      if (!usedDecoys.has(w)) {
        usedDecoys.add(w);
        return w;
      }
    }
    return decoys[Math.floor(Math.random() * decoys.length)];
  };

  let turnIdx = 0;
  const attemptBotGuess = () => {
    if (!rooms.has(room.code) || room.phase !== "drawing") return;

    const bot = bots[turnIdx % bots.length];
    turnIdx += 1;

    const elapsedSec = (Date.now() - room.roundStartTime) / 1000;
    const completeness = getRoomDrawCompleteness(room);

    if (
      Date.now() >= (bot.blasterReadyAt || Infinity) &&
      Date.now() - (room.roundStartTime || 0) < BLASTER_WINDOW_MS &&
      completeness >= 0.25
    ) {
      bot.blasterReadyAt = Date.now() + 220 * 1000;
      room.drawInkDistance *= 0.2;
      const seed = Math.floor(Math.random() * 1000000000);
      io.to(room.code).emit("paint_blaster_splat", {
        byId: bot.id,
        byName: bot.name,
        seed
      });
      emitSystemChat(room, `💥 ${bot.name} fired the Paint Blaster!`);
    }

    const requiredSeconds = Math.max(15, 27 - completeness * 9);
    if (completeness > 0.5 && elapsedSec >= requiredSeconds) {
      finishRound(room, "guessed", bot);
      return;
    }

    const msgText =
      completeness < 0.08 && elapsedSec < 12 && turnIdx === 1
        ? "Waiting to see the first lines..."
        : pickDecoy();

    io.to(room.code).emit("chat_message", {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId: bot.id,
      senderName: bot.name,
      text: msgText,
      type: "guess"
    });

    const nextDelay = 6200 + Math.random() * 3300;
    addBotTimer(room, attemptBotGuess, nextDelay);
  };

  addBotTimer(room, attemptBotGuess, 8000);
}

function finishRound(room, reason, winnerPlayer) {
  clearRoomTimers(room);
  room.phase = "round_end";
  room.phaseEndsAt = 0;

  const drawer = room.players.find((p) => p.id === room.drawerId);
  const revealedWord = room.currentWord || "";
  let pointsAwarded = 0;
  let drawerDelta = 0;

  if (reason === "guessed" && winnerPlayer) {
    const elapsedMs = Date.now() - (room.roundStartTime || Date.now());
    const isFastBonus = elapsedMs < 15000;
    const guesserPts = isFastBonus ? 10 : 6;
    const drawerPts = isFastBonus ? 8 : 5;
    pointsAwarded = guesserPts;
    drawerDelta = drawerPts;
    winnerPlayer.score += guesserPts;
    if (drawer) {
      drawer.score += drawerPts;
    }
    emitSystemChat(
      room,
      `🎉 ${winnerPlayer.name}: ${revealedWord} (+${guesserPts} pts)`,
      "correct"
    );
  } else if (reason === "timeout") {
    if (drawer) {
      const before = drawer.score;
      drawer.score = Math.max(0, drawer.score - 3);
      drawerDelta = drawer.score - before;
    }
    emitSystemChat(
      room,
      `Time's up! Nobody guessed "${revealedWord.toUpperCase()}".`,
      "system"
    );
  } else if (reason === "drawer_left") {
    emitSystemChat(room, "Drawer left the match. Advancing to next round...", "system");
  }

  emitRoomState(room);
  io.to(room.code).emit("round_end", {
    round: room.round,
    maxRounds: MAX_ROUNDS,
    reason,
    word: revealedWord,
    drawerId: room.drawerId,
    drawerName: drawer ? drawer.name : "Drawer",
    guesserId: winnerPlayer ? winnerPlayer.id : null,
    guesserName: winnerPlayer ? winnerPlayer.name : null,
    pointsAwarded,
    drawerDelta,
    players: serializePlayers(room)
  });

  room.phaseTimeout = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.players.length < 2) {
      finishGame(room, "Not enough players remaining.");
      return;
    }
    if (room.round >= MAX_ROUNDS) {
      finishGame(room);
      return;
    }
    room.round += 1;
    const nextDrawer = pickNextDrawer(room);
    beginWordChoice(room, nextDrawer);
  }, ROUND_END_PAUSE_MS);
}

function finishGame(room, reasonMessage) {
  clearRoomTimers(room);
  room.phase = "game_over";
  room.phaseEndsAt = 0;
  room.drawerId = null;
  room.currentWord = null;
  room.wordOptions = [];

  if (reasonMessage) {
    emitSystemChat(room, reasonMessage, "system");
  }

  emitRoomState(room);
  io.to(room.code).emit("game_over", {
    rankings: computeRankings(room.players),
    hostId: room.hostId
  });
}

function removePlayerFromRoom(socket, room) {
  const idx = room.players.findIndex((p) => p.id === socket.id);
  if (idx === -1) return;

  const [removed] = room.players.splice(idx, 1);
  socket.leave(room.code);
  socket.data.roomCode = null;

  const humans = room.players.filter((p) => !p.isBot);
  if (humans.length === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === removed.id) {
    room.hostId = humans[0].id;
    humans[0].isHost = true;
  }

  emitSystemChat(room, `${removed.name} left the room.`);

  if (room.phase === "lobby") {
    emitRoomState(room);
    return;
  }

  if (room.phase === "game_over") {
    emitRoomState(room);
    io.to(room.code).emit("game_over", {
      rankings: computeRankings(room.players),
      hostId: room.hostId
    });
    return;
  }

  if (room.players.length < 2) {
    finishGame(room, "Match ended because fewer than 2 players remain.");
    return;
  }

  if (
    removed.id === room.drawerId &&
    (room.phase === "word_choice" || room.phase === "drawing")
  ) {
    finishRound(room, "drawer_left", null);
    return;
  }

  if (room.phase === "intro_spin" && removed.id === room.pendingFirstDrawerId) {
    room.pendingFirstDrawerId = room.players[0].id;
  }

  emitRoomState(room);
}

io.on("connection", (socket) => {
  socket.on("create_room", (payload = {}, callback) => {
    if (socket.data.roomCode) {
      const prevRoom = rooms.get(socket.data.roomCode);
      if (prevRoom) removePlayerFromRoom(socket, prevRoom);
    }

    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      round: 0,
      players: [],
      drawerId: null,
      lastDrawerId: null,
      pendingFirstDrawerId: null,
      currentWord: null,
      wordOptions: [],
      usedWords: new Set(),
      strokes: [],
      roundStartTime: 0,
      phaseEndsAt: 0,
      phaseTimeout: null,
      tickInterval: null
    };

    const avatar = sanitizeAvatar(payload.avatar, SEAT_COLORS[0]);
    const player = {
      id: socket.id,
      name: sanitizeNickname(payload.nickname),
      score: 0,
      isHost: true,
      isBot: false,
      seatColor: avatar.shirtColor,
      shirtColor: avatar.shirtColor,
      shirtDecal: avatar.shirtDecal,
      hairColor: avatar.hairColor,
      hairStyle: avatar.hairStyle
    };

    room.players.push(player);
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    if (typeof callback === "function") {
      callback({
        ok: true,
        roomCode: code,
        playerId: socket.id,
        room: buildRoomState(room)
      });
    }
    emitRoomState(room);
  });

  socket.on("join_room", (payload = {}, callback) => {
    const respond = (data) => {
      if (typeof callback === "function") callback(data);
    };

    const rawCode = typeof payload.roomCode === "string" ? payload.roomCode : "";
    const code = rawCode.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      respond({ ok: false, error: `Room "${code || "----"}" not found.` });
      return;
    }
    if (room.phase !== "lobby") {
      respond({ ok: false, error: "This match is already in progress." });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      respond({ ok: false, error: `Room is full (max ${MAX_PLAYERS} players).` });
      return;
    }

    if (socket.data.roomCode) {
      const prevRoom = rooms.get(socket.data.roomCode);
      if (prevRoom) removePlayerFromRoom(socket, prevRoom);
    }

    const usedColors = new Set(room.players.map((p) => p.seatColor));
    const seatColor =
      SEAT_COLORS.find((c) => !usedColors.has(c)) ||
      SEAT_COLORS[room.players.length % SEAT_COLORS.length];

    const avatar = sanitizeAvatar(payload.avatar, seatColor);
    const player = {
      id: socket.id,
      name: makeUniqueNickname(room, payload.nickname),
      score: 0,
      isHost: false,
      seatColor: avatar.shirtColor,
      shirtColor: avatar.shirtColor,
      shirtDecal: avatar.shirtDecal,
      hairColor: avatar.hairColor,
      hairStyle: avatar.hairStyle
    };

    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;

    respond({
      ok: true,
      roomCode: code,
      playerId: socket.id,
      room: buildRoomState(room)
    });

    emitRoomState(room);
    emitSystemChat(room, `${player.name} joined the room.`);
  });

  socket.on("leave_room", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      removePlayerFromRoom(socket, room);
    }
  });

  socket.on("start_game", (payload = {}, callback) => {
    const respond = (data) => {
      if (typeof callback === "function") callback(data);
    };
    const room = rooms.get(socket.data.roomCode);
    if (!room) {
      respond({ ok: false, error: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
      respond({ ok: false, error: "Only the room host can start the game." });
      return;
    }
    if (room.phase !== "lobby") {
      respond({ ok: false, error: "Match already started." });
      return;
    }
    if (room.players.length < MIN_PLAYERS) {
      respond({
        ok: false,
        error: `Need at least ${MIN_PLAYERS} players to start.`
      });
      return;
    }
    respond({ ok: true });
    startNewMatch(room);
  });

  socket.on("select_word", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "word_choice") return;
    if (room.drawerId !== socket.id) return;

    const chosen = typeof payload.word === "string" ? payload.word.trim().toLowerCase() : "";
    if (!room.wordOptions.includes(chosen)) return;

    beginDrawingPhase(room, chosen);
  });

  socket.on("draw_stroke", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (room.drawerId !== socket.id) return;

    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));
    const x0 = clamp01(payload.x0);
    const y0 = clamp01(payload.y0);
    const x1 = clamp01(payload.x1);
    const y1 = clamp01(payload.y1);
    if ([x0, y0, x1, y1].some((n) => Number.isNaN(n))) return;

    const color =
      typeof payload.color === "string" && /^#[0-9a-fA-F]{6}$/.test(payload.color)
        ? payload.color
        : "#111827";
    const size = Math.max(1, Math.min(48, Number(payload.size) || 6));
    const stroke = {
      x0,
      y0,
      x1,
      y1,
      color,
      size,
      isDot: Boolean(payload.isDot)
    };

    room.strokes.push(stroke);
    if (room.strokes.length > 15000) {
      room.strokes.shift();
    }
    if (color.toLowerCase() !== "#ffffff") {
      if (stroke.isDot) {
        room.drawStrokeCount = (room.drawStrokeCount || 0) + 1;
      }
      room.drawInkDistance =
        (room.drawInkDistance || 0) + Math.hypot(x1 - x0, y1 - y0);
    }

    socket.to(room.code).emit("draw_stroke", stroke);
  });

  socket.on("clear_board", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (room.drawerId !== socket.id) return;

    room.strokes = [];
    room.drawInkDistance = 0;
    room.drawStrokeCount = 0;
    socket.to(room.code).emit("clear_board");
  });

  socket.on("set_room_bots", (payload = {}, callback) => {
    const respond = (data) => {
      if (typeof callback === "function") callback(data);
    };
    const room = rooms.get(socket.data.roomCode);
    if (!room) {
      respond({ ok: false, error: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
      respond({ ok: false, error: "Only the room host can manage bots." });
      return;
    }
    if (room.phase !== "lobby") {
      respond({ ok: false, error: "Bots can only be changed in the lobby." });
      return;
    }
    const desired = Math.max(0, Math.min(1, Number(payload.botCount) || 0));
    const humans = room.players.filter((p) => !p.isBot);
    if (humans.length + desired > MAX_PLAYERS) {
      respond({
        ok: false,
        error: `Room allows max ${MAX_PLAYERS} total players.`
      });
      return;
    }
    const count = syncRoomBots(room, desired);
    emitRoomState(room);
    respond({ ok: true, botCount: count });
  });

  socket.on("submit_guess", (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const rawText = typeof payload.text === "string" ? payload.text : "";
    const text = rawText.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 80);
    if (!text) return;

    if (room.phase === "drawing") {
      // Prevent drawer from guessing or leaking the word in chat
      if (player.id === room.drawerId) {
        return;
      }

      if (isCloseGuessMatch(text, room.currentWord)) {
        finishRound(room, "guessed", player);
        return;
      }
    }

    io.to(room.code).emit("chat_message", {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId: player.id,
      senderName: player.name,
      text,
      type: "guess"
    });
  });

  socket.on("use_paint_blaster", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "drawing") return;
    if (socket.id === room.drawerId) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const now = Date.now();
    if (!room.roundStartTime || now - room.roundStartTime >= BLASTER_WINDOW_MS) {
      return;
    }
    if (now < (player.blasterReadyAt || 0)) {
      io.to(socket.id).emit("blaster_state", { readyAt: player.blasterReadyAt });
      return;
    }

    // Reset player's Paint Blaster cooldown to 220 seconds
    player.blasterReadyAt = now + 220 * 1000;
    io.to(socket.id).emit("blaster_state", { readyAt: player.blasterReadyAt });
    room.drawInkDistance = (room.drawInkDistance || 0) * 0.2;

    const seed = Math.floor(Math.random() * 1000000000);
    io.to(room.code).emit("paint_blaster_splat", {
      byId: player.id,
      byName: player.name,
      seed
    });
    emitSystemChat(room, `💥 ${player.name} fired the Paint Blaster!`);
  });

  socket.on("play_again", (payload = {}, callback) => {
    const respond = (data) => {
      if (typeof callback === "function") callback(data);
    };
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "game_over") {
      respond({ ok: false, error: "Game is not over." });
      return;
    }
    if (room.hostId !== socket.id) {
      respond({ ok: false, error: "Only the room host can restart the match." });
      return;
    }
    if (room.players.length < MIN_PLAYERS) {
      // Return to lobby so more players can join
      room.phase = "lobby";
      room.round = 0;
      room.players.forEach((p) => {
        p.score = 0;
      });
      emitRoomState(room);
      respond({ ok: true, returnedToLobby: true });
      return;
    }
    respond({ ok: true });
    startNewMatch(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      removePlayerFromRoom(socket, room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Live Drawing Game server listening on port ${PORT}`);
});
