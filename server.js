const path = require("path");
const { randomInt } = require("crypto");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, "public")));

const lobbies = new Map();
const lobbyBySocketId = new Map();

const SKINS = new Set(["rifler", "shotgun", "sniper", "heavy"]);
const MAPS = new Set([
  "courtyard", "ruins", "warehouse", "yard", "switchyard",
  "depot", "city", "desert", "mountain", "sea",
]);
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_PLAYERS = 8;
const MAX_POSITION = 10000;
const STALE_MS = 15000;

function cleanProfile(raw = {}) {
  const username = String(raw.username || "Player")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 16) || "Player";
  const skin = SKINS.has(raw.skin) ? raw.skin : "rifler";
  return { username, skin };
}

function profileOwnerKey(raw = {}) {
  return String(raw.ownerKey || "").slice(0, 100);
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[randomInt(CODE_CHARS.length)],
    ).join("");
  } while (lobbies.has(code));
  return code;
}

function publicPlayers(lobby) {
  return [...lobby.players.values()].map((p) => ({
    id: p.id,
    profile: p.profile,
    position: p.position,
    aim: p.aim,
    team: p.team,
    hp: p.hp,
    alive: p.alive,
    readyAgain: lobby.ready.has(p.id),
    stats: { kills: p.kills || 0, deaths: p.deaths || 0, damage: Math.round(p.damage || 0) },
    stale: Date.now() - p.updatedAt > STALE_MS,
  }));
}

function lobbyState(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    phase: lobby.phase,
    mode: lobby.mode,
    config: lobby.config,
    round: lobby.round,
    wins: lobby.wins,
    readyCount: lobby.ready.size,
    mapSeed: lobby.mapSeed || 0,
    spawnSeed: lobby.spawnSeed || 0,
    spawnOrder: lobby.roundSpawnOrder || [],
    draft: lobby.draft || null,
    players: publicPlayers(lobby),
  };
}

function sendLobby(lobby) {
  io.to(lobby.code).emit("lobby:state", lobbyState(lobby));
  io.to(lobby.code).emit("players:snapshot", publicPlayers(lobby));
}

function ack(callback, data) {
  if (typeof callback === "function") callback(data);
}

function getLobby(socket) {
  const code = lobbyBySocketId.get(socket.id);
  return code ? lobbies.get(code) : null;
}

function safeProfile(request) {
  const raw = request && request.profile;
  const username = String(raw?.username || "").replace(/\s+/g, " ").trim();
  if (!username) throw new Error("Type a username before joining.");
  if (!SKINS.has(String(raw?.skin || ""))) throw new Error("Choose an enemy skin before joining.");
  return { profile: cleanProfile(raw), ownerKey: profileOwnerKey(raw) };
}

const NEXT_ROUND_DELAY_MS = 4500;

function startRound(lobby) {
  clearTimeout(lobby.nextRoundTimer);
  lobby.nextRoundTimer = null;
  if (lobby.round === 0) {   // first round of a match: fresh leaderboard
    for (const p of lobby.players.values()) { p.kills = 0; p.deaths = 0; p.damage = 0; }
  }
  lobby.phase = "playing";
  lobby.round += 1;
  // Every client uses the same seeds, so everyone builds the identical map and
  // computes the identical set of spawn slots. Slot order is shuffled per round.
  lobby.mapSeed = lobby.mapSeed || randomInt(1, 0x7fffffff);
  lobby.spawnSeed = randomInt(1, 0x7fffffff);
  lobby.roundSpawnOrder = [...lobby.players.keys()];
  for (let i = lobby.roundSpawnOrder.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [lobby.roundSpawnOrder[i], lobby.roundSpawnOrder[j]] = [lobby.roundSpawnOrder[j], lobby.roundSpawnOrder[i]];
  }
  for (const player of lobby.players.values()) {
    player.hp = lobby.config.health;
    player.alive = true;
    player.position = null;   // the client places itself on a valid spawn and reports it
    player.aim = null;
    player.updatedAt = Date.now();
  }
  sendLobby(lobby);
  io.to(lobby.code).emit("match:started", lobbyState(lobby));
}

