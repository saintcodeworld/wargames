require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase Client ───
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Expose Supabase config to the client (anon key only, safe for browser)
app.get('/api/supabase-config', (req, res) => {
  res.json({
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
  });
});

// ─── Accounts & Leaderboard (Supabase-backed) ───
const accountsCache = {}; // In-memory cache for active game sessions
const activeSessions = {}; // { socketId: publicKey }

// Helper: get or create account in Supabase
async function getAccount(publicKey) {
  // Check cache first
  if (accountsCache[publicKey]) return accountsCache[publicKey];
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('public_key', publicKey)
    .single();
  if (error || !data) return null;
  const acc = {
    publicKey: data.public_key,
    privateKey: data.private_key,
    wins: data.wins,
    losses: data.losses,
    kills: data.kills,
    deaths: data.deaths,
    lastActive: new Date(data.last_active).getTime()
  };
  accountsCache[publicKey] = acc;
  return acc;
}

// Helper: save account stats to Supabase
async function saveAccountStats(publicKey) {
  const acc = accountsCache[publicKey];
  if (!acc) return;
  await supabase
    .from('accounts')
    .update({
      wins: acc.wins,
      losses: acc.losses,
      kills: acc.kills,
      deaths: acc.deaths,
      last_active: new Date().toISOString()
    })
    .eq('public_key', publicKey);
}

// Signup: generate Solana wallet
app.post('/api/signup', async (req, res) => {
  try {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const privateKey = bs58.default.encode(keypair.secretKey);

    const { error } = await supabase
      .from('accounts')
      .insert({
        public_key: publicKey,
        private_key: privateKey,
        wins: 0, losses: 0, kills: 0, deaths: 0,
        last_active: new Date().toISOString()
      });

    if (error) {
      console.error('Signup DB error:', error);
      return res.status(500).json({ error: 'Signup failed' });
    }

    accountsCache[publicKey] = { publicKey, privateKey, wins: 0, losses: 0, kills: 0, deaths: 0, lastActive: Date.now() };
    res.json({ publicKey, privateKey });
  } catch (e) {
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Login: validate private key
app.post('/api/login', async (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Private key required' });
    const secretKey = bs58.default.decode(privateKey);
    const keypair = Keypair.fromSecretKey(secretKey);
    const publicKey = keypair.publicKey.toBase58();

    // Check if account exists in Supabase
    let acc = await getAccount(publicKey);
    if (!acc) {
      // Auto-register on first login
      const { error } = await supabase
        .from('accounts')
        .insert({
          public_key: publicKey,
          private_key: privateKey,
          wins: 0, losses: 0, kills: 0, deaths: 0,
          last_active: new Date().toISOString()
        });
      if (error) {
        console.error('Login auto-register error:', error);
        return res.status(500).json({ error: 'Login failed' });
      }
      acc = { publicKey, privateKey, wins: 0, losses: 0, kills: 0, deaths: 0, lastActive: Date.now() };
    }

    // Update last active
    acc.lastActive = Date.now();
    accountsCache[publicKey] = acc;
    await supabase
      .from('accounts')
      .update({ last_active: new Date().toISOString() })
      .eq('public_key', publicKey);

    res.json({ publicKey, privateKey });
  } catch (e) {
    res.status(400).json({ error: 'Invalid private key' });
  }
});

// Get account info
app.get('/api/account/:publicKey', async (req, res) => {
  try {
    const acc = await getAccount(req.params.publicKey);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json({ publicKey: acc.publicKey, wins: acc.wins, losses: acc.losses, kills: acc.kills, deaths: acc.deaths });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// Get leaderboard (sorted by wins, 24h filter)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('accounts')
      .select('public_key, wins, losses, kills, deaths')
      .gte('last_active', oneDayAgo)
      .order('wins', { ascending: false })
      .order('losses', { ascending: true })
      .order('kills', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Leaderboard error:', error);
      return res.json([]);
    }

    const leaders = (data || []).map((a, i) => ({
      rank: i + 1,
      publicKey: a.public_key,
      wins: a.wins,
      losses: a.losses,
      kills: a.kills,
      deaths: a.deaths
    }));
    res.json(leaders);
  } catch (e) {
    res.json([]);
  }
});

// Get recent chat messages (for loading history on connect)
app.get('/api/chat/recent', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.json([]);
    // Reverse so oldest is first
    res.json((data || []).reverse().map(m => ({
      playerName: m.player_name,
      message: m.message,
      publicKey: m.public_key,
      createdAt: m.created_at
    })));
  } catch (e) {
    res.json([]);
  }
});

