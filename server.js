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
  "suburb", "terminal", "bazaar",
]);
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_PLAYERS = 8;
const MAX_POSITION = 10000;
const STALE_MS = 15000;
const PLAYER_FALL_MS = 450;   // round ends right after the (now faster) fall animation

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
    loadoutReady: lobby.loadoutReady.has(p.id),
    loadout: p.loadout || [],
    utility: p.utility || "frag",
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
    loadoutMsLeft: lobby.phase === "loadout" ? Math.max(0, lobby.loadoutEndsAt - Date.now()) : 0,
    loadoutTotalMs: LOADOUT_MS,
    mapSeed: lobby.mapSeed || 0,
    spawnSeed: lobby.spawnSeed || 0,
    spawnOrder: lobby.roundSpawnOrder || [],
    draft: lobby.draft || null,
    players: publicPlayers(lobby),
  };
}

function teamCounts(lobby) {
  const c = { red: { alive: 0, total: 0 }, blue: { alive: 0, total: 0 } };
  for (const p of lobby.players.values()) {
    if (!c[p.team]) continue;
    c[p.team].total += 1;
    if (p.alive) c[p.team].alive += 1;
  }
  return c;
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

const LOADOUT_MS = 30000;
const WEAPON_IDS = new Set([1, 2, 3, 4, 5, 6]);
const PRIMARY_WEAPON_IDS = new Set([1, 2, 3, 5]);
const SECONDARY_WEAPON_IDS = new Set([4, 6]);
const UTILITY_IDS = new Set(["frag", "flash", "smoke"]);
const DEFAULT_LOADOUT = [2, 4];

function cleanUtility(raw) {
  return UTILITY_IDS.has(raw) ? raw : "frag";
}

function cleanLoadout(raw) {
  let primary = null, secondary = null;
  for (const id of Array.isArray(raw) ? raw : []) {
    const n = Number(id);
    if (!WEAPON_IDS.has(n)) continue;
    if (PRIMARY_WEAPON_IDS.has(n) && primary === null) primary = n;
    else if (SECONDARY_WEAPON_IDS.has(n) && secondary === null) secondary = n;
  }
  return [primary, secondary].filter((id) => id !== null);
}

function beginLoadout(lobby) {
  clearTimeout(lobby.loadoutTimer);
  clearTimeout(lobby.nextRoundTimer);
  clearTimeout(lobby.roundResultTimer);
  lobby.roundResultTimer = null;
  lobby.pendingRoundWinner = null;
  lobby.phase = "loadout";
  lobby.round = 0;
  lobby.wins = { red: 0, blue: 0 };
  lobby.ready.clear();
  lobby.loadoutReady.clear();
  lobby.mapSeed = randomInt(1, 0x7fffffff);
  lobby.utilityProjectiles?.clear();
  for (const p of lobby.players.values()) { p.loadout = []; p.utility = cleanUtility(p.utility); }
  lobby.loadoutEndsAt = Date.now() + LOADOUT_MS;
  lobby.loadoutTimer = setTimeout(() => endLoadout(lobby), LOADOUT_MS + 250);
  sendLobby(lobby);
}

function endLoadout(lobby) {
  if (lobbies.get(lobby.code) !== lobby || lobby.phase !== "loadout") return;
  clearTimeout(lobby.loadoutTimer);
  lobby.loadoutTimer = null;
  for (const p of lobby.players.values()) {
    p.loadout = cleanLoadout([...(p.loadout || []), ...DEFAULT_LOADOUT]);
  }
  lobby.loadoutReady.clear();
  startRound(lobby);
}

function checkLoadoutReady(lobby) {
  if (lobby.phase !== "loadout" || !lobby.players.size) return;
  const allReady = [...lobby.players.keys()].every((id) => lobby.loadoutReady.has(id));
  if (allReady) endLoadout(lobby);
}

function teamsPresent(lobby) {
  const teams = new Set([...lobby.players.values()].map((p) => p.team));
  return { red: teams.has("red"), blue: teams.has("blue") };
}

// Between rounds everyone must press READY; the next round starts when all have.
function checkRoundReady(lobby) {
  if (lobby.phase !== "round-result" || !lobby.players.size) return;
  const t = teamsPresent(lobby);
  if (!t.red || !t.blue) {
    // a whole team left: the remaining team wins the match
    const remaining = t.red ? "red" : "blue";
    lobby.wins[remaining] = Math.max(lobby.wins[remaining], Math.floor(lobby.config.rounds / 2) + 1);
    lobby.phase = "match-result";
    lobby.ready.clear();
    io.to(lobby.code).emit("match:result", { state: lobbyState(lobby), winningTeam: remaining, roundWinner: remaining, matchOver: true, needReady: false });
    sendLobby(lobby);
    return;
  }
  if ([...lobby.players.keys()].every((id) => lobby.ready.has(id))) startRound(lobby);
}

function startRound(lobby) {
  clearTimeout(lobby.nextRoundTimer);
  lobby.nextRoundTimer = null;
  clearTimeout(lobby.roundResultTimer);
  lobby.roundResultTimer = null;
  lobby.pendingRoundWinner = null;
  if (lobby.round === 0) {   // first round of a match: fresh leaderboard
    for (const p of lobby.players.values()) { p.kills = 0; p.deaths = 0; p.damage = 0; }
  }
  lobby.ready.clear();
  lobby.phase = "playing";
  lobby.round += 1;
  lobby.utilityProjectiles?.clear();
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
    player.utilityAmmo = 1;
    player.utilityCooldownUntil = 0;
    player.position = null;   // the client places itself on a valid spawn and reports it
    player.aim = null;
    player.updatedAt = Date.now();
  }
  sendLobby(lobby);
  io.to(lobby.code).emit("match:started", lobbyState(lobby));
}

