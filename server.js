require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
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
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6
});

// ─── CORS for cross-origin requests (Vercel frontend → Railway game server) ───
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ─── Admin Panel ───
const ADMIN_PASSWORD = 'admincryptotok';

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// Admin: search user by public key
app.post('/api/admin/search-user', (req, res) => {
  const { password, query } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  if (!query) return res.status(400).json({ error: 'Search query required' });

  // Search in Supabase by partial public key
  supabase
    .from('accounts')
    .select('public_key, balance, wins, losses, kills, deaths, last_active')
    .ilike('public_key', `%${query}%`)
    .limit(20)
    .then(({ data, error }) => {
      if (error) return res.status(500).json({ error: 'Search failed' });
      res.json({ users: data || [] });
    });
});

// Admin: add SOL balance to a user
app.post('/api/admin/add-balance', async (req, res) => {
  const { password, publicKey, amount } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  if (!publicKey || !amount || isNaN(amount) || parseFloat(amount) <= 0) {
    return res.status(400).json({ error: 'Valid public key and positive amount required' });
  }

  const solAmount = parseFloat(amount);

  try {
    // Check if user exists
    const { data: user, error: fetchErr } = await supabase
      .from('accounts')
      .select('public_key, balance')
      .eq('public_key', publicKey)
      .single();

    if (fetchErr || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newBalance = parseFloat(user.balance || 0) + solAmount;

    // Update in Supabase
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ balance: newBalance })
      .eq('public_key', publicKey);

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to update balance' });
    }

    // Update cache if present
    if (accountsCache[publicKey]) {
      accountsCache[publicKey].balance = newBalance;
    }

    // Log as admin deposit
    await supabase.from('game_transactions').insert({
      public_key: publicKey,
      room_id: 'ADMIN_CREDIT',
      type: 'deposit',
      amount: solAmount
    });

    res.json({ success: true, newBalance, added: solAmount });
  } catch (e) {
    console.error('Admin add balance error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Always serve socket.io client library (Vercel frontend needs to load it from Render)
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

// Serve other static files only when not on Render (Vercel handles the frontend)
if (!process.env.RENDER) {
  app.use(express.static(path.join(__dirname, 'public')));
}

// Expose Supabase config to the client (anon key only, safe for browser)
app.get('/api/supabase-config', (req, res) => {
  res.json({
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY
  });
});

// ─── Solana Connection & Platform Wallet ───
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PLATFORM_WALLET = process.env.PLATFORM_WALLET || '';
const solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');

// ─── Entry Fee Options (SOL) ───
const VALID_ENTRY_FEES = [0, 0.01, 0.05, 0.1, 0.5];
const PLATFORM_FEE_PERCENT = 0; // 0% platform fee for now
const processedSignatures = new Set(); // Track already-credited tx signatures

// ─── Accounts & Leaderboard (Supabase-backed) ───
const accountsCache = {}; // In-memory cache for active game sessions
const activeSessions = {}; // { socketId: publicKey }

// Helper: get or create account in Supabase
async function getAccount(publicKey) {
  // Always fetch fresh balance from DB to pick up admin credits and other external changes
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('public_key', publicKey)
    .single();
  if (error || !data) return accountsCache[publicKey] || null;
  const acc = {
    publicKey: data.public_key,
    privateKey: data.private_key,
    wins: data.wins,
    losses: data.losses,
    kills: data.kills,
    deaths: data.deaths,
    balance: parseFloat(data.balance) || 0,
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
      balance: acc.balance,
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

    accountsCache[publicKey] = { publicKey, privateKey, wins: 0, losses: 0, kills: 0, deaths: 0, balance: 0, lastActive: Date.now() };
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
      acc = { publicKey, privateKey, wins: 0, losses: 0, kills: 0, deaths: 0, balance: 0, lastActive: Date.now() };
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
    res.json({ publicKey: acc.publicKey, wins: acc.wins, losses: acc.losses, kills: acc.kills, deaths: acc.deaths, balance: acc.balance });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// Get balance
app.get('/api/balance/:publicKey', async (req, res) => {
  try {
    const acc = await getAccount(req.params.publicKey);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json({ balance: acc.balance });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// Get platform wallet address (for deposits)
app.get('/api/platform-wallet', (req, res) => {
  if (!PLATFORM_WALLET) {
    return res.status(500).json({ error: 'Platform wallet not configured' });
  }
  res.json({ wallet: PLATFORM_WALLET });
});

// Verify on-chain deposit: check that user sent SOL to platform wallet
app.post('/api/verify-deposit', async (req, res) => {
  try {
    const { publicKey, amount, signature } = req.body;
    if (!publicKey || !amount || !signature) {
      return res.status(400).json({ error: 'Missing publicKey, amount, or signature' });
    }
    if (!PLATFORM_WALLET) {
      return res.status(500).json({ error: 'Platform wallet not configured' });
    }

    const acc = await getAccount(publicKey);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    // Prevent double-crediting the same transaction
    if (processedSignatures.has(signature)) {
      return res.status(400).json({ error: 'This transaction has already been credited' });
    }

    // Also check DB for processed signatures
    const { data: existingTx } = await supabase
      .from('game_transactions')
      .select('id')
      .eq('room_id', signature)
      .eq('type', 'deposit')
      .single();
    if (existingTx) {
      processedSignatures.add(signature);
      return res.status(400).json({ error: 'This transaction has already been credited' });
    }

    // Fetch and verify the transaction on-chain
    const txInfo = await solanaConnection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txInfo) {
      return res.status(400).json({ error: 'Transaction not found. Please wait for confirmation and try again.' });
    }

    if (txInfo.meta && txInfo.meta.err) {
      return res.status(400).json({ error: 'Transaction failed on-chain' });
    }

    // Verify the transaction: check that it transfers SOL to platform wallet from the user
    const expectedLamports = Math.round(parseFloat(amount) * LAMPORTS_PER_SOL);
    let verified = false;

    // Check pre/post balances for the platform wallet
    const accountKeys = txInfo.transaction.message.accountKeys.map(k => k.pubkey ? k.pubkey.toString() : k.toString());
    const platformIndex = accountKeys.indexOf(PLATFORM_WALLET);
    const senderIndex = accountKeys.indexOf(publicKey);

    if (platformIndex !== -1 && senderIndex !== -1 && txInfo.meta) {
      const preBalance = txInfo.meta.preBalances[platformIndex];
      const postBalance = txInfo.meta.postBalances[platformIndex];
      const received = postBalance - preBalance;

      // Allow small tolerance for rounding (within 5000 lamports / 0.000005 SOL)
      if (received >= expectedLamports - 5000) {
        verified = true;
      }
    }

    if (!verified) {
      return res.status(400).json({ error: 'Could not verify transfer. Make sure you sent the exact amount to the correct wallet.' });
    }

    // Credit the user's balance
    const depositAmount = parseFloat(amount);
    acc.balance = (acc.balance || 0) + depositAmount;
    accountsCache[publicKey] = acc;

    await supabase
      .from('accounts')
      .update({ balance: acc.balance })
      .eq('public_key', publicKey);

    // Log transaction (use signature as room_id for uniqueness)
    await supabase.from('game_transactions').insert({
      public_key: publicKey,
      room_id: signature,
      type: 'deposit',
      amount: depositAmount
    });

    processedSignatures.add(signature);

    res.json({ balance: acc.balance, message: `+${depositAmount} SOL deposited successfully!` });
  } catch (e) {
    console.error('Verify deposit error:', e);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
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
      .or('wins.gt.0,losses.gt.0')
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
      id: m.id,
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
const TICK_MS = 1000 / TICK_RATE;
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
const roomCreationCooldowns = {}; // { publicKey: timestamp } — 15s cooldown per user

function createRoom(roomId, creatorId, mode, entryFee) {
  const maxPlayers = mode === '1v1' ? 2 : 4;
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
    maxPlayers: maxPlayers,
    entryFee: entryFee, // SOL entry fee per player
    prizePool: 0, // Total SOL in the prize pool
    paidPlayers: {} // { publicKey: amount } — track who paid
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
        maxPlayers: room.maxPlayers,
        entryFee: room.entryFee,
        prizePool: room.prizePool
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
function tickRoom(room, deltaMs) {
  if (room.status === 'match_over') return;
  const now = Date.now();
  // dt: ratio of actual elapsed time to the ideal tick interval (clamped to avoid spiral-of-death)
  const dt = Math.min(deltaMs / TICK_MS, 3);
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

    // Gravity — scaled by dt
    p.vy += GRAVITY * dt;

    // Apply velocity — scaled by dt
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Ground collision
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
    b.x += b.vx * dt;

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
    scores: room.scores,
    t: now // server timestamp for client latency measurement
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
        // Count winning team players
        let winnerCount = 0;
        for (const pid in room.players) {
          if (room.players[pid].team === winner) winnerCount++;
        }

        // Calculate payout per winner
        const totalPrize = room.prizePool;
        const platformCut = totalPrize * (PLATFORM_FEE_PERCENT / 100);
        const payoutPerWinner = winnerCount > 0 ? (totalPrize - platformCut) / winnerCount : 0;

        // Update win/loss stats and distribute prize pool
        for (const pid in room.players) {
          const pubKey = activeSessions[pid];
          if (pubKey && accountsCache[pubKey]) {
            if (room.players[pid].team === winner) {
              accountsCache[pubKey].wins++;
              // Award prize pool share
              accountsCache[pubKey].balance += payoutPerWinner;
              // Log payout transaction
              supabase.from('game_transactions').insert({
                public_key: pubKey,
                room_id: room.id,
                type: 'payout',
                amount: payoutPerWinner
              }).then(() => {}).catch(e => console.error('Payout log error:', e));
            } else {
              accountsCache[pubKey].losses++;
            }
            accountsCache[pubKey].lastActive = Date.now();
            // Persist stats to Supabase
            saveAccountStats(pubKey);
          }
        }
        room.prizePool = 0; // Prize pool distributed

        io.to(room.id).emit('match_end', { winner, prizePool: totalPrize, payoutPerWinner });
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
                    deaths: accountsCache[pubKey].deaths,
                    balance: accountsCache[pubKey].balance
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
socket.on('create_room', async (data) => {
  const mode = (data && data.mode) || '1v1';
  const entryFee = (data && typeof data.entryFee === 'number') ? data.entryFee : 0;

  // Validate entry fee
  if (!VALID_ENTRY_FEES.includes(entryFee)) {
    socket.emit('room_error', { message: 'Invalid entry fee' });
    return;
  }

  // Check player balance
  const pubKey = activeSessions[socket.id];
  if (!pubKey) {
    socket.emit('room_error', { message: 'Not authenticated' });
    return;
  }

  // Skip balance check for free rooms
  if (entryFee > 0) {
    const acc = await getAccount(pubKey);
    if (!acc || acc.balance < entryFee) {
      socket.emit('room_error', { message: 'Insufficient balance. Deposit SOL to play!' });
      return;
    }
  }

  // Enforce 15-second room creation cooldown
  const ROOM_CREATE_COOLDOWN = 15000;
  const lastCreated = roomCreationCooldowns[pubKey] || 0;
  const elapsed = Date.now() - lastCreated;
  if (elapsed < ROOM_CREATE_COOLDOWN) {
    const remaining = Math.ceil((ROOM_CREATE_COOLDOWN - elapsed) / 1000);
    socket.emit('room_error', { message: `Wait ${remaining}s before creating another room`, cooldownRemaining: remaining });
    return;
  }

  // For free rooms, try to find an existing waiting room with the same mode first
  if (entryFee === 0) {
    for (const rid in rooms) {
      const existingRoom = rooms[rid];
      if (existingRoom.entryFee === 0 &&
          existingRoom.mode === mode &&
          existingRoom.status === 'waiting' &&
          Object.keys(existingRoom.players).length < existingRoom.maxPlayers &&
          existingRoom.creatorId !== playerId) {
        // Found a matching free room — join it instead of creating a new one
        roomCreationCooldowns[pubKey] = Date.now();
        socket.emit('room_created', rid);
        return;
      }
    }
  }

  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[roomId] = createRoom(roomId, playerId, mode, entryFee);
  roomCreationCooldowns[pubKey] = Date.now();
  io.emit('rooms_updated', getAvailableRooms());
  
  // Auto-join the creator to their room
  socket.emit('room_created', roomId);
});

// Get rooms handler
socket.on('get_rooms', () => {
  socket.emit('available_rooms', getAvailableRooms());
});

socket.on('join_room', async (roomId) => {
  if (currentRoom) {
    socket.leave(currentRoom);
    const oldRoom = rooms[currentRoom];
    if (oldRoom) {
      // Refund entry fee if game hasn't started
      if (oldRoom.status === 'waiting') {
        const pubKey = activeSessions[playerId];
        if (pubKey && oldRoom.paidPlayers[pubKey]) {
          const refundAmount = oldRoom.paidPlayers[pubKey];
          const acc = await getAccount(pubKey);
          if (acc) {
            acc.balance += refundAmount;
            accountsCache[pubKey] = acc;
            await supabase.from('accounts').update({ balance: acc.balance }).eq('public_key', pubKey);
            socket.emit('balance_updated', { balance: acc.balance });
          }
          oldRoom.prizePool -= refundAmount;
          delete oldRoom.paidPlayers[pubKey];
        }
      }
      delete oldRoom.players[playerId];
      io.to(currentRoom).emit('player_left', playerId);
      io.emit('rooms_updated', getAvailableRooms());
    }
    delete playerRooms[playerId];
  }

  const room = rooms[roomId];
  if (!room || Object.keys(room.players).length >= room.maxPlayers) {
    socket.emit('join_failed', { message: 'Room is full' });
    return;
  }

  // Check balance and deduct entry fee
  const pubKey = activeSessions[socket.id];
  if (!pubKey) {
    socket.emit('join_failed', { message: 'Not authenticated' });
    return;
  }

  const acc = await getAccount(pubKey);
  if (!acc) {
    socket.emit('join_failed', { message: 'Account not found' });
    return;
  }

  // Skip balance check and fee deduction for free rooms
  if (room.entryFee > 0) {
    if (acc.balance < room.entryFee) {
      socket.emit('join_failed', { message: 'Insufficient balance. Deposit SOL to play!' });
      return;
    }

    // Deduct entry fee
    acc.balance -= room.entryFee;
    accountsCache[pubKey] = acc;
    room.prizePool += room.entryFee;
    room.paidPlayers[pubKey] = room.entryFee;

    // Persist balance deduction
    await supabase.from('accounts').update({ balance: acc.balance }).eq('public_key', pubKey);
    await supabase.from('game_transactions').insert({
      public_key: pubKey,
      room_id: roomId,
      type: 'entry_fee',
      amount: room.entryFee
    });

    socket.emit('balance_updated', { balance: acc.balance });
  }

  currentRoom = roomId;
  playerRooms[playerId] = roomId;
  socket.join(roomId);
  const team = assignTeam(room);
  room.players[playerId] = createPlayer(playerId, team);

  // Emit joined to the new player first so they set up listeners
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
    jumpForce: JUMP_FORCE,
    entryFee: room.entryFee,
    prizePool: room.prizePool,
    maxPlayers: room.maxPlayers,
    mode: room.mode,
    playerCount: Object.keys(room.players).length
  });

  io.to(roomId).emit('player_joined', { id: playerId, team, prizePool: room.prizePool });

  // Check if room is ready to start (after joined is sent)
  const playerCount = Object.keys(room.players).length;
  const isRoomFull = playerCount === room.maxPlayers;
  const is1v1Ready = room.mode === '1v1' && playerCount === 2;
  const is2v2Ready = room.mode === '2v2' && playerCount === 4;

  if (isRoomFull || is1v1Ready || is2v2Ready) {
    room.status = 'countdown';
    room.countdownStartTime = Date.now();
    io.to(roomId).emit('game_countdown_start', { prizePool: room.prizePool });
    
    // Start the game after 3 seconds
    setTimeout(() => {
      if (rooms[roomId]) {
        rooms[roomId].status = 'active';
        io.to(roomId).emit('game_start', { prizePool: room.prizePool });
      }
    }, 3000);
  }

  io.emit('rooms_updated', getAvailableRooms());
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

  // Handle leaving a room from the waiting overlay
  socket.on('leave_room', async () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];

    // Refund entry fee if game hasn't started
    if (room.status === 'waiting') {
      const pubKey = activeSessions[socket.id];
      if (pubKey && room.paidPlayers[pubKey]) {
        const refundAmount = room.paidPlayers[pubKey];
        const acc = await getAccount(pubKey);
        if (acc) {
          acc.balance += refundAmount;
          accountsCache[pubKey] = acc;
          await supabase.from('accounts').update({ balance: acc.balance }).eq('public_key', pubKey);
          socket.emit('balance_updated', { balance: acc.balance });
        }
        room.prizePool -= refundAmount;
        delete room.paidPlayers[pubKey];
      }
    }

    delete room.players[playerId];
    socket.leave(currentRoom);
    io.to(currentRoom).emit('player_left', playerId);

    // Clean up empty rooms
    if (Object.keys(room.players).length === 0) {
      delete rooms[currentRoom];
    }

    io.emit('rooms_updated', getAvailableRooms());
    currentRoom = null;
    delete playerRooms[playerId];
  });

  // Ping/pong for latency measurement
  socket.on('ping_measure', (clientTimestamp) => {
    socket.emit('pong_measure', clientTimestamp);
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
    
    let msgId = null;
    // Persist chat message to Supabase
    try {
      const { data, error } = await supabase.from('chat_messages').insert({
        public_key: publicKey,
        player_name: playerName,
        message: trimmedMsg
      }).select('id').single();
      if (data) msgId = data.id;
    } catch (e) {
      console.error('Chat persist error:', e);
    }

    // Broadcast to all connected clients for lobby chat
    io.emit('chat_message', {
      playerName,
      message: trimmedMsg,
      publicKey,
      msgId
    });
  });

  socket.on('disconnect', async () => {
    const pubKey = activeSessions[socket.id];
    delete activeSessions[socket.id];
    let currentRoom = playerRooms[socket.id];
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];

      // Refund entry fee if game hasn't started
      if (room.status === 'waiting' && pubKey && room.paidPlayers[pubKey]) {
        const refundAmount = room.paidPlayers[pubKey];
        const acc = await getAccount(pubKey);
        if (acc) {
          acc.balance += refundAmount;
          accountsCache[pubKey] = acc;
          await supabase.from('accounts').update({ balance: acc.balance }).eq('public_key', pubKey);
        }
        room.prizePool -= refundAmount;
        delete room.paidPlayers[pubKey];
      }

      delete room.players[playerId];
      io.to(currentRoom).emit('player_left', playerId);

      // Reset room status if game was in progress
      if (room.status !== 'waiting') {
        room.status = 'waiting';
        room.countdownStartTime = null;
        io.to(currentRoom).emit('game_reset');
      }

      // Clean up empty rooms
      if (Object.keys(room.players).length === 0) {
        delete rooms[currentRoom];
      }

      io.emit('rooms_updated', getAvailableRooms());
    }
  });
});

// ─── Game Loop (precise setTimeout-based, tracks real delta time) ───
let _lastLoopTime = Date.now();
function gameLoop() {
  const now = Date.now();
  const deltaMs = now - _lastLoopTime;
  _lastLoopTime = now;
  for (const roomId in rooms) {
    tickRoom(rooms[roomId], deltaMs);
  }
  setTimeout(gameLoop, TICK_MS);
}
gameLoop();

// ─── Start Server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Market Warfare: The Trenches — Server running on port ${PORT}`);
});