// Serve favicon from root
app.get('/favicon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.png'));
});

// Serve favicon sizes
app.get('/favicon-32.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon-32.png'));
});
app.get('/favicon-64.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon-64.png'));
});
app.get('/favicon-128.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon-128.png'));
});
app.get('/favicon-192.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'favicon-192.png'));
});

// ─── Game Constants ───
const TICK_RATE = 60;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 600;
const GROUND_Y = 420;
const PLAYER_W = 30;
const PLAYER_H = 50;
const PLAYER_CROUCH_H = 28;
const GRAVITY = 0.6;
const JUMP_FORCE = -12;
const MOVE_SPEED = 4;
const BULLET_SPEED = 12;
const BULLET_DAMAGE = 15;
const RESPAWN_TIME = 3000;

// Trench zones (x ranges where crouching is allowed)
const TRENCH_LEFT = { x1: 50, x2: 350, depth: 40 };
const TRENCH_RIGHT = { x1: 1250, x2: 1550, depth: 40 };

// ─── Room State ───
const rooms = {};
const playerRooms = {}; // Track which room each player is in

function createRoom(roomId, creatorId, mode) {
  return {
    id: roomId,
    players: {},
    bullets: [],
    scores: { usa: 0, iran: 0 },
    roundScores: { usa: 0, iran: 0 }, // Track round wins
    lastTick: Date.now(),
    status: 'waiting',  // waiting, countdown, active, round_end
    createdAt: Date.now(),
    creatorId: creatorId,
    countdownStartTime: null,
    roundEndTime: null, // Track when round ends for restart timer
    currentRound: 1, // Track current round number
    mode: mode, // '1v1' or '2v2'
    maxPlayers: mode === '1v1' ? 2 : 4
  };
}

// Get list of available rooms
function getAvailableRooms() {
  const availableRooms = [];
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const playerCount = Object.keys(room.players).length;
    if (playerCount < room.maxPlayers) {
      availableRooms.push({
        id: roomId,
        playerCount,
        status: room.status,
        createdAt: room.createdAt,
        mode: room.mode,
        maxPlayers: room.maxPlayers
      });
    }
  }
  return availableRooms;
}

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = createRoom(roomId);
  }
  return rooms[roomId];
}

function assignTeam(room) {
  let usa = 0, iran = 0;
  for (const pid in room.players) {
    if (room.players[pid].team === 'usa') usa++;
    else iran++;
  }

  // For 2v2, ensure each team has max 2 players
  if (room.mode === '2v2') {
    if (usa >= 2) return 'iran';
    if (iran >= 2) return 'usa';
  }

  return usa <= iran ? 'usa' : 'iran';
}

function isInTrench(x) {
  return (x >= TRENCH_LEFT.x1 && x <= TRENCH_LEFT.x2) ||
         (x >= TRENCH_RIGHT.x1 && x <= TRENCH_RIGHT.x2);
}

function spawnPosition(team) {
  if (team === 'usa') {
    return { x: 100 + Math.random() * 200, y: GROUND_Y - PLAYER_H };
  } else {
    return { x: 1300 + Math.random() * 200, y: GROUND_Y - PLAYER_H };
  }
}

function createPlayer(id, team) {
  const pos = spawnPosition(team);
  return {
    id,
    team,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    hp: 100,
    alive: true,
    crouching: false,
    jumping: false,
    onGround: true,
    facing: team === 'usa' ? 1 : -1,
    inputs: { left: false, right: false, up: false, down: false },
    inputSeq: 0,
    lastShot: 0,
    respawnAt: 0
  };
}

