// ─── USA vs IRAN: The Trenches — Client ───
(function () {
  'use strict';

  // ─── Auth State ───
  let currentAccount = null; // { publicKey, privateKey }
  let supabaseClient = null; // Supabase client for realtime chat
  let chatSubscription = null; // Supabase realtime subscription
  const displayedMessageIds = new Set(); // Dedup chat messages between socket.io and realtime

  // ─── Game Server URL (Railway backend) ───
  // When deployed: set this to your Railway game server URL (e.g. https://your-app.up.railway.app)
  // When running locally: leave as empty string to use same origin
  const GAME_SERVER = window.GAME_SERVER_URL || '';

  const socket = io(GAME_SERVER || undefined, {
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  // Helper: build API URL pointing to game server
  function apiUrl(path) {
    return GAME_SERVER ? GAME_SERVER + path : path;
  }

  // ─── Supabase Realtime Init ───
  async function initSupabase() {
    try {
      const res = await fetch(apiUrl('/api/supabase-config'));
      const config = await res.json();
      if (config.url && config.anonKey && window.supabase) {
        supabaseClient = window.supabase.createClient(config.url, config.anonKey);
        subscribeToChat();
      }
    } catch (e) {
      console.warn('Supabase realtime init failed, falling back to socket chat');
    }
  }

  function subscribeToChat() {
    if (!supabaseClient) return;
    // Subscribe to new chat messages via Supabase Realtime
    chatSubscription = supabaseClient
      .channel('public:chat_messages')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages'
      }, (payload) => {
        const m = payload.new;
        if (m && m.player_name && m.message) {
          addChatMessage(m.player_name, m.message, m.id);
        }
      })
      .subscribe();
  }

  // ─── Persistent Session (localStorage) ───
  async function tryAutoLogin() {
    const savedKey = localStorage.getItem('trenches_private_key');
    if (!savedKey) return false;
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: savedKey })
      });
      const data = await res.json();
      if (data.error) {
        localStorage.removeItem('trenches_private_key');
        return false;
      }
      currentAccount = data;
      onAuthSuccess();
      return true;
    } catch (e) {
      localStorage.removeItem('trenches_private_key');
      return false;
    }
  }

  // Load chat history from Supabase
  async function loadChatHistory() {
    try {
      const res = await fetch(apiUrl('/api/chat/recent'));
      const messages = await res.json();
      messages.forEach(m => {
        addChatMessage(m.playerName, m.message, m.id);
      });
    } catch (e) {}
  }

  // ─── Auth DOM refs ───
  const lobby = document.getElementById('lobby');
  const authScreen = document.getElementById('auth-screen');
  const signupBtn = document.getElementById('signup-btn');
  const loginBtn = document.getElementById('login-btn');
  const loginForm = document.getElementById('login-form');
  const loginPrivateKeyInput = document.getElementById('login-private-key');
  const loginSubmitBtn = document.getElementById('login-submit-btn');
  const loginCancelBtn = document.getElementById('login-cancel-btn');
  const authError = document.getElementById('auth-error');
  const accountBtn = document.getElementById('account-btn');
  const accountPopup = document.getElementById('account-popup');
  const accountPublicKey = document.getElementById('account-public-key');
  const accountPrivateKey = document.getElementById('account-private-key');
  const accountWins = document.getElementById('account-wins');
  const accountLosses = document.getElementById('account-losses');
  const accountKills = document.getElementById('account-kills');
  const accountDeaths = document.getElementById('account-deaths');
  const logoutBtn = document.getElementById('logout-btn');
  const accountCloseBtn = document.getElementById('account-close-btn');
  const lobbyUsername = document.getElementById('lobby-username');
  const leaderboardGrid = document.getElementById('leaderboard-grid');
  const lobbyBalance = document.getElementById('lobby-balance');
  const depositBtn = document.getElementById('deposit-btn');
  const depositModal = document.getElementById('deposit-modal');
  const depositCloseBtn = document.getElementById('deposit-close-btn');
  const depositStatus = document.getElementById('deposit-status');
  const entryFeeSection = document.getElementById('entry-fee-section');
  const feeError = document.getElementById('fee-error');
  const createRoomBtn = document.getElementById('create-room-btn');
  const prizePoolHud = document.getElementById('prize-pool-hud');
  const prizePoolAmount = document.getElementById('prize-pool-amount');
  const accountBalance = document.getElementById('account-balance');
  const createFreeRoomBtn = document.getElementById('create-free-room-btn');
  const freeFeeError = document.getElementById('free-fee-error');
  const waitingOverlay = document.getElementById('waiting-overlay');
  const waitingRoomId = document.getElementById('waiting-room-id');
  const waitingMode = document.getElementById('waiting-mode');
  const waitingPlayers = document.getElementById('waiting-players');
  const waitingFee = document.getElementById('waiting-fee');
  const waitingLeaveBtn = document.getElementById('waiting-leave-btn');

  let playerBalance = 0;
  let selectedEntryFee = null;
  let currentPrizePool = 0;
  let selectedFreeMode = null;
  let currentRoomMaxPlayers = 2;
  let currentRoomPlayerCount = 0;

  // ─── Auth Handlers ───
  signupBtn.addEventListener('click', async () => {
    authError.textContent = '';
    try {
      const res = await fetch(apiUrl('/api/signup'), { method: 'POST' });
      const data = await res.json();
      if (data.error) { authError.textContent = data.error; return; }
      currentAccount = data;
      localStorage.setItem('trenches_private_key', data.privateKey);
      onAuthSuccess();
    } catch (e) { authError.textContent = 'Signup failed'; }
  });

  loginBtn.addEventListener('click', () => {
    loginForm.style.display = 'flex';
    authError.textContent = '';
  });

  loginCancelBtn.addEventListener('click', () => {
    loginForm.style.display = 'none';
    loginPrivateKeyInput.value = '';
    authError.textContent = '';
  });

  loginSubmitBtn.addEventListener('click', async () => {
    authError.textContent = '';
    const pk = loginPrivateKeyInput.value.trim();
    if (!pk) { authError.textContent = 'Enter your private key'; return; }
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: pk })
      });
      const data = await res.json();
      if (data.error) { authError.textContent = data.error; return; }
      currentAccount = data;
      localStorage.setItem('trenches_private_key', data.privateKey);
      onAuthSuccess();
    } catch (e) { authError.textContent = 'Login failed'; }
  });

  function onAuthSuccess() {
    authScreen.style.display = 'none';
    lobby.style.display = 'flex';
    lobbyUsername.textContent = currentAccount.publicKey.slice(0, 16) + '...';
    socket.emit('set_player_name', currentAccount.publicKey);
    socket.emit('bind_session', currentAccount.publicKey);
    fetchLeaderboard();
    loadChatHistory();
    fetchBalance();
    socket.emit('get_rooms');
  }

  // ─── Balance Management ───
  async function fetchBalance() {
    if (!currentAccount) return;
    try {
      const res = await fetch(apiUrl('/api/balance/' + currentAccount.publicKey));
      const data = await res.json();
      playerBalance = data.balance || 0;
      updateBalanceDisplay();
    } catch (e) {}
  }

  function updateBalanceDisplay() {
    const formatted = playerBalance.toFixed(2);
    lobbyBalance.textContent = formatted;
    if (accountBalance) accountBalance.textContent = formatted + ' SOL';
    // Update fee option availability
    updateFeeOptions();
  }

  function updateFeeOptions() {
    document.querySelectorAll('.fee-option').forEach(opt => {
      const fee = parseFloat(opt.dataset.fee);
      if (fee > playerBalance) {
        opt.classList.add('insufficient');
        if (opt.classList.contains('selected')) {
          opt.classList.remove('selected');
          selectedEntryFee = null;
          createRoomBtn.disabled = true;
        }
      } else {
        opt.classList.remove('insufficient');
      }
    });
  }

  // ─── Account Popup ───
  accountBtn.addEventListener('click', async () => {
    accountPublicKey.textContent = currentAccount.publicKey;
    accountPrivateKey.textContent = 'Click to reveal';
    accountPrivateKey.classList.remove('revealed');
    // Fetch latest stats
    try {
      const res = await fetch(apiUrl('/api/account/' + currentAccount.publicKey));
      const data = await res.json();
      accountWins.textContent = data.wins || 0;
      accountLosses.textContent = data.losses || 0;
      accountKills.textContent = data.kills || 0;
      accountDeaths.textContent = data.deaths || 0;
      if (data.balance !== undefined) {
        playerBalance = data.balance;
        updateBalanceDisplay();
      }
    } catch (e) {}
    accountPopup.style.display = 'flex';
  });

  // ─── Deposit Modal ───
  let platformWallet = '';
  let selectedDepositAmount = 0;
  const depositStepAmounts = document.getElementById('deposit-step-amounts');
  const depositStepAddress = document.getElementById('deposit-step-address');
  const depositExactAmount = document.getElementById('deposit-exact-amount');
  const depositWalletAddress = document.getElementById('deposit-wallet-address');
  const copyWalletBtn = document.getElementById('copy-wallet-btn');
  const depositVerifyBtn = document.getElementById('deposit-verify-btn');
  const depositVerifyStatus = document.getElementById('deposit-verify-status');
  const depositBackBtn = document.getElementById('deposit-back-btn');

  // Fetch platform wallet on load
  async function fetchPlatformWallet() {
    try {
      const res = await fetch(apiUrl('/api/platform-wallet'));
      const data = await res.json();
      if (data.wallet) platformWallet = data.wallet;
    } catch (e) {}
  }
  fetchPlatformWallet();

  depositBtn.addEventListener('click', () => {
    depositStatus.textContent = '';
    depositStatus.className = 'deposit-status';
    depositVerifyStatus.textContent = '';
    depositVerifyStatus.className = 'deposit-status';
    // Reset to step 1
    depositStepAmounts.style.display = 'grid';
    depositStepAddress.style.display = 'none';
    selectedDepositAmount = 0;
    depositModal.style.display = 'flex';
  });

  depositCloseBtn.addEventListener('click', () => {
    depositModal.style.display = 'none';
  });

  // Step 1: User selects deposit amount → show wallet address
  document.querySelectorAll('.deposit-amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedDepositAmount = parseFloat(btn.dataset.amount);
      // Show step 2: wallet address + instructions
      depositStepAmounts.style.display = 'none';
      depositStepAddress.style.display = 'block';
      depositExactAmount.textContent = selectedDepositAmount;
      // Update all repeat elements
      document.querySelectorAll('.deposit-exact-repeat').forEach(el => {
        el.textContent = selectedDepositAmount;
      });
      depositWalletAddress.textContent = platformWallet || 'Not configured';
      depositVerifyStatus.textContent = '';
      depositVerifyStatus.className = 'deposit-status';
      depositStatus.textContent = '';
    });
  });

  // Copy wallet address
  copyWalletBtn.addEventListener('click', () => {
    if (!platformWallet) return;
    navigator.clipboard.writeText(platformWallet).then(() => {
      copyWalletBtn.textContent = 'COPIED!';
      setTimeout(() => { copyWalletBtn.textContent = 'COPY'; }, 2000);
    }).catch(() => {
      // Fallback
      const textArea = document.createElement('textarea');
      textArea.value = platformWallet;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      copyWalletBtn.textContent = 'COPIED!';
      setTimeout(() => { copyWalletBtn.textContent = 'COPY'; }, 2000);
    });
  });

  // Step 2: User clicks "I've sent it" → prompt for tx signature → verify on-chain
  depositVerifyBtn.addEventListener('click', async () => {
    const signature = prompt('Paste your Solana transaction signature (hash):');
    if (!signature || !signature.trim()) return;

    depositVerifyStatus.textContent = 'Verifying transaction on-chain...';
    depositVerifyStatus.className = 'deposit-status';
    depositVerifyBtn.disabled = true;

    try {
      const res = await fetch(apiUrl('/api/verify-deposit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: currentAccount.publicKey,
          amount: selectedDepositAmount,
          signature: signature.trim()
        })
      });
      const data = await res.json();
      if (data.error) {
        depositVerifyStatus.textContent = data.error;
        depositVerifyStatus.className = 'deposit-status error';
      } else {
        playerBalance = data.balance;
        updateBalanceDisplay();
        depositVerifyStatus.textContent = data.message || 'Deposit verified!';
        depositVerifyStatus.className = 'deposit-status';
        // Return to step 1 after short delay
        setTimeout(() => {
          depositStepAmounts.style.display = 'grid';
          depositStepAddress.style.display = 'none';
        }, 3000);
      }
    } catch (e) {
      depositVerifyStatus.textContent = 'Verification failed. Please try again.';
      depositVerifyStatus.className = 'deposit-status error';
    }
    depositVerifyBtn.disabled = false;
  });

  // Back button: return to amount selection
  depositBackBtn.addEventListener('click', () => {
    depositStepAmounts.style.display = 'grid';
    depositStepAddress.style.display = 'none';
    depositVerifyStatus.textContent = '';
    selectedDepositAmount = 0;
  });

  accountPrivateKey.addEventListener('click', () => {
    if (accountPrivateKey.classList.contains('revealed')) {
      accountPrivateKey.textContent = 'Click to reveal';
      accountPrivateKey.classList.remove('revealed');
    } else {
      accountPrivateKey.textContent = currentAccount.privateKey;
      accountPrivateKey.classList.add('revealed');
    }
  });

  accountCloseBtn.addEventListener('click', () => {
    accountPopup.style.display = 'none';
  });

  logoutBtn.addEventListener('click', () => {
    currentAccount = null;
    localStorage.removeItem('trenches_private_key');
    accountPopup.style.display = 'none';
    lobby.style.display = 'none';
    authScreen.style.display = 'flex';
    loginForm.style.display = 'none';
    loginPrivateKeyInput.value = '';
  });

  // ─── How It Works Popup ───
  const hiwPopup = document.getElementById('how-it-works-popup');
  const hiwCloseBtn = document.getElementById('how-it-works-close-btn');
  const hiwBtnAuth = document.getElementById('how-it-works-btn-auth');
  const hiwBtnLobby = document.getElementById('how-it-works-btn-lobby');

  hiwBtnAuth.addEventListener('click', () => { hiwPopup.style.display = 'flex'; });
  hiwBtnLobby.addEventListener('click', () => { hiwPopup.style.display = 'flex'; });
  hiwCloseBtn.addEventListener('click', () => { hiwPopup.style.display = 'none'; });

  // ─── Leaderboard ───
  async function fetchLeaderboard() {
    try {
      const res = await fetch(apiUrl('/api/leaderboard'));
      const data = await res.json();
      renderLeaderboard(data);
    } catch (e) {}
  }

  function renderLeaderboard(leaders) {
    leaderboardGrid.innerHTML = '';
    if (leaders.length === 0) {
      leaderboardGrid.innerHTML = '<div class="leaderboard-empty">NO PLAYERS YET</div>';
      return;
    }
    leaders.forEach(l => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      const shortKey = l.publicKey.slice(0, 8) + '...' + l.publicKey.slice(-4);
      row.innerHTML = `
        <span class="leaderboard-rank">#${l.rank}</span>
        <span class="leaderboard-name">${shortKey}</span>
        <div class="leaderboard-stats">
          <span class="lb-wins">${l.wins}W</span>
          <span class="lb-losses">${l.losses}L</span>
          <span>${l.kills}K</span>
          <span>${l.deaths}D</span>
        </div>
      `;
      leaderboardGrid.appendChild(row);
    });
  }

  // Refresh leaderboard every 30 seconds
  setInterval(() => { if (lobby.style.display !== 'none') fetchLeaderboard(); }, 30000);

  // ─── DOM refs ───
  const gameContainer = document.getElementById('game-container');
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const refreshRoomsBtn = document.getElementById('refresh-rooms-btn');
  const roomsGrid = document.getElementById('rooms-grid');
  const roomsCount = document.getElementById('rooms-count');
  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownNumber = document.getElementById('countdown-number');
  const scoreboard = document.getElementById('scoreboard');
  const scoreUsa = document.getElementById('score-usa');
  const scoreIran = document.getElementById('score-iran');
  const hud = document.getElementById('hud');
  const teamBadge = document.getElementById('team-badge');
  const hpBar = document.getElementById('hp-bar');
  const hpText = document.getElementById('hp-text');
  const killFeed = document.getElementById('kill-feed');
  const respawnOverlay = document.getElementById('respawn-overlay');
  const roomInfo = document.getElementById('room-info');
  const roomIdDisplay = document.getElementById('room-id-display');

  // ─── Game state ───
  let myId = null;
  let myTeam = null;
  let serverState = { players: {}, bullets: [], scores: { usa: 0, iran: 0 } };
  let config = {};
  let joined = false;

  // Client-side prediction state
  let localPlayer = null;
  let predictedPlayer = null; // Our locally predicted position
  let inputs = { left: false, right: false, up: false, down: false };
  let pendingInputs = []; // Inputs not yet acknowledged by server
  let inputSeq = 0;
  const MAX_PENDING_INPUTS = 120; // cap to ~2s at 60fps

  // Latency tracking
  let avgLatency = 50; // optimistic starting estimate (ms)
  const _latencySamples = [];

  // Interpolation state for remote players
  const interpBuffer = {}; // { playerId: [{ time, state }, ...] }
  // Dynamic interp delay: base 2 frames + 1 RTT; updated each ping
  function getInterpDelay() { return Math.max(50, avgLatency + 34); }

  // Visual effects
  let muzzleFlashes = [];
  let hitMarkers = [];
  let deathParticles = [];

  // Camera
  let camera = { x: 0, y: 0 };

  // Client-side physics (mirrors server)
  function isInTrenchClient(x) {
    if (!config.trenchLeft) return false;
    return (x >= config.trenchLeft.x1 && x <= config.trenchLeft.x2) ||
           (x >= config.trenchRight.x1 && x <= config.trenchRight.x2);
  }

  // dt: ratio of elapsed ms to one ideal 60fps tick — mirrors the server's dt calculation
  function predictPhysics(p, inp, dt) {
    dt = dt !== undefined ? dt : 1;
    const PLAYER_W = config.playerW || 30;
    const PLAYER_H = config.playerH || 50;
    const PLAYER_CROUCH_H = config.playerCrouchH || 28;
    const GROUND_Y = config.groundY || 420;
    const MAP_WIDTH = config.mapWidth || 1600;

    // Horizontal movement
    p.vx = 0;
    if (inp.left) { p.vx = -(config.moveSpeed || 4); p.facing = -1; }
    if (inp.right) { p.vx = (config.moveSpeed || 4); p.facing = 1; }

    // Crouching
    p.crouching = inp.down && isInTrenchClient(p.x + PLAYER_W / 2) && p.onGround;

    // Jumping
    if (inp.up && p.onGround && !p.crouching) {
      p.vy = config.jumpForce || -12;
      p.onGround = false;
    }

    // Gravity — scaled by dt (mirrors server)
    p.vy += (config.gravity || 0.6) * dt;

    // Apply velocity — scaled by dt
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Ground collision
    const inTrench = isInTrenchClient(p.x + PLAYER_W / 2);
    const effectiveGround = inTrench && p.crouching
      ? GROUND_Y - PLAYER_CROUCH_H + (config.trenchLeft ? config.trenchLeft.depth : 40)
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

  // ─── Lobby ───
  let selectedMode = '1v1';
  let roomCreateCooldown = false;
  let roomCreateCooldownTimer = null;

  function startRoomCooldown(seconds) {
    roomCreateCooldown = true;
    let remaining = seconds;
    const modeOptions = document.querySelectorAll('.mode-option');
    const freeModeOptions = document.querySelectorAll('.free-mode-option');
    modeOptions.forEach(opt => {
      opt.classList.add('cooldown-disabled');
      const title = opt.querySelector('.mode-title');
      if (title) title.dataset.originalText = title.textContent;
    });
    freeModeOptions.forEach(opt => {
      opt.classList.add('cooldown-disabled');
      const title = opt.querySelector('.free-mode-title');
      if (title) title.dataset.originalText = title.textContent;
    });

    function updateCooldownText() {
      modeOptions.forEach(opt => {
        const title = opt.querySelector('.mode-title');
        if (title) title.textContent = `${title.dataset.originalText} (${remaining}s)`;
      });
      freeModeOptions.forEach(opt => {
        const title = opt.querySelector('.free-mode-title');
        if (title) title.textContent = `${title.dataset.originalText} (${remaining}s)`;
      });
    }
    updateCooldownText();

    if (roomCreateCooldownTimer) clearInterval(roomCreateCooldownTimer);
    roomCreateCooldownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(roomCreateCooldownTimer);
        roomCreateCooldownTimer = null;
        roomCreateCooldown = false;
        modeOptions.forEach(opt => {
          opt.classList.remove('cooldown-disabled');
          const title = opt.querySelector('.mode-title');
          if (title) title.textContent = title.dataset.originalText;
        });
        freeModeOptions.forEach(opt => {
          opt.classList.remove('cooldown-disabled');
          const title = opt.querySelector('.free-mode-title');
          if (title) title.textContent = title.dataset.originalText;
        });
      } else {
        updateCooldownText();
      }
    }, 1000);
  }

  // Free mode selection
  document.querySelectorAll('.free-mode-option').forEach(option => {
    option.addEventListener('click', () => {
      if (roomCreateCooldown) return;
      document.querySelectorAll('.free-mode-option').forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');
      selectedFreeMode = option.dataset.mode;
      createFreeRoomBtn.disabled = false;
      freeFeeError.textContent = '';
    });
  });

  // Create free room button
  createFreeRoomBtn.addEventListener('click', () => {
    if (!selectedFreeMode) return;
    if (roomCreateCooldown) return;
    freeFeeError.textContent = '';
    socket.emit('create_room', { mode: selectedFreeMode, entryFee: 0 });
  });

  // Mode selection — shows entry fee picker
  document.querySelectorAll('.mode-option').forEach(option => {
    option.addEventListener('click', async () => {
      if (roomCreateCooldown) return;
      document.querySelectorAll('.mode-option').forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');
      selectedMode = option.dataset.mode;
      // Refresh balance from server before showing fee options
      await fetchBalance();
      // Show entry fee section
      entryFeeSection.style.display = 'block';
      feeError.textContent = '';
      selectedEntryFee = null;
      createRoomBtn.disabled = true;
      document.querySelectorAll('.fee-option').forEach(f => f.classList.remove('selected'));
      updateFeeOptions();
    });
  });

  // Entry fee selection
  document.querySelectorAll('.fee-option').forEach(option => {
    option.addEventListener('click', () => {
      const fee = parseFloat(option.dataset.fee);
      if (fee > playerBalance) {
        feeError.textContent = 'Insufficient balance. Deposit SOL to play!';
        return;
      }
      feeError.textContent = '';
      document.querySelectorAll('.fee-option').forEach(f => f.classList.remove('selected'));
      option.classList.add('selected');
      selectedEntryFee = fee;
      createRoomBtn.disabled = false;
    });
  });

  // Create room button
  createRoomBtn.addEventListener('click', () => {
    if (!selectedEntryFee || !selectedMode) return;
    if (selectedEntryFee > playerBalance) {
      feeError.textContent = 'Insufficient balance. Deposit SOL to play!';
      return;
    }
    feeError.textContent = '';
    socket.emit('create_room', { mode: selectedMode, entryFee: selectedEntryFee });
  });

  refreshRoomsBtn.addEventListener('click', () => {
    socket.emit('get_rooms');
  });

  function updateRoomsList(rooms) {
    roomsCount.textContent = rooms.length + ' ROOMS';
    roomsGrid.innerHTML = '';

    rooms.forEach(room => {
      const roomEl = document.createElement('div');
      roomEl.className = 'room-item';
      const isFree = !room.entryFee || room.entryFee === 0;
      roomEl.dataset.mode = room.mode.toUpperCase();
      if (isFree) roomEl.classList.add('room-free');
      const canAfford = isFree || playerBalance >= room.entryFee;
      const feeDisplay = isFree ? 'FREE' : `${room.entryFee} SOL ENTRY`;
      const prizeDisplay = isFree ? 'NO PRIZE POOL' : `Prize Pool: ${room.prizePool || 0} SOL`;
      roomEl.innerHTML = `
        <div class="room-info">
          <div class="room-id">${room.id}${isFree ? ' <span class="room-free-badge">FREE</span>' : ''}</div>
          <div class="room-status">${room.status.toUpperCase()}</div>
          <div class="room-fee">${feeDisplay}</div>
          <div class="room-prize">${prizeDisplay}</div>
        </div>
        <div class="room-players">${room.playerCount}/${room.maxPlayers}</div>
      `;

      roomEl.addEventListener('click', () => {
        if (!canAfford) {
          alert('Insufficient balance! You need ' + room.entryFee + ' SOL to join. Deposit funds first.');
          return;
        }
        socket.emit('join_room', room.id);
      });

      if (!canAfford) {
        roomEl.style.opacity = '0.5';
      }

      roomsGrid.appendChild(roomEl);
    });
  }

  // Initial rooms fetch
  socket.emit('get_rooms');

  // Auto-refresh rooms list every 5 seconds so players always see available rooms
  setInterval(() => {
    if (waitingOverlay.style.display === 'none' || waitingOverlay.style.display === '') {
      socket.emit('get_rooms');
    }
  }, 5000);

  socket.on('available_rooms', (rooms) => {
    updateRoomsList(rooms);
  });

  socket.on('rooms_updated', (rooms) => {
    updateRoomsList(rooms);
  });

  socket.on('join_failed', (data) => {
    waitingOverlay.style.display = 'none';
    alert(data.message);
  });

  // Handle room creation response
  socket.on('room_created', (roomId) => {
    // Room was created, now auto-join it
    socket.emit('join_room', roomId);
    // Reset the entry fee UI
    entryFeeSection.style.display = 'none';
    document.querySelectorAll('.mode-option').forEach(opt => opt.classList.remove('selected'));
    // Reset free mode UI
    document.querySelectorAll('.free-mode-option').forEach(opt => opt.classList.remove('selected'));
    createFreeRoomBtn.disabled = true;
    selectedFreeMode = null;
  });

  socket.on('room_error', (data) => {
    if (data.cooldownRemaining) {
      startRoomCooldown(data.cooldownRemaining);
    }
    feeError.textContent = data.message || 'Error creating room';
    freeFeeError.textContent = data.message || 'Error creating room';
  });

  socket.on('balance_updated', (data) => {
    playerBalance = data.balance;
    updateBalanceDisplay();
  });

  socket.on('game_countdown_start', (data) => {
    if (data && data.prizePool !== undefined) {
      currentPrizePool = data.prizePool;
    }
    // Hide waiting overlay when countdown starts
    waitingOverlay.style.display = 'none';
    countdownOverlay.style.display = 'flex';
    countdownOverlay.style.opacity = '1';
    let count = 3;
    countdownNumber.textContent = count;

    const countdown = setInterval(() => {
      count--;
      if (count > 0) {
        countdownNumber.textContent = count;
        // Add pulse animation
        countdownNumber.style.transform = 'scale(1.2)';
        setTimeout(() => {
          countdownNumber.style.transform = 'scale(1)';
        }, 200);
      } else {
        clearInterval(countdown);
        countdownOverlay.style.opacity = '0';
        setTimeout(() => {
          countdownOverlay.style.display = 'none';
        }, 500);
      }
    }, 1000);
  });

  // Round end handling
  const roundTimerOverlay = document.getElementById('round-timer-overlay');
  const roundWinnerEl = roundTimerOverlay.querySelector('.round-winner');
  const roundScoresEl = roundTimerOverlay.querySelector('.round-scores');
  const roundTimerNumber = roundTimerOverlay.querySelector('.round-timer-number');

  socket.on('round_end', (data) => {
    roundTimerOverlay.style.display = 'flex';
    roundWinnerEl.textContent = `${data.roundWinner.toUpperCase()} WIN ROUND ${data.currentRound}`;
    roundScoresEl.textContent = `USA ${data.roundScores.usa} — ${data.roundScores.iran} IRAN`;
    
    let timeLeft = 2;
    roundTimerNumber.textContent = timeLeft;

    const timer = setInterval(() => {
      timeLeft--;
      roundTimerNumber.textContent = timeLeft;
      if (timeLeft <= 0) {
        clearInterval(timer);
        roundTimerOverlay.style.display = 'none';
      }
    }, 1000);
  });

  socket.on('match_end', (data) => {
    roundTimerOverlay.style.display = 'flex';
    roundWinnerEl.textContent = `${data.winner.toUpperCase()} WIN THE MATCH!`;
    let prizeText = 'BEST OF 3 VICTORY';
    if (data.prizePool) {
      prizeText += `\nPRIZE POOL: ${data.prizePool} SOL`;
    }
    roundScoresEl.innerHTML = prizeText.replace('\n', '<br>');
    
    // Show payout info
    if (data.payoutPerWinner && data.winner === myTeam) {
      const payoutEl = document.createElement('div');
      payoutEl.className = 'match-payout';
      payoutEl.textContent = `YOU WON +${data.payoutPerWinner.toFixed(4)} SOL!`;
      roundTimerOverlay.querySelector('.round-timer-content').appendChild(payoutEl);
    } else if (data.winner !== myTeam && data.prizePool > 0) {
      const lostEl = document.createElement('div');
      lostEl.className = 'match-prize-info';
      lostEl.style.color = '#c0392b';
      lostEl.textContent = 'ENTRY FEE LOST';
      roundTimerOverlay.querySelector('.round-timer-content').appendChild(lostEl);
    }
    roundTimerOverlay.querySelector('.round-timer').style.display = 'none';
  });

  socket.on('return_to_lobby', (data) => {
    // Hide match overlay and clean up any appended elements
    const timerContent = roundTimerOverlay.querySelector('.round-timer-content');
    timerContent.querySelectorAll('.match-payout, .match-prize-info').forEach(el => el.remove());
    roundTimerOverlay.style.display = 'none';
    roundTimerOverlay.querySelector('.round-timer').style.display = 'block';

    // Return to lobby UI
    document.getElementById('game-container').style.display = 'none';
    document.getElementById('lobby').style.display = 'flex';
    document.getElementById('scoreboard').style.display = 'none';
    document.getElementById('hud').style.display = 'none';
    document.getElementById('room-info').style.display = 'none';
    prizePoolHud.style.display = 'none';
    waitingOverlay.style.display = 'none';
    socket.removeAllListeners('game_start');
    document.body.classList.remove('in-game');
    showLobbyUI();
    joined = false;

    // Reset local game state
    myId = null;
    myTeam = null;
    localPlayer = null;
    predictedPlayer = null;
    serverState = { players: {}, bullets: [], scores: { usa: 0, iran: 0 } };
    inputs = { left: false, right: false, up: false, down: false };
    pendingInputs = [];
    currentPrizePool = 0;
    _lastPredictTime = 0;
    _latencySamples.length = 0;
    avgLatency = 50;

    // Update account stats from server response
    if (data.stats && currentAccount) {
      accountWins.textContent = data.stats.wins || 0;
      accountLosses.textContent = data.stats.losses || 0;
      accountKills.textContent = data.stats.kills || 0;
      accountDeaths.textContent = data.stats.deaths || 0;
      if (data.stats.balance !== undefined) {
        playerBalance = data.stats.balance;
        updateBalanceDisplay();
      }
    }

    // Fetch latest balance
    fetchBalance();

    // Notify server to reset room tracking for this socket
    socket.emit('returned_to_lobby');

    // Refresh leaderboard and rooms
    fetchLeaderboard();
    socket.emit('get_rooms');
  });

  socket.on('round_start', (data) => {
    // Update any UI elements for new round
    if (data.currentRound > 1) {
      countdownOverlay.style.display = 'flex';
      countdownOverlay.style.opacity = '1';
      countdownNumber.textContent = 'ROUND ' + data.currentRound;
      setTimeout(() => {
        countdownOverlay.style.opacity = '0';
        setTimeout(() => {
          countdownOverlay.style.display = 'none';
        }, 500);
      }, 1000);
    }
  });

  socket.on('game_reset', () => {
    // Other player left during game
    document.getElementById('game-container').style.display = 'none';
    document.getElementById('lobby').style.display = 'flex';
    document.getElementById('scoreboard').style.display = 'none';
    document.getElementById('hud').style.display = 'none';
    document.getElementById('room-info').style.display = 'none';
    prizePoolHud.style.display = 'none';
    waitingOverlay.style.display = 'none';
    socket.removeAllListeners('game_start');
    document.body.classList.remove('in-game'); // Remove game class
    showLobbyUI(); // Show chat and hide controls
    fetchLeaderboard(); // Refresh leaderboard on return to lobby
    fetchBalance(); // Refresh balance (might have been refunded)
    joined = false;
  });

  // Update waiting overlay when players join/leave
  socket.on('player_joined', (data) => {
    if (waitingOverlay.style.display !== 'none') {
      currentRoomPlayerCount++;
      waitingPlayers.textContent = currentRoomPlayerCount + ' / ' + currentRoomMaxPlayers;
    }
  });

  socket.on('player_left', (leftPlayerId) => {
    if (waitingOverlay.style.display !== 'none') {
      currentRoomPlayerCount = Math.max(0, currentRoomPlayerCount - 1);
      waitingPlayers.textContent = currentRoomPlayerCount + ' / ' + currentRoomMaxPlayers;
    }
  });

  // Leave room from waiting overlay
  waitingLeaveBtn.addEventListener('click', () => {
    socket.emit('leave_room');
    waitingOverlay.style.display = 'none';
    socket.removeAllListeners('game_start');
  });

  socket.on('joined', (data) => {
    myId = data.id;
    myTeam = data.team;
    config = data;
    if (data.prizePool !== undefined) currentPrizePool = data.prizePool;

    // Show waiting overlay
    currentRoomMaxPlayers = data.maxPlayers || (data.mode === '2v2' ? 4 : 2);
    currentRoomPlayerCount = data.playerCount || 1;
    waitingRoomId.textContent = data.roomId || '';
    const modeLabel = currentRoomMaxPlayers === 4 ? '2 VS 2 — SQUAD ASSAULT' : '1 VS 1 — COMBAT DUEL';
    waitingMode.textContent = modeLabel;
    waitingPlayers.textContent = currentRoomPlayerCount + ' / ' + currentRoomMaxPlayers;
    const isFreeRoom = !data.entryFee || data.entryFee === 0;
    if (isFreeRoom) {
      waitingFee.textContent = 'FREE PLAY — NO ENTRY FEE';
      waitingFee.className = 'waiting-fee free';
    } else {
      waitingFee.textContent = data.entryFee + ' SOL ENTRY';
      waitingFee.className = 'waiting-fee';
    }
    waitingOverlay.style.display = 'flex';

    socket.once('game_start', (startData) => {
      if (startData && startData.prizePool !== undefined) currentPrizePool = startData.prizePool;
      waitingOverlay.style.display = 'none';
      document.getElementById('lobby').style.display = 'none';
      document.getElementById('game-container').style.display = 'block';
      document.getElementById('scoreboard').style.display = 'flex';
      document.getElementById('hud').style.display = 'flex';
      document.getElementById('room-info').style.display = 'block';
      // Show prize pool HUD only for paid rooms
      if (config.entryFee && config.entryFee > 0) {
        prizePoolHud.style.display = 'flex';
        prizePoolAmount.textContent = currentPrizePool.toFixed(2);
      } else {
        prizePoolHud.style.display = 'none';
      }
      document.body.classList.add('in-game'); // Add class for CSS targeting
      showGameUI(); // This will hide chat and show controls
      // Force hide chat directly as backup
      document.getElementById('chat-container').style.display = 'none';
      joined = true;
      resizeCanvas();
      _lastPredictTime = 0; // reset prediction timer on game start
      requestAnimationFrame(gameLoop);
    });
    roomIdDisplay.textContent = data.roomId || '';

    // Team badge
    teamBadge.textContent = myTeam.toUpperCase();
    teamBadge.className = 'team-badge ' + (myTeam === 'usa' ? 'badge-usa' : 'badge-iran');

    resizeCanvas();
  });

  // ─── Resize ───
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  // Show controls when game starts
  function showGameUI() {
    document.getElementById('controls-info').style.display = 'block';
    document.getElementById('chat-container').style.display = 'none'; // Hide chat when game starts
  }

  // Show lobby UI when returning from game
  function showLobbyUI() {
    document.getElementById('controls-info').style.display = 'none';
    document.getElementById('chat-container').style.display = 'flex'; // Show chat in lobby
  }

  // Handle chat functionality
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatMessages = document.getElementById('chat-messages');

  // Chat visibility is controlled by showGameUI() and showLobbyUI() functions

  function addChatMessage(playerName, message, msgId) {
    // Deduplicate messages using ID (from Supabase) or content hash
    const key = msgId || `${playerName}:${message}:${Date.now()}`;
    if (msgId && displayedMessageIds.has(msgId)) return;
    if (msgId) displayedMessageIds.add(msgId);
    // Cap the dedup set to prevent memory leak
    if (displayedMessageIds.size > 200) {
      const first = displayedMessageIds.values().next().value;
      displayedMessageIds.delete(first);
    }
    const msgElement = document.createElement('div');
    msgElement.className = 'chat-message';
    msgElement.innerHTML = `<span class="player-name">${playerName}:</span>${message}`;
    chatMessages.appendChild(msgElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const message = chatInput.value.trim();
    if (message) {
      socket.emit('chat_message', message);
      chatInput.value = '';
    }
  }

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendChatMessage();
    }
  });

  chatSend.addEventListener('click', sendChatMessage);

  socket.on('chat_message', ({ playerName, message, msgId }) => {
    addChatMessage(playerName, message, msgId);
  });

  // ─── Auto-login on page load ───
  (async () => {
    await initSupabase();
    const loggedIn = await tryAutoLogin();
    if (!loggedIn) {
      authScreen.style.display = 'flex';
    }
  })();

  // ─── Input ───
  const keyMap = {
    'ArrowLeft': 'left', 'a': 'left', 'A': 'left',
    'ArrowRight': 'right', 'd': 'right', 'D': 'right',
    'ArrowUp': 'up', 'w': 'up', 'W': 'up',
    'ArrowDown': 'down', 's': 'down', 'S': 'down'
  };

  function sendInput() {
    inputSeq++;
    const inputSnapshot = { left: inputs.left, right: inputs.right, up: inputs.up, down: inputs.down };
    socket.emit('player_input', { inputs: inputSnapshot, seq: inputSeq });
    pendingInputs.push({ seq: inputSeq, inputs: inputSnapshot });
    // Guard against runaway growth (e.g. very high latency / tab hidden)
    if (pendingInputs.length > MAX_PENDING_INPUTS) {
      pendingInputs = pendingInputs.slice(-MAX_PENDING_INPUTS);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!joined) return;
    const action = keyMap[e.key];
    if (action && !inputs[action]) {
      inputs[action] = true;
      sendInput();
    }
    if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      socket.emit('player_shoot');
    }

    // Don't process game inputs when typing in chat
    if (document.activeElement === chatInput) {
      return;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!joined) return;
    const action = keyMap[e.key];
    if (action && inputs[action]) {
      inputs[action] = false;
      sendInput();
    }
  });

  // ─── Server Events ───
  socket.on('game_state', (state) => {
    serverState = state;
    const now = performance.now();

    // Update scores
    scoreUsa.textContent = state.scores.usa;
    scoreIran.textContent = state.scores.iran;

    // Update HUD
    const me = state.players[myId];
    if (me) {
      hpBar.style.width = me.hp + '%';
      hpBar.style.background = me.hp > 50 ? '#00ff41' : me.hp > 25 ? '#ffaa00' : '#ff4444';
      hpText.textContent = me.hp + ' HP';

      // Respawn overlay
      if (!me.alive) {
        respawnOverlay.style.display = 'flex';
        predictedPlayer = null;
      } else {
        respawnOverlay.style.display = 'none';

        // ── Server Reconciliation ──
        const serverAckedSeq = me.inputSeq || 0;

        // Drop inputs the server has already processed
        const firstUnacked = pendingInputs.findIndex(pi => pi.seq > serverAckedSeq);
        pendingInputs = firstUnacked === -1 ? [] : pendingInputs.slice(firstUnacked);

        // Re-simulate from server's authoritative state using unprocessed inputs
        predictedPlayer = {
          x: me.x, y: me.y,
          vx: 0, vy: me.vy || 0,
          onGround: me.onGround !== undefined ? me.onGround : true,
          facing: me.facing,
          crouching: me.crouching,
          team: me.team,
          hp: me.hp,
          alive: me.alive,
          id: me.id
        };

        // Re-apply each unacknowledged input at dt=1 (they were already sent at nominal tick rate)
        for (const pi of pendingInputs) {
          predictPhysics(predictedPlayer, pi.inputs, 1);
        }
      }

      localPlayer = predictedPlayer || me;
    }

    // ── Buffer snapshots for remote player interpolation ──
    for (const pid in state.players) {
      if (pid === myId) continue;
      if (!interpBuffer[pid]) interpBuffer[pid] = [];
      interpBuffer[pid].push({ time: now, state: state.players[pid] });
      // Keep only last 1 second of snapshots
      while (interpBuffer[pid].length > 2 && interpBuffer[pid][0].time < now - 1000) {
        interpBuffer[pid].shift();
      }
    }
    // Clean up disconnected players
    for (const pid in interpBuffer) {
      if (!state.players[pid]) delete interpBuffer[pid];
    }
  });

  socket.on('player_shot', (data) => {
    muzzleFlashes.push({
      x: data.x,
      y: data.y,
      facing: data.facing,
      team: data.team,
      time: performance.now(),
      duration: 80
    });
  });

  socket.on('player_hit', (data) => {
    hitMarkers.push({
      x: serverState.players[data.playerId]?.x || 0,
      y: serverState.players[data.playerId]?.y || 0,
      time: performance.now(),
      duration: 300
    });
  });

  socket.on('player_killed', (data) => {
    const victim = serverState.players[data.playerId];
    if (victim) {
      for (let i = 0; i < 15; i++) {
        deathParticles.push({
          x: victim.x + 15,
          y: victim.y + 25,
          vx: (Math.random() - 0.5) * 6,
          vy: (Math.random() - 0.5) * 6 - 3,
          life: 1.0,
          color: victim.team === 'usa' ? '#3b82f6' : '#ef4444'
        });
      }
    }

    // Kill feed
    const killerTeam = serverState.players[data.killerId]?.team || 'usa';
    const msg = document.createElement('div');
    msg.className = 'kill-msg';
    const kColor = killerTeam === 'usa' ? '#3b82f6' : '#ef4444';
    const vColor = data.playerId === myId ? '#fff' : (victim?.team === 'usa' ? '#3b82f6' : '#ef4444');
    const killerId = data.killerId === myId ? 'YOU' : data.killerId.slice(0, 6);
    const victimId = data.playerId === myId ? 'YOU' : data.playerId.slice(0, 6);
    msg.innerHTML = `<span style="color:${kColor}">${killerId}</span> ► <span style="color:${vColor}">${victimId}</span>`;
    killFeed.appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
  });

  // ─── Rendering ───
  const GRASS_COLORS = ['#3a8c3a', '#2d7a2d', '#45a045', '#339933'];

  function drawSky(w, h) {
    // Gradient sky matching the image — hazy blue
    const grad = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    grad.addColorStop(0, '#5b7ea8');
    grad.addColorStop(0.5, '#7a9dbd');
    grad.addColorStop(1, '#8aaa8a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h * 0.55);
  }

  function drawGrass(w, h, groundScreenY) {
    // Vibrant green grass below the battlefield
    const grassTop = groundScreenY + 30;
    const grad = ctx.createLinearGradient(0, grassTop, 0, h);
    grad.addColorStop(0, '#3d8b3d');
    grad.addColorStop(1, '#2a6e2a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, grassTop, w, h - grassTop);

    // Mower lines
    ctx.globalAlpha = 0.15;
    for (let y = grassTop; y < h; y += 12) {
      ctx.fillStyle = y % 24 < 12 ? '#4aa04a' : '#2d7a2d';
      ctx.fillRect(0, y, w, 6);
    }
    ctx.globalAlpha = 1.0;

    // Diagonal mower pattern
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#5ab85a';
    ctx.lineWidth = 2;
    for (let x = -h; x < w + h; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, grassTop);
      ctx.lineTo(x + (h - grassTop), h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }

  function drawTrench(trench, groundScreenY) {
    const tx = trench.x1 - camera.x;
    const tw = trench.x2 - trench.x1;

    // Trench hole
    ctx.fillStyle = '#3d2b1a';
    ctx.fillRect(tx, groundScreenY - 5, tw, trench.depth + 10);

    // Darker bottom
    ctx.fillStyle = '#2a1d10';
    ctx.fillRect(tx + 5, groundScreenY + trench.depth - 10, tw - 10, 15);

    // Earth rim / dirt piles
    ctx.fillStyle = '#5a3d2b';
    // Left pile
    drawDirtPile(tx - 15, groundScreenY - 15, 40, 20);
    drawDirtPile(tx + tw - 20, groundScreenY - 18, 45, 22);

    // Sandbags on top edges
    ctx.fillStyle = '#8a7a5a';
    for (let i = 0; i < 3; i++) {
      drawSandbag(tx + 5 + i * 22, groundScreenY - 14);
      drawSandbag(tx + tw - 25 - i * 22, groundScreenY - 14);
    }

    // Wooden supports inside trench
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(tx + 10, groundScreenY - 2, 4, trench.depth + 5);
    ctx.fillRect(tx + tw - 14, groundScreenY - 2, 4, trench.depth + 5);
    ctx.fillRect(tx + 10, groundScreenY - 2, tw - 20, 3);
  }

  function drawDirtPile(x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.quadraticCurveTo(x + w / 2, y - h * 0.3, x + w, y + h);
    ctx.fill();
  }

  function drawSandbag(x, y) {
    ctx.fillStyle = '#8a7a5a';
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + 18 - r, y);
    ctx.quadraticCurveTo(x + 18, y, x + 18, y + r);
    ctx.lineTo(x + 18, y + 10 - r);
    ctx.quadraticCurveTo(x + 18, y + 10, x + 18 - r, y + 10);
    ctx.lineTo(x + r, y + 10);
    ctx.quadraticCurveTo(x, y + 10, x, y + 10 - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
    // Tie line
    ctx.strokeStyle = '#6a5a3a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 9, y);
    ctx.lineTo(x + 9, y + 10);
    ctx.stroke();
  }

  function drawGround(w, groundScreenY) {
    // Main ground strip
    const grad = ctx.createLinearGradient(0, groundScreenY - 30, 0, groundScreenY + 35);
    grad.addColorStop(0, '#4a8a4a');
    grad.addColorStop(0.3, '#3d7a3d');
    grad.addColorStop(0.5, '#6b4a2a');
    grad.addColorStop(1, '#5a3d20');
    ctx.fillStyle = grad;
    ctx.fillRect(0, groundScreenY - 30, w, 65);

    // Grass tufts on top
    ctx.fillStyle = '#4a9a4a';
    for (let x = 0; x < w; x += 8) {
      const h = 3 + Math.sin(x * 0.3) * 2;
      ctx.fillRect(x, groundScreenY - 30 - h, 3, h);
    }
  }

  function drawBarbedWire(groundScreenY) {
    const centerX = config.mapWidth / 2 - camera.x;

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1.5;

    // X-shaped barriers
    for (let i = -2; i <= 2; i++) {
      const bx = centerX + i * 50;
      const by = groundScreenY - 30;

      // Wooden X post
      ctx.strokeStyle = '#5a4030';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx - 12, by);
      ctx.lineTo(bx + 12, by - 30);
      ctx.moveTo(bx + 12, by);
      ctx.lineTo(bx - 12, by - 30);
      ctx.stroke();

      // Wire
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      if (i < 2) {
        const nbx = centerX + (i + 1) * 50;
        for (let wy = 0; wy < 3; wy++) {
          ctx.beginPath();
          ctx.moveTo(bx + 12, by - 8 - wy * 10);
          const cp1y = by - 12 - wy * 10 + Math.sin(i + wy) * 4;
          ctx.quadraticCurveTo((bx + nbx) / 2, cp1y, nbx - 12, by - 8 - wy * 10);
          ctx.stroke();
        }
      }

      // Barbs
      ctx.fillStyle = '#888';
      for (let b = 0; b < 4; b++) {
        const bxp = bx - 8 + b * 6;
        const byp = by - 10 - b * 5;
        ctx.fillRect(bxp, byp, 2, 2);
      }
    }
  }

  function drawPlayer(p) {
    const px = p.x - camera.x;
    const pH = p.crouching ? config.playerCrouchH : config.playerH;
    const py = p.y;

    if (!p.alive) return;

    const isUSA = p.team === 'usa';
    // USA: Navy blue uniform with white/red accents
    // Iran: Dark green uniform with white/red accents
    const baseColor = isUSA ? '#1e3a5f' : '#1a5c2a';
    const darkColor = isUSA ? '#0f2440' : '#0e3d1a';
    const lightColor = isUSA ? '#3b82f6' : '#22c55e';
    const skinColor = '#d4a574';

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(px + config.playerW / 2, p.y + pH + 2, 14, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs
    ctx.fillStyle = darkColor;
    if (p.crouching) {
      // Crouching legs — folded
      ctx.fillRect(px + 4, py + pH - 10, 8, 10);
      ctx.fillRect(px + 18, py + pH - 10, 8, 10);
    } else {
      ctx.fillRect(px + 6, py + pH - 18, 7, 18);
      ctx.fillRect(px + 17, py + pH - 18, 7, 18);
    }

    // Boots
    ctx.fillStyle = '#2a2a2a';
    if (!p.crouching) {
      ctx.fillRect(px + 4, py + pH - 4, 10, 4);
      ctx.fillRect(px + 16, py + pH - 4, 10, 4);
    }

    // Body / torso
    ctx.fillStyle = baseColor;
    const torsoTop = p.crouching ? py + 4 : py + 8;
    const torsoH = p.crouching ? pH - 14 : pH - 26;
    ctx.fillRect(px + 3, torsoTop, 24, torsoH);

    // Tactical vest
    ctx.fillStyle = darkColor;
    ctx.fillRect(px + 5, torsoTop + 2, 20, torsoH - 4);
    // Vest pockets
    ctx.fillStyle = baseColor;
    ctx.fillRect(px + 7, torsoTop + 4, 6, 5);
    ctx.fillRect(px + 17, torsoTop + 4, 6, 5);

    // Flag accent stripes on shoulders
    if (isUSA) {
      // USA: red, white, blue stripes
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(px + 3, torsoTop, 2, torsoH);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 5, torsoTop, 1, torsoH);
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(px + 25, torsoTop, 2, torsoH);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 24, torsoTop, 1, torsoH);
    } else {
      // Iran: green, white, red stripes
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(px + 3, torsoTop, 2, torsoH);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 5, torsoTop, 1, torsoH);
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(px + 25, torsoTop, 2, torsoH);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px + 24, torsoTop, 1, torsoH);
    }

    // Arms
    ctx.fillStyle = baseColor;
    const armY = torsoTop + 4;
    if (p.facing === 1) {
      // Right-facing: gun arm extended
      ctx.fillRect(px + 24, armY, 12, 5);
      // Back arm
      ctx.fillRect(px - 4, armY + 2, 8, 5);
    } else {
      ctx.fillRect(px - 6, armY, 12, 5);
      ctx.fillRect(px + 26, armY + 2, 8, 5);
    }

    // Gun
    ctx.fillStyle = '#333';
    const gunY = armY + 1;
    if (p.facing === 1) {
      ctx.fillRect(px + 30, gunY, 16, 3);
      ctx.fillRect(px + 28, gunY - 2, 4, 7);
    } else {
      ctx.fillRect(px - 16, gunY, 16, 3);
      ctx.fillRect(px - 2, gunY - 2, 4, 7);
    }

    // Head
    ctx.fillStyle = skinColor;
    const headY = p.crouching ? py : py;
    ctx.fillRect(px + 8, headY, 14, 12);

    // Helmet
    ctx.fillStyle = isUSA ? '#0f2440' : '#0e3d1a';
    ctx.fillRect(px + 6, headY - 3, 18, 7);
    ctx.fillRect(px + 8, headY - 5, 14, 5);

    // Eyes
    ctx.fillStyle = '#000';
    if (p.facing === 1) {
      ctx.fillRect(px + 17, headY + 4, 3, 2);
    } else {
      ctx.fillRect(px + 10, headY + 4, 3, 2);
    }

    // Highlight if it's me
    if (p.id === myId) {
      ctx.strokeStyle = isUSA ? 'rgba(59,130,246,0.5)' : 'rgba(239,68,68,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 2, headY - 6, config.playerW + 4, pH + 8);

      // Name tag
      ctx.fillStyle = isUSA ? '#3b82f6' : '#ef4444';
      ctx.font = '8px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', px + config.playerW / 2, headY - 10);
    }

    // HP bar above player (for others)
    if (p.id !== myId) {
      const barW = 28;
      const barH = 3;
      const barX = px + (config.playerW - barW) / 2;
      const barY = headY - 12;
      ctx.fillStyle = '#333';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = p.hp > 50 ? '#00ff41' : p.hp > 25 ? '#ffaa00' : '#ff4444';
      ctx.fillRect(barX, barY, barW * (p.hp / 100), barH);

      // Name tag for others
      ctx.fillStyle = isUSA ? '#3b82f6' : '#ef4444';
      ctx.font = '6px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.fillText(p.id.slice(0, 6), px + config.playerW / 2, barY - 4);
      ctx.textAlign = 'left';
    }
  }

  function drawBullets() {
    for (const b of serverState.bullets) {
      const bx = b.x - camera.x;
      ctx.fillStyle = b.team === 'usa' ? '#93c5fd' : '#fca5a5';
      ctx.shadowColor = b.team === 'usa' ? '#3b82f6' : '#ef4444';
      ctx.shadowBlur = 6;
      ctx.fillRect(bx - 4, b.y - 1, 8, 3);
      ctx.shadowBlur = 0;

      // Trail
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = b.team === 'usa' ? '#3b82f6' : '#ef4444';
      const trailDir = b.team === 'usa' ? -1 : 1;
      ctx.fillRect(bx + trailDir * 8, b.y, 12, 1);
      ctx.globalAlpha = 1.0;
    }
  }

  function drawMuzzleFlashes() {
    const now = performance.now();
    for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
      const f = muzzleFlashes[i];
      const elapsed = now - f.time;
      if (elapsed > f.duration) {
        muzzleFlashes.splice(i, 1);
        continue;
      }
      const alpha = 1 - elapsed / f.duration;
      const fx = f.x - camera.x;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffff88';
      ctx.beginPath();
      ctx.arc(fx + f.facing * 10, f.y, 6 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(fx + f.facing * 8, f.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  }

  function drawHitMarkers() {
    const now = performance.now();
    for (let i = hitMarkers.length - 1; i >= 0; i--) {
      const h = hitMarkers[i];
      const elapsed = now - h.time;
      if (elapsed > h.duration) {
        hitMarkers.splice(i, 1);
        continue;
      }
      const alpha = 1 - elapsed / h.duration;
      const hx = h.x - camera.x + 15;
      const hy = h.y + 10;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      const s = 6 + elapsed * 0.02;
      ctx.beginPath();
      ctx.moveTo(hx - s, hy - s); ctx.lineTo(hx - s / 2, hy - s / 2);
      ctx.moveTo(hx + s, hy - s); ctx.lineTo(hx + s / 2, hy - s / 2);
      ctx.moveTo(hx - s, hy + s); ctx.lineTo(hx - s / 2, hy + s / 2);
      ctx.moveTo(hx + s, hy + s); ctx.lineTo(hx + s / 2, hy + s / 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }

  function updateDeathParticles() {
    for (let i = deathParticles.length - 1; i >= 0; i--) {
      const p = deathParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life -= 0.02;
      if (p.life <= 0) {
        deathParticles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - camera.x, p.y, 3, 3);
      ctx.globalAlpha = 1.0;
    }
  }

  // ─── Interpolation for remote players ───
  function getInterpolatedPlayer(pid) {
    const buf = interpBuffer[pid];
    if (!buf || buf.length === 0) return serverState.players[pid] || null;

    const renderTime = performance.now() - getInterpDelay();

    // Find two snapshots to interpolate between
    let prev = null, next = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= renderTime && buf[i + 1].time >= renderTime) {
        prev = buf[i];
        next = buf[i + 1];
        break;
      }
    }

    if (prev && next) {
      const raw = (renderTime - prev.time) / (next.time - prev.time);
      // Smoothstep: eliminates velocity discontinuities at snapshot boundaries
      const t = raw * raw * (3.0 - 2.0 * raw);
      return {
        ...next.state,
        x: prev.state.x + (next.state.x - prev.state.x) * t,
        y: prev.state.y + (next.state.y - prev.state.y) * t,
        facing: next.state.facing,
        crouching: next.state.crouching,
        onGround: next.state.onGround
      };
    }

    // If no pair found, use latest snapshot (avoids teleport on buffer underrun)
    return buf[buf.length - 1].state;
  }

  // ─── Local prediction tick (runs every frame) ───
  let _lastPredictTime = 0;
  function tickPrediction(now) {
    if (!predictedPlayer || !predictedPlayer.alive) return;
    // Compute dt relative to server's tick interval so prediction matches server physics
    const elapsed = _lastPredictTime ? now - _lastPredictTime : 1000 / 60;
    _lastPredictTime = now;
    const dt = Math.min(elapsed / (1000 / 60), 3);
    predictPhysics(predictedPlayer, inputs, dt);
    localPlayer = predictedPlayer;
  }

  // ─── Camera ───
  function updateCamera() {
    if (!localPlayer) return;
    const scale = getScale();
    const viewW = canvas.width / scale;
    const targetX = localPlayer.x - viewW / 2 + config.playerW / 2;
    camera.x += (targetX - camera.x) * 0.1;
    const maxCamX = Math.max(0, config.mapWidth - viewW);
    camera.x = Math.max(0, Math.min(maxCamX, camera.x));
  }

  // ─── Scale & coordinate mapping ───
  function getScale() {
    // Map the 600px game height to the canvas
    return canvas.height / config.mapHeight;
  }

  // ─── Latency measurement (fires every 3s while in-game) ───
  setInterval(() => {
    if (joined) socket.emit('ping_measure', performance.now());
  }, 3000);

  socket.on('pong_measure', (sentAt) => {
    const rtt = performance.now() - sentAt;
    _latencySamples.push(rtt / 2); // one-way latency
    if (_latencySamples.length > 10) _latencySamples.shift();
    avgLatency = _latencySamples.reduce((a, b) => a + b, 0) / _latencySamples.length;
  });

  // ─── Main Game Loop ───
  function gameLoop(now) {
    if (!joined) return;

    const w = canvas.width;
    const h = canvas.height;
    const scale = getScale();

    // Run local prediction for our player
    tickPrediction(now);

    updateCamera();

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(scale, scale);

    // Adjust camera and canvas for scale
    const scaledW = w / scale;
    const scaledH = h / scale;

    // Sky
    drawSky(scaledW, scaledH);

    // Ground
    const groundScreenY = config.groundY;
    drawGround(scaledW, groundScreenY);

    // Grass below
    drawGrass(scaledW, scaledH, groundScreenY);

    // Trenches
    drawTrench(config.trenchLeft, groundScreenY);
    drawTrench(config.trenchRight, groundScreenY);

    // Barbed wire
    drawBarbedWire(groundScreenY);

    // Bullets
    drawBullets();

    // Players — use predicted position for self, interpolated for others
    for (const pid in serverState.players) {
      if (pid === myId) {
        // Draw our predicted player
        if (localPlayer) drawPlayer(localPlayer);
      } else {
        // Draw interpolated remote player
        const interp = getInterpolatedPlayer(pid);
        if (interp) drawPlayer(interp);
      }
    }

    // Effects
    drawMuzzleFlashes();
    drawHitMarkers();
    updateDeathParticles();

    ctx.restore();

    requestAnimationFrame(gameLoop);
  }

  // ─── Grain overlay animation (extra layer via canvas) ───
  // The CSS handles the main CRT effect; this adds subtle per-frame noise
  let grainCanvas, grainCtx;
  function initGrain() {
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = 256;
    grainCanvas.height = 256;
    grainCtx = grainCanvas.getContext('2d');
  }
  initGrain();

  // Initialize lobby UI (show chat, hide controls)
  showLobbyUI();

})();