function finishRound(lobby, winningTeam) {
  if (lobby.phase !== "playing") return;
  lobby.phase = "round-result";
  if (winningTeam) lobby.wins[winningTeam] += 1;

  const needed = Math.floor(lobby.config.rounds / 2) + 1;
  const matchOver =
    lobby.wins.red >= needed ||
    lobby.wins.blue >= needed ||
    lobby.round >= lobby.config.rounds;

  if (matchOver) lobby.phase = "match-result";
  const matchWinner = lobby.wins.red === lobby.wins.blue
    ? winningTeam
    : lobby.wins.red > lobby.wins.blue ? "red" : "blue";

  io.to(lobby.code).emit("match:result", {
    state: lobbyState(lobby),
    winningTeam: matchOver ? matchWinner : winningTeam,
    roundWinner: winningTeam,
    matchOver,
    nextRoundIn: matchOver ? 0 : NEXT_ROUND_DELAY_MS,
  });
  sendLobby(lobby);

  clearTimeout(lobby.nextRoundTimer);
  if (!matchOver) {
    lobby.nextRoundTimer = setTimeout(() => {
      lobby.nextRoundTimer = null;
      if (lobbies.get(lobby.code) !== lobby || lobby.phase !== "round-result") return;
      const teams = new Set([...lobby.players.values()].map((p) => p.team));
      if (teams.has("red") && teams.has("blue")) return startRound(lobby);
      // a whole team left: the remaining team wins the match
      const remaining = teams.has("red") ? "red" : "blue";
      lobby.wins[remaining] = Math.max(lobby.wins[remaining], Math.floor(lobby.config.rounds / 2) + 1);
      lobby.phase = "match-result";
      io.to(lobby.code).emit("match:result", { state: lobbyState(lobby), winningTeam: remaining, roundWinner: remaining, matchOver: true, nextRoundIn: 0 });
      sendLobby(lobby);
    }, NEXT_ROUND_DELAY_MS);
  }
}

async function leaveLobby(socket) {
  const lobby = getLobby(socket);
  if (!lobby) return;

  lobby.players.delete(socket.id);
  lobbyBySocketId.delete(socket.id);
  lobby.ready.delete(socket.id);
  await socket.leave(lobby.code);

  if (!lobby.players.size) {
    clearTimeout(lobby.nextRoundTimer);
    lobbies.delete(lobby.code);
    return;
  }

  if (lobby.hostId === socket.id) {
    const next = lobby.players.values().next().value;
    lobby.hostId = next.id;
    lobby.hostKey = next.ownerKey || lobby.hostKey;
  }
  sendLobby(lobby);
  io.to(lobby.code).emit("player:disconnected", socket.id);
  if (lobby.phase === "playing") {
    const redAlive = [...lobby.players.values()].some((player) => player.team === "red" && player.alive);
    const blueAlive = [...lobby.players.values()].some((player) => player.team === "blue" && player.alive);
    if (!redAlive || !blueAlive) finishRound(lobby, redAlive ? "red" : blueAlive ? "blue" : null);
  }
}