// ─── Physics Tick ───
function tickRoom(room) {
  if (room.status === 'match_over') return;
  const now = Date.now();
  room.lastTick = now;

  // Update players
  for (const pid in room.players) {
    const p = room.players[pid];

    if (!p.alive) {
      if (p.respawnAt && now >= p.respawnAt) {
        const pos = spawnPosition(p.team);
        p.x = pos.x;
        p.y = pos.y;
        p.vx = 0;
        p.vy = 0;
        p.hp = 100;
        p.alive = true;
        p.crouching = false;
        p.respawnAt = 0;
      }
      continue;
    }

    // Horizontal movement
    p.vx = 0;
    if (p.inputs.left) { p.vx = -MOVE_SPEED; p.facing = -1; }
    if (p.inputs.right) { p.vx = MOVE_SPEED; p.facing = 1; }

    // Crouching — only in trench
    p.crouching = p.inputs.down && isInTrench(p.x + PLAYER_W / 2) && p.onGround;

    // Jumping
    if (p.inputs.up && p.onGround && !p.crouching) {
      p.vy = JUMP_FORCE;
      p.onGround = false;
    }

    // Gravity
    p.vy += GRAVITY;

    // Apply velocity
    p.x += p.vx;
    p.y += p.vy;

    // Ground collision
    const groundLevel = GROUND_Y - (p.crouching ? PLAYER_CROUCH_H : PLAYER_H);
    // If in trench and crouching, player sinks into trench
    const inTrench = isInTrench(p.x + PLAYER_W / 2);
    const effectiveGround = inTrench && p.crouching
      ? GROUND_Y - PLAYER_CROUCH_H + TRENCH_LEFT.depth
      : GROUND_Y - (p.crouching ? PLAYER_CROUCH_H : PLAYER_H);

    if (p.y >= effectiveGround) {
      p.y = effectiveGround;
      p.vy = 0;
      p.onGround = true;
    }

    // Clamp to map
    if (p.x < 0) p.x = 0;
    if (p.x > MAP_WIDTH - PLAYER_W) p.x = MAP_WIDTH - PLAYER_W;
  }

  // Update bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx;

    // Off screen
    if (b.x < -20 || b.x > MAP_WIDTH + 20) {
      room.bullets.splice(i, 1);
      continue;
    }

    // Hit detection
    let hit = false;
    for (const pid in room.players) {
      const p = room.players[pid];
      if (!p.alive || p.id === b.ownerId || p.team === b.team) continue;

      const pH = p.crouching ? PLAYER_CROUCH_H : PLAYER_H;
      const pTop = p.y;
      const pBot = p.y + pH;
      const pLeft = p.x;
      const pRight = p.x + PLAYER_W;

      // Bullet y is at shooting height
      if (b.x >= pLeft && b.x <= pRight && b.y >= pTop && b.y <= pBot) {
        // If crouching in trench, bullet only hits if it's in the head zone (top 12px)
        if (p.crouching && isInTrench(p.x + PLAYER_W / 2)) {
          const headBottom = pTop + 12;
          if (b.y > headBottom) {
            continue; // bullet passes over
          }
        }
        p.hp -= BULLET_DAMAGE;
        hit = true;

        // Notify hit
        io.to(room.id).emit('player_hit', { playerId: p.id, hp: p.hp, shooterId: b.ownerId });

        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          p.respawnAt = now + RESPAWN_TIME;
          if (b.team === 'usa') room.scores.usa++;
          else room.scores.iran++;

          // Update account stats for killer
          const killerPubKey = activeSessions[b.ownerId];
          if (killerPubKey && accountsCache[killerPubKey]) {
            accountsCache[killerPubKey].kills++;
            saveAccountStats(killerPubKey);
          }
          // Update account stats for victim
          const victimPubKey = activeSessions[p.id];
          if (victimPubKey && accountsCache[victimPubKey]) {
            accountsCache[victimPubKey].deaths++;
            saveAccountStats(victimPubKey);
          }
          io.to(room.id).emit('player_killed', { playerId: p.id, killerId: b.ownerId, scores: room.scores });
        }
        break;
      }
    }
    if (hit) {
      room.bullets.splice(i, 1);
    }
  }

  // Broadcast state
  const state = {
    players: {},
    bullets: room.bullets.map(b => ({ x: b.x, y: b.y, team: b.team })),
    scores: room.scores
  };
  for (const pid in room.players) {
    const p = room.players[pid];
    state.players[pid] = {
      id: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      hp: p.hp,
      alive: p.alive,
      crouching: p.crouching,
      facing: p.facing,
      onGround: p.onGround,
      inputSeq: p.inputSeq
    };
  }
  io.to(room.id).emit('game_state', state);

  // Check for team elimination
  if (room.status === 'active') {
    let usaAlive = false;
    let iranAlive = false;

    for (const pid in room.players) {
      const p = room.players[pid];
      if (p.alive) {
        if (p.team === 'usa') usaAlive = true;
        else iranAlive = true;
      }
    }

    // If one team is eliminated
    if (!usaAlive || !iranAlive) {
      room.status = 'round_end';
      room.roundEndTime = Date.now();

      // Update round scores
      if (!usaAlive) room.roundScores.iran++;
      else room.roundScores.usa++;

      // Check for match winner
      const winner = checkMatchWinner(room);
      if (winner) {
        // Update win/loss stats for all players
        for (const pid in room.players) {
          const pubKey = activeSessions[pid];
          if (pubKey && accountsCache[pubKey]) {
            if (room.players[pid].team === winner) {
              accountsCache[pubKey].wins++;
            } else {
              accountsCache[pubKey].losses++;
            }
            accountsCache[pubKey].lastActive = Date.now();
            // Persist stats to Supabase
            saveAccountStats(pubKey);
          }
        }
        io.to(room.id).emit('match_end', { winner });
        room.status = 'match_over';

        // After 5 seconds, kick all players back to lobby
        setTimeout(() => {
          if (!rooms[room.id]) return;
          const socketsInRoom = io.sockets.adapter.rooms.get(room.id);
          if (socketsInRoom) {
            for (const socketId of [...socketsInRoom]) {
              const sock = io.sockets.sockets.get(socketId);
              if (sock) {
                // Send updated stats to each player
                const pubKey = activeSessions[socketId];
                let stats = null;
                if (pubKey && accountsCache[pubKey]) {
                  stats = {
                    wins: accountsCache[pubKey].wins,
                    losses: accountsCache[pubKey].losses,
                    kills: accountsCache[pubKey].kills,
                    deaths: accountsCache[pubKey].deaths
                  };
                }
                sock.emit('return_to_lobby', { stats });
                sock.leave(room.id);
              }
            }
          }
          // Clean up room
          for (const pid in room.players) {
            delete playerRooms[pid];
          }
          delete rooms[room.id];
          io.emit('rooms_updated', getAvailableRooms());
        }, 5000);
      } else {
        io.to(room.id).emit('round_end', {
          roundWinner: !usaAlive ? 'iran' : 'usa',
          roundScores: room.roundScores,
          currentRound: room.currentRound
        });

        // Schedule next round
        setTimeout(() => {
          if (rooms[room.id]) {
            startNewRound(room);
          }
        }, 2000); // 2 second delay
      }
    }
  }
}