function finishRound(lobby, winningTeam) {
  if (lobby.phase !== "playing") return;
  clearTimeout(lobby.roundResultTimer);
  lobby.roundResultTimer = null;
  lobby.pendingRoundWinner = null;
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

  lobby.ready.clear();
  io.to(lobby.code).emit("match:result", {
    state: lobbyState(lobby),
    winningTeam: matchOver ? matchWinner : winningTeam,
    roundWinner: winningTeam,
    matchOver,
    needReady: !matchOver,
  });
  sendLobby(lobby);
}

function finishRoundAfterFall(lobby, winningTeam) {
  if (lobby.phase !== "playing" || lobby.roundResultTimer) return;
  lobby.pendingRoundWinner = winningTeam;
  lobby.roundResultTimer = setTimeout(() => {
    lobby.roundResultTimer = null;
    if (lobbies.get(lobby.code) !== lobby || lobby.phase !== "playing") return;
    const winner = lobby.pendingRoundWinner;
    lobby.pendingRoundWinner = null;
    finishRound(lobby, winner);
  }, PLAYER_FALL_MS);
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
    clearTimeout(lobby.loadoutTimer);
    clearTimeout(lobby.roundResultTimer);
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
  lobby.loadoutReady.delete(socket.id);
  if (lobby.phase === "loadout") checkLoadoutReady(lobby);
  if (lobby.phase === "round-result") checkRoundReady(lobby);
  if (lobby.phase === "playing") {
    const redAlive = [...lobby.players.values()].some((player) => player.team === "red" && player.alive);
    const blueAlive = [...lobby.players.values()].some((player) => player.team === "blue" && player.alive);
    if ((!redAlive || !blueAlive) && !lobby.roundResultTimer) {
      finishRound(lobby, redAlive ? "red" : blueAlive ? "blue" : null);
    }
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
      loadoutReady: new Set(),
      utilityProjectiles: new Map(),
      loadoutEndsAt: 0,
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
    utility: "frag",
    utilityAmmo: 0,
    utilityCooldownUntil: 0,
    lastUtilityAt: 0,
    hp: 100,
    alive: true,
    kills: 0,
    deaths: 0,
    damage: 0,
    updatedAt: Date.now(),
  });

  lobbyBySocketId.set(socket.id, code);
  await socket.join(code);
  // NOTE: host is only ever the lobby creator (or the next player if the host leaves).
  // The old ownerKey check handed host to anyone sharing the creator's browser storage.
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
      if (["versus-ready", "loadout", "playing", "round-result", "match-result"].includes(lobby.phase)) {
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
    beginLoadout(lobby);
    ack(callback, { ok: true, state: lobbyState(lobby) });
  });

  // Loadout screen: players send their (up to) 2 weapons and a ready flag.
  socket.on("loadout:set", (data = {}) => {
    const lobby = getLobby(socket);
    const player = lobby?.players.get(socket.id);
    if (!lobby || !player || lobby.phase !== "loadout") return;
    player.loadout = cleanLoadout(data.weapons);
    player.utility = cleanUtility(data.utility);
    if (data.ready && player.loadout.length === 2) lobby.loadoutReady.add(socket.id);
    else lobby.loadoutReady.delete(socket.id);
    sendLobby(lobby);
    checkLoadoutReady(lobby);
  });

  // End of round: every player clicks READY; the next round starts once all have.
  // (At match end it just marks you as wanting to play again.)
  socket.on("match:ready", (_d, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || !lobby.players.has(socket.id)) return ack(callback, { ok: false });
    if (lobby.phase === "round-result") {
      lobby.ready.add(socket.id);
      sendLobby(lobby);
      checkRoundReady(lobby);
      return ack(callback, { ok: true });
    }
    if (lobby.phase === "match-result") {
      lobby.ready.add(socket.id);
      sendLobby(lobby);
      return ack(callback, { ok: true });
    }
    ack(callback, { ok: false });
  });

  socket.on("match:play-again", (_data, callback) => {
    const lobby = getLobby(socket);
    if (!lobby || lobby.hostId !== socket.id || lobby.phase !== "match-result") {
      return ack(callback, { ok: false, error: "Only the host can restart the match." });
    }
    if (lobby.players.size < 2) {
      return ack(callback, { ok: false, error: "At least two players are needed to play again." });
    }
    beginLoadout(lobby);   // new match: everyone picks weapons again
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

  socket.on("match:utility", (data = {}) => {
    const lobby = getLobby(socket);
    const player = lobby?.players.get(socket.id);
    if (!lobby || lobby.phase !== "playing" || !player?.alive) return;
    const type = data.type;
    const position = data.position;
    const velocity = data.velocity;
    const projectileId = typeof data.projectileId === "string" ? data.projectileId : "";
    const fuseByType = { frag: 1.9, flash: 0.9, smoke: 1.0 };
    if (!UTILITY_IDS.has(type) || type !== player.utility || player.utilityAmmo <= 0) return;
    if (!/^[a-zA-Z0-9:_-]{1,96}$/.test(projectileId) || !position || !velocity) return;
    const pos = [position.x, position.y, position.z];
    const vel = [velocity.x, velocity.y, velocity.z];
    if (![...pos, ...vel].every(Number.isFinite) || pos.some((n) => Math.abs(n) > MAX_POSITION)) return;
    if (Math.hypot(...vel) > 80 || Date.now() < player.utilityCooldownUntil || Date.now() - player.lastUtilityAt < 300) return;
    if (!(lobby.utilityProjectiles instanceof Map)) lobby.utilityProjectiles = new Map();
    for (const [id, projectile] of lobby.utilityProjectiles) {
      if (projectile.expiresAt <= Date.now()) lobby.utilityProjectiles.delete(id);
    }
    if (lobby.utilityProjectiles.has(projectileId)) return;
    player.utilityAmmo -= 1;
    player.lastUtilityAt = Date.now();
    player.utilityCooldownUntil = Date.now() + (type === "frag" ? 15000 : 12000);
    lobby.utilityProjectiles.set(projectileId, { ownerId: socket.id, type, expiresAt: Date.now() + 8000, shotInteractionUsed: false });
    socket.to(lobby.code).emit("match:utility", {
      playerId: socket.id, projectileId, type,
      position: { x: position.x, y: position.y, z: position.z },
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      fuse: fuseByType[type], serverTime: Date.now(),
    });
  });

  socket.on("match:utility-hit", (data = {}) => {
    const lobby = getLobby(socket);
    const shooter = lobby?.players.get(socket.id);
    const projectileId = typeof data.projectileId === "string" ? data.projectileId : "";
    const weaponId = Number(data.weaponId);
    const direction = data.direction;
    const projectile = lobby?.utilityProjectiles?.get(projectileId);
    if (!lobby || lobby.phase !== "playing" || !shooter?.alive || !projectile || projectile.expiresAt <= Date.now()) return;
    if ((weaponId !== 1 && weaponId !== 3) || !shooter.loadout?.includes(weaponId)) return;
    if (!direction || ![direction.x, direction.y, direction.z].every(Number.isFinite)) return;
    const magnitude = Math.hypot(direction.x, direction.y, direction.z);
    if (magnitude < 0.5 || magnitude > 1.5 || projectile.shotInteractionUsed) return;
    const action = weaponId === 1 ? "detonate" : "boost";
    projectile.shotInteractionUsed = true;
    if (action === "detonate") lobby.utilityProjectiles.delete(projectileId);
    io.to(lobby.code).emit("match:utility-hit", {
      projectileId, shooterId: socket.id, weaponId, action,
      direction: { x: direction.x / magnitude, y: direction.y / magnitude, z: direction.z / magnitude },
    });
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
        killerId: shooter.id, victimId: target.id, killer: shooter.profile.username, killerTeam: shooter.team,
        victim: target.profile.username, victimTeam: target.team,
        counts: teamCounts(lobby),
      });
    }
    sendLobby(lobby);

    if (!target.alive) {
      const remaining = [...lobby.players.values()].filter((p) => p.team === target.team && p.alive);
      if (!remaining.length) finishRoundAfterFall(lobby, shooter.team);
    }
  });

  socket.on("match:self-hit", ({ damage } = {}) => {
    const lobby = getLobby(socket);
    const player = lobby?.players.get(socket.id);
    const value = Number(damage);
    if (!lobby || lobby.phase !== "playing" || !player?.alive || !Number.isFinite(value) || value <= 0) return;
    player.hp = Math.max(0, player.hp - Math.min(120, value));
    player.alive = player.hp > 0;
    if (!player.alive) player.deaths += 1;
    sendLobby(lobby);
    if (!player.alive) {
      io.to(lobby.code).emit("match:kill", { victimId: player.id, killer: null, killerTeam: null, victim: player.profile.username, victimTeam: player.team, fell: true, counts: teamCounts(lobby) });
      const mates = [...lobby.players.values()].filter((q) => q.team === player.team && q.alive);
      if (!mates.length) finishRoundAfterFall(lobby, player.team === "red" ? "blue" : "red");
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
    io.to(lobby.code).emit("match:kill", { victimId: p.id, killer: null, killerTeam: null, victim: p.profile.username, victimTeam: p.team, fell: true, counts: teamCounts(lobby) });
    sendLobby(lobby);
    const mates = [...lobby.players.values()].filter((q) => q.team === p.team && q.alive);
    if (!mates.length) finishRoundAfterFall(lobby, p.team === "red" ? "blue" : "red");
  });

  socket.on("disconnect", () => {
    void leaveLobby(socket);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