async function addToLobby(socket, code, profile) {
  await leaveLobby(socket);
  let lobby = lobbies.get(code);

  if (!lobby) {
    lobby = {
      code,
      hostId: socket.id,
      hostKey: profile.ownerKey || randomInt(1, 0x7fffffff).toString(36),
      players: new Map(),
      phase: "lobby",
      mode: null,
      config: null,
      round: 0,
      wins: { red: 0, blue: 0 },
      ready: new Set(),
    };
    lobbies.set(code, lobby);
  }

  if (lobby.players.size >= MAX_PLAYERS) {
    throw new Error("This lobby is full.");
  }

  lobby.players.set(socket.id, {
    id: socket.id,
    profile: profile.profile,
    ownerKey: profile.ownerKey || "",
    position: null,
    aim: null,
    team: null,
    hp: 100,
    alive: true,
    kills: 0,
    deaths: 0,
    damage: 0,
    updatedAt: Date.now(),
  });

  lobbyBySocketId.set(socket.id, code);
  await socket.join(code);
  if (profile.ownerKey && lobby.hostKey === profile.ownerKey) lobby.hostId = socket.id;
  sendLobby(lobby);
  return lobby;
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("lobby:create", async (request, callback) => {
    if (typeof request === "function") {
      callback = request;
      request = {};
    }
    const code = makeCode();
    try {
      const lobby = await addToLobby(socket, code, safeProfile(request));
      ack(callback, { ok: true, code, players: publicPlayers(lobby), hostId: lobby.hostId });
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("lobby:join", async (request = {}, callback) => {
    if (typeof request === "function") {
      callback = request;
      request = {};
    }
    const code = String(request.code || "").trim().toUpperCase();
    const lobby = lobbies.get(code);
    if (!/^[A-Z0-9]{6}$/.test(code) || !lobby) {
      return ack(callback, { ok: false, error: "Lobby code not found." });
    }
    try {
      const profile = safeProfile(request);
      if (["versus-ready", "playing", "round-result", "match-result"].includes(lobby.phase)) {
        return ack(callback, { ok: false, error: "This lobby is not accepting players during a match." });
      }
      const joined = await addToLobby(socket, code, profile);
      ack(callback, { ok: true, code, players: publicPlayers(joined), hostId: joined.hostId });
    } catch (error) {
      ack(callback, { ok: false, error: error.message });
    }
  });

  socket.on("lobby:leave", async (_request, callback) => {
    await leaveLobby(socket);
    ack(typeof _request === "function" ? _request : callback, { ok: true });
  });

  socket.on("lobby:profile", (profile) => {
    const lobby = getLobby(socket);
    const player = lobby?.players.get(socket.id);
    if (!player) return;
    player.profile = cleanProfile(profile);
    player.ownerKey = profileOwnerKey(profile);
    if (player.ownerKey && player.ownerKey === lobby.hostKey) lobby.hostId = socket.id;
    sendLobby(lobby);
  });

  socket.on("lobby:continue", (_data, callback) => {
    const lobby = getLobby(socket);
    if (!lobby) return ack(callback, { ok: false, error: "Join a lobby first." });
    if (lobby.hostId !== socket.id) {
      return ack(callback, { ok: false, error: "Only the lobby host can continue." });
    }
    lobby.phase = "mode-select";
    sendLobby(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  socket.on("match:mode", (mode, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id) {
      return ack(callback, { ok: false, error: "Only the host can choose the mode." });
    }
    if (!["coop", "versus"].includes(mode)) {
      return ack(callback, { ok: false, error: "Invalid game mode." });
    }
    lobby.mode = mode;
    if (mode === "coop") {
      // Co-op: everyone returns to the first menu while staying in the lobby.
      lobby.phase = "lobby";
      sendLobby(lobby);
      io.to(lobby.code).emit("lobby:coop", lobbyState(lobby));
    } else {
      lobby.phase = "versus-setup";
      sendLobby(lobby);
    }
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  // Host cancels setup and returns everyone to the plain lobby.
  socket.on("lobby:cancel", (_d, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id) return ack(callback, { ok: false, error: "Only the host can do that." });
    if (!["mode-select", "versus-setup", "versus-ready"].includes(lobby.phase)) return ack(callback, { ok: false });
    lobby.phase = "lobby";
    lobby.mode = null;
    lobby.draft = null;
    sendLobby(lobby);
    ack(callback, { ok: true });
  });

  // Host's live (unsaved) versus choices, shown read-only to everyone else.
  socket.on("match:draft", (draft = {}) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || lobby.phase !== "versus-setup") return;
    const teams = {};
    for (const id of lobby.players.keys()) teams[id] = draft.teams?.[id] === "blue" ? "blue" : "red";
    lobby.draft = {
      map: MAPS.has(draft.map) ? draft.map : "yard",
      rounds: Math.max(1, Math.min(15, Math.round(Number(draft.rounds) || 5))),
      health: Math.max(25, Math.min(500, Math.round(Number(draft.health) || 100))),
      teams,
    };
    socket.to(lobby.code).emit("lobby:draft", lobby.draft);
  });

  socket.on("match:configure", (config = {}, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || lobby.mode !== "versus") {
      return ack(callback, { ok: false, error: "Only the host can configure versus." });
    }
    if (lobby.phase !== "versus-setup" && lobby.phase !== "versus-ready") {
      return ack(callback, { ok: false, error: "The lobby is not accepting match settings right now." });
    }

    if (lobby.players.size < 2) {
      return ack(callback, { ok: false, error: "At least two players are needed for versus." });
    }
    if (!MAPS.has(config.map)) {
      return ack(callback, { ok: false, error: "Choose one of the available maps." });
    }
    const rounds = Math.max(1, Math.min(15, Math.round(Number(config.rounds) || 5)));
    const health = Math.max(25, Math.min(500, Math.round(Number(config.health) || 100)));

    for (const [index, player] of [...lobby.players.values()].entries()) {
      player.team = config.teams?.[player.id] === "blue"
        ? "blue"
        : config.teams?.[player.id] === "red"
          ? "red"
          : index % 2 === 0 ? "red" : "blue";
    }
    if (![...lobby.players.values()].some((player) => player.team === "red") ||
        ![...lobby.players.values()].some((player) => player.team === "blue")) {
      return ack(callback, { ok: false, error: "Assign at least one player to each team." });
    }
    lobby.config = { map: config.map, rounds, health };
    lobby.phase = "versus-ready";
    sendLobby(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  socket.on("match:start", (_data, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || !lobby.config || lobby.phase !== "versus-ready") {
      return ack(callback, { ok: false, error: "Only the host can start the configured match." });
    }
    lobby.mapSeed = randomInt(1, 0x7fffffff);
    if (![...lobby.players.values()].some((player) => player.team === "red") ||
        ![...lobby.players.values()].some((player) => player.team === "blue")) {
      return ack(callback, { ok: false, error: "Assign at least one player to each team before starting." });
    }
    lobby.wins = { red: 0, blue: 0 };
    lobby.round = 0;
    lobby.ready.clear();
    startRound(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  socket.on("match:next-round", (_data, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || lobby.phase !== "round-result") {
      return ack(callback, { ok: false, error: "Only the host can start the next round." });
    }
    startRound(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  socket.on("match:ready", () => {
    const lobby = getLobby(socket);
    if (lobby && lobby.phase === "match-result" && lobby.players.has(socket.id)) {
      lobby.ready.add(socket.id);
      sendLobby(lobby);
    }
  });

  socket.on("match:play-again", (_data, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || lobby.phase !== "match-result") {
      return ack(callback, { ok: false, error: "Only the host can restart the match." });
    }
    if (lobby.players.size < 2) {
      return ack(callback, { ok: false, error: "At least two players are needed to play again." });
    }
    lobby.wins = { red: 0, blue: 0 };
    lobby.round = 0;
    lobby.ready.clear();
    lobby.mapSeed = randomInt(1, 0x7fffffff);
    startRound(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  socket.on("player:update", (update = {}) => {
    const lobby = getLobby(socket);
    const player = lobby?.players.get(socket.id);
    const p = update.position;
    const a = update.aim;
    if (!player || !p || !a) return;

    const values = [p.x, p.y, p.z, a.yaw, a.pitch];
    if (!values.every(Number.isFinite) || values.slice(0, 3).some((n) => Math.abs(n) > MAX_POSITION)) return;

    player.position = { x: p.x, y: p.y, z: p.z };
    player.aim = {
      yaw: a.yaw,
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, a.pitch)),
    };
    player.updatedAt = Date.now();
    io.to(lobby.code).emit("players:snapshot", publicPlayers(lobby));
  });

  socket.on("match:hit", ({ targetId, damage } = {}) => {
    const lobby = getLobby(socket);
    const shooter = lobby?.players.get(socket.id);
    const target = lobby?.players.get(targetId);
    if (!lobby || lobby.phase !== "playing" || !shooter?.alive || !target?.alive) return;
    if (shooter.id === target.id || !shooter.team || shooter.team === target.team) return;

    // Prototype safeguard only. Hit confirmation still originates in the browser;
    // a competitive game needs server-side raycasts and movement simulation.
    const value = Number(damage);
    if (!Number.isFinite(value) || value <= 0) return;
    const amount = Math.min(120, value);
    shooter.damage += Math.min(target.hp, amount);
    target.hp = Math.max(0, target.hp - amount);
    target.alive = target.hp > 0;
    if (!target.alive) {
      shooter.kills += 1;
      target.deaths += 1;
      io.to(lobby.code).emit("match:kill", {
        killer: shooter.profile.username, killerTeam: shooter.team,
        victim: target.profile.username, victimTeam: target.team,
      });
    }
    sendLobby(lobby);

    if (!target.alive) {
      const remaining = [...lobby.players.values()].filter((p) => p.team === target.team && p.alive);
      if (!remaining.length) finishRound(lobby, shooter.team);
    }
  });

  // Fell into the ocean (sea map): counts as an elimination.
  socket.on("match:fell", () => {
    const lobby = getLobby(socket);
    const p = lobby?.players.get(socket.id);
    if (!lobby || lobby.phase !== "playing" || !p?.alive) return;
    p.hp = 0;
    p.alive = false;
    p.deaths += 1;
    io.to(lobby.code).emit("match:kill", { killer: null, killerTeam: null, victim: p.profile.username, victimTeam: p.team, fell: true });
    sendLobby(lobby);
    const mates = [...lobby.players.values()].filter((q) => q.team === p.team && q.alive);
    if (!mates.length) finishRound(lobby, p.team === "red" ? "blue" : "red");
  });

  socket.on("disconnect", () => {
    void leaveLobby(socket);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