function checkMatchWinner(room) {
  if (room.roundScores.usa >= 2) return 'usa';
  if (room.roundScores.iran >= 2) return 'iran';
  return null;
}

function startNewRound(room) {
  room.currentRound++;
  room.status = 'active';
  room.roundEndTime = null;

  // Reset players
  for (const pid in room.players) {
    const player = room.players[pid];
    const pos = spawnPosition(player.team);
    player.x = pos.x;
    player.y = pos.y;
    player.hp = 100;
    player.alive = true;
    player.vx = 0;
    player.vy = 0;
  }

  room.bullets = [];
  io.to(room.id).emit('round_start', { currentRound: room.currentRound });
}

function resetRoom(room) {
  room.roundScores = { usa: 0, iran: 0 };
  room.currentRound = 1;
  room.bullets = [];
  
  for (const pid in room.players) {
    const player = room.players[pid];
    const pos = spawnPosition(player.team);
    player.x = pos.x;
    player.y = pos.y;
    player.hp = 100;
    player.alive = true;
    player.vx = 0;
    player.vy = 0;
  }
}

// ─── Socket Handling ───
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = socket.id;

  // Create room handler
socket.on('create_room', (mode) => {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[roomId] = createRoom(roomId, playerId, mode || '1v1');
  io.emit('rooms_updated', getAvailableRooms());
  
  // Auto-join the creator to their room
  socket.emit('room_created', roomId);
  socket.emit('join_room', roomId);
});

// Get rooms handler
socket.on('get_rooms', () => {
  socket.emit('available_rooms', getAvailableRooms());
});

socket.on('join_room', (roomId) => {
  if (currentRoom) {
    socket.leave(currentRoom);
    const oldRoom = rooms[currentRoom];
    if (oldRoom) {
      delete oldRoom.players[playerId];
      io.to(currentRoom).emit('player_left', playerId);
      io.emit('rooms_updated', getAvailableRooms());
    }
    delete playerRooms[playerId];
  }

  const room = getRoom(roomId);
  if (!room || Object.keys(room.players).length >= room.maxPlayers) {
    socket.emit('join_failed', { message: 'Room is full' });
    return;
  }

  currentRoom = roomId;
  playerRooms[playerId] = roomId;
  socket.join(roomId);
  const team = assignTeam(room);
  room.players[playerId] = createPlayer(playerId, team);

  // Check if room is ready to start
  const playerCount = Object.keys(room.players).length;
  const isRoomFull = playerCount === room.maxPlayers;
  const is1v1Ready = room.mode === '1v1' && playerCount === 2;
  const is2v2Ready = room.mode === '2v2' && playerCount === 4;

  if (isRoomFull || is1v1Ready || is2v2Ready) {
    room.status = 'countdown';
    room.countdownStartTime = Date.now();
    io.to(roomId).emit('game_countdown_start');
    
    // Start the game after 3 seconds
    setTimeout(() => {
      if (rooms[roomId]) {
        rooms[roomId].status = 'active';
        io.to(roomId).emit('game_start');
      }
    }, 3000);
  }

  io.emit('rooms_updated', getAvailableRooms());

    socket.emit('joined', {
      id: playerId,
      team,
      roomId: roomId,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      groundY: GROUND_Y,
      trenchLeft: TRENCH_LEFT,
      trenchRight: TRENCH_RIGHT,
      playerW: PLAYER_W,
      playerH: PLAYER_H,
      playerCrouchH: PLAYER_CROUCH_H,
      moveSpeed: MOVE_SPEED,
      gravity: GRAVITY,
      jumpForce: JUMP_FORCE
    });

    io.to(roomId).emit('player_joined', { id: playerId, team });
  });

  socket.on('player_input', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[playerId];
    if (!player || !player.alive) return;
    player.inputs = data.inputs || data;
    if (data.seq !== undefined) player.inputSeq = data.seq;
  });

  socket.on('player_shoot', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[playerId];
    if (!player || !player.alive) return;

    const now = Date.now();
    if (now - player.lastShot < 250) return; // fire rate limit
    player.lastShot = now;

    const pH = player.crouching ? PLAYER_CROUCH_H : PLAYER_H;
    const bulletY = player.y + pH * 0.3; // shoot from upper body
    const bulletX = player.facing === 1 ? player.x + PLAYER_W : player.x;

    room.bullets.push({
      x: bulletX,
      y: bulletY,
      vx: BULLET_SPEED * player.facing,
      ownerId: playerId,
      team: player.team
    });

    io.to(currentRoom).emit('player_shot', {
      playerId,
      x: bulletX,
      y: bulletY,
      facing: player.facing,
      team: player.team
    });
  });

  // Handle player name setting
  socket.on('set_player_name', (name) => {
    socket.playerName = name;
  });

  // Handle return to lobby (reset room tracking after match end)
  socket.on('returned_to_lobby', () => {
    currentRoom = null;
    delete playerRooms[playerId];
  });

  // Handle auth session binding
  socket.on('bind_session', (publicKey) => {
    activeSessions[socket.id] = publicKey;
  });

  // Handle chat messages
  socket.on('chat_message', async (message) => {
    // Generate a random name if player doesn't have one
    const playerName = socket.playerName || `Player${Math.floor(Math.random() * 1000)}`;
    const publicKey = activeSessions[socket.id] || 'anonymous';
    const trimmedMsg = message.slice(0, 200);
    
    // Persist chat message to Supabase
    try {
      await supabase.from('chat_messages').insert({
        public_key: publicKey,
        player_name: playerName,
        message: trimmedMsg
      });
    } catch (e) {
      console.error('Chat persist error:', e);
    }

    // Broadcast to all connected clients for lobby chat
    io.emit('chat_message', {
      playerName,
      message: trimmedMsg,
      publicKey
    });
  });

  socket.on('disconnect', () => {
    delete activeSessions[socket.id];
    let currentRoom = playerRooms[socket.id];
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[playerId];
      io.to(currentRoom).emit('player_left', playerId);

      // Reset room status if game was in progress
      const room = rooms[currentRoom];
      if (room && room.status !== 'waiting') {
        room.status = 'waiting';
        room.countdownStartTime = null;
        io.to(currentRoom).emit('game_reset');
      }

      // Clean up empty rooms
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        delete rooms[currentRoom];
      }

      io.emit('rooms_updated', getAvailableRooms());
    }
  });
});

// ─── Game Loop ───
setInterval(() => {
  for (const roomId in rooms) {
    tickRoom(rooms[roomId]);
  }
}, 1000 / TICK_RATE);

// ─── Start Server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Market Warfare: The Trenches — Server running on port ${PORT}`);
});
