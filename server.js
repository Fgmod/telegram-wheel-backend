import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// путь к файлу users.json
const USERS_FILE = path.join(__dirname, 'users.json');

// Настройки CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

// Настройки игры
const START_BALANCE = 1000;
const ADMIN_IDS = ["1743237033"]; 

// Функции для работы с файлом пользователей (в разработке)
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading users:', error);
    }
    return { users: {}, lastUpdated: new Date().toISOString() };
}

function saveUsers(data) {
    try {
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving users:', error);
        return false;
    }
}

// Загрузка пользователей при старте
let usersData = loadUsers();
let players = {};
let lobbies = {
  bots: { players: [], ready: true, bets: {} },
  pvp: { players: [], ready: false, bets: {}, readyCount: 0 }
};
let roundActive = false;
let gameMode = "bots";

// Статистика игры
let gameStats = {
  totalRounds: 0,
  totalWins: 0,
  totalLosses: 0,
  totalBets: 0,
  playerStats: {}
};

// Инициализация или обновление статистики игрока 
function initPlayerStats(userId, userName) {
    if (!usersData.users[userId]) {
        usersData.users[userId] = {
            id: userId,
            name: userName,
            balance: START_BALANCE,
            totalWins: 0,
            totalLosses: 0,
            totalBets: 0,
            totalWon: 0,
            gamesPlayed: 0,
            joinDate: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            emoji: getRandomEmoji()
        };
        saveUsers(usersData);
    } else {
        // Обновление времени последней активности
        usersData.users[userId].lastActive = new Date().toISOString();
        saveUsers(usersData);
    }
    
    // Инициализация статистики для текущей сессии
    if (!gameStats.playerStats[userId]) {
        gameStats.playerStats[userId] = { 
            wins: usersData.users[userId].totalWins || 0, 
            losses: usersData.users[userId].totalLosses || 0, 
            totalBet: usersData.users[userId].totalBets || 0,
            totalWon: usersData.users[userId].totalWon || 0 
        };
    }
}

// Функция для получения случайного эмодзи
function getRandomEmoji() {
    const emojis = ['👤', '🎮', '💎', '🚀', '⭐', '👽', '🦄', '🐉', '🐲', '🦁', '🐯', '🐶', '🐱', '🐼', '🦊', '🐻', '🐨', '🐵', '🦍'];
    return emojis[Math.floor(Math.random() * emojis.length)];
}

// Обновление статистики игрока после игры
function updatePlayerStats(userId, winAmount, betAmount, won) {
    if (!usersData.users[userId]) return;
    
    const user = usersData.users[userId];
    
    user.gamesPlayed = (user.gamesPlayed || 0) + 1;
    user.totalBets = (user.totalBets || 0) + betAmount;
    user.lastActive = new Date().toISOString();
    
    if (won) {
        user.totalWins = (user.totalWins || 0) + 1;
        user.totalWon = (user.totalWon || 0) + winAmount;
        user.balance = (user.balance || START_BALANCE) + winAmount;
    } else {
        user.totalLosses = (user.totalLosses || 0) + 1;
        user.balance = Math.max(0, (user.balance || START_BALANCE) - betAmount);
    }
    
    // Сохраняем в файл
    saveUsers(usersData);
    
    // Обновляем статистику текущей сессии
    if (gameStats.playerStats[userId]) {
        if (won) {
            gameStats.playerStats[userId].wins++;
            gameStats.playerStats[userId].totalWon += winAmount;
        } else {
            gameStats.playerStats[userId].losses++;
        }
        gameStats.playerStats[userId].totalBet += betAmount;
    }
}

// Создание ботов
function createBot(id) {
  return {
    id: "bot_" + id,
    name: "🤖 BOT_" + id,
    bet: 0,
    balance: START_BALANCE,
    isBot: true,
    ws: null,
    chanceMultiplier: 0.8 + Math.random() * 0.4,
    lobbyId: "bots",
    ready: true,
    emoji: "🤖"
  };
}

// Инициализация ботов (5 штук)
for (let i = 1; i <= 5; i++) {
  const bot = createBot(i);
  players["bot_" + i] = bot;
  lobbies.bots.players.push("bot_" + i);
}

// Утилиты
function broadcastToLobby(lobbyId, data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      const player = Object.values(players).find(p => p.ws === client);
      if (player && player.lobbyId === lobbyId) {
        client.send(JSON.stringify(data));
      }
    }
  });
}

function broadcastState(lobbyId) {
  const lobby = lobbies[lobbyId];
  const lobbyPlayers = lobby.players.map(id => players[id]).filter(p => p);
  
  // Рассчитывание общего банка для лобби
  const lobbyBank = lobbyPlayers.reduce((sum, p) => sum + (p.bet || 0), 0);
  
  const data = {
    type: "state",
    players: lobbyPlayers.map(p => {
      const chance = lobbyBank > 0 ? ((p.bet / lobbyBank) * 100 * (p.chanceMultiplier || 1)).toFixed(1) : "0.0";
      const userData = usersData.users[p.id];
      
      return {
        id: p.id,
        name: p.name,
        bet: p.bet || 0,
        balance: p.balance || START_BALANCE,
        chance: chance,
        isBot: p.isBot,
        isOnline: p.ws !== null,
        ready: p.ready || false,
        lobbyId: p.lobbyId,
        emoji: userData?.emoji || (p.isBot ? "🤖" : "👤")
      };
    }),
    totalBank: lobbyBank,
    gameMode: lobbyId,
    readyPlayers: lobbyPlayers.filter(p => p.ready).length,
    totalPlayers: lobbyPlayers.length,
    lobbyReady: lobby.ready
  };
  
  broadcastToLobby(lobbyId, data);
}

// Боты делают ставки
function botMakeBets() {
  const botPlayers = lobbies.bots.players
    .map(id => players[id])
    .filter(p => p && p.isBot);
  
  botPlayers.forEach(p => {
    if (p.balance > 0) {
      // Боты ставят только если игрок поставил
      const humanPlayer = lobbies.bots.players
        .map(id => players[id])
        .find(player => !player.isBot && player.bet > 0);
      
      if (humanPlayer) {
        const baseBet = Math.min(p.balance * (0.1 + Math.random() * 0.3), 500);
        const amount = Math.floor(baseBet / 10) * 10;
        
        if (p.balance >= amount && amount > 0) {
          p.balance -= amount;
          p.bet = amount;
          gameStats.totalBets += amount;
          
          if (!gameStats.playerStats[p.id]) {
            gameStats.playerStats[p.id] = { 
              wins: 0, 
              losses: 0, 
              totalBet: 0,
              totalWon: 0 
            };
          }
          gameStats.playerStats[p.id].totalBet += amount;
        }
      }
    }
  });
}

// Проверка готовности PvP лобби
function checkPvPReady() {
  const pvpPlayers = lobbies.pvp.players.map(id => players[id]).filter(p => p && !p.isBot);
  const readyPlayers = pvpPlayers.filter(p => p.ready).length;
  const totalPlayers = pvpPlayers.length;
  
  lobbies.pvp.readyCount = readyPlayers;
  lobbies.pvp.ready = readyPlayers >= 2 && readyPlayers === totalPlayers;
  
  if (lobbies.pvp.ready) {
    // Уведомление всех о готовности
    broadcastToLobby("pvp", {
      type: "lobby_ready",
      message: "Все игроки готовы! Раунд начинается через 5 секунд..."
    });
    
    // Автоматический запуск раунда через 5 секунд
    setTimeout(() => {
      if (lobbies.pvp.ready && !roundActive) {
        startRound("pvp");
      }
    }, 5000);
  }
  
  return lobbies.pvp.ready;
}

// Запуск раунда
function startRound(lobbyId) {
  if (roundActive) return;
  
  const lobby = lobbies[lobbyId];
  const lobbyPlayers = lobby.players.map(id => players[id]).filter(p => p);
  const lobbyBank = lobbyPlayers.reduce((sum, p) => sum + (p.bet || 0), 0);
  
  if (lobbyBank === 0) {
    broadcastToLobby(lobbyId, {
      type: "error",
      message: "Нет ставок для начала раунда"
    });
    return;
  }
  
  // Проверка PvP режима
  if (lobbyId === "pvp") {
    const humanPlayers = lobbyPlayers.filter(p => !p.isBot);
    if (humanPlayers.length < 2) {
      broadcastToLobby(lobbyId, {
        type: "error",
        message: "Нужно минимум 2 игрока для PvP"
      });
      return;
    }
    
    if (!lobby.ready) {
      broadcastToLobby(lobbyId, {
        type: "error",
        message: "Не все игроки готовы"
      });
      return;
    }
  }
  
  roundActive = true;
  
  // Подготовка сектора с эмодзи
  const sectors = calculateSectors(lobbyPlayers);
  
  broadcastToLobby(lobbyId, { 
    type: "round_start", 
    time: 6,
    sectors: sectors
  });
  
  setTimeout(() => {
    // Взвешенная случайность
    let weightedTotal = 0;
    lobbyPlayers.forEach(p => {
      weightedTotal += p.bet * (p.chanceMultiplier || 1);
    });
    
    let rand = Math.random() * weightedTotal;
    let winner;
    
    for (const p of lobbyPlayers) {
      rand -= p.bet * (p.chanceMultiplier || 1);
      if (rand <= 0) { 
        winner = p; 
        break; 
      }
    }
    
    if (!winner && lobbyPlayers.length > 0) {
      winner = lobbyPlayers[0];
    }
    
    if (winner) {
      winner.balance += lobbyBank;
      
      if (!winner.isBot) {
        gameStats.totalWins++;
        updatePlayerStats(winner.id, lobbyBank, winner.bet, true);
      }
    }
    
    // Статистика проигравших
    lobbyPlayers.forEach(p => {
      if (p !== winner && !p.isBot) {
        gameStats.totalLosses++;
        updatePlayerStats(p.id, 0, p.bet, false);
      }
    });
    
    gameStats.totalRounds++;
    
    // Сбрасывание готовности для PvP
    if (lobbyId === "pvp") {
      lobbyPlayers.forEach(p => {
        if (!p.isBot) p.ready = false;
      });
      lobby.ready = false;
      lobby.readyCount = 0;
    }
    
    // Получение эмодзи победителя
    const winnerEmoji = usersData.users[winner?.id]?.emoji || (winner?.isBot ? "🤖" : "👤");
    
    broadcastToLobby(lobbyId, {
      type: "round_end",
      winnerId: winner?.id,
      winnerName: winner?.name,
      winnerEmoji: winnerEmoji,
      winAmount: lobbyBank,
      stats: gameStats
    });
    
    // Сброс ставок
    lobbyPlayers.forEach(p => p.bet = 0);
    roundActive = false;
    
    broadcastState(lobbyId);
    
  }, 6000);
}

// Расчет секторов колеса с эмодзи
function calculateSectors(lobbyPlayers) {
  const playersWithBets = lobbyPlayers.filter(p => p.bet > 0);
  const totalBet = playersWithBets.reduce((sum, p) => sum + p.bet, 0);
  
  if (playersWithBets.length === 0) {
    return [
      { name: "Пусто", color: "#666", size: 100, emoji: "🎲" }
    ];
  }
  
  const sectors = [];
  const colors = ["#2fff9d", "#ff4d4d", "#4d7cff", "#ffd54a", "#9d2fff", "#2fffcf", "#ff9d2f", "#4dffb8"];
  
  playersWithBets.forEach((player, index) => {
    const percentage = (player.bet / totalBet) * 100;
    if (percentage > 0) {
      const userData = usersData.users[player.id];
      sectors.push({
        name: player.name.substring(0, 10),
        color: colors[index % colors.length],
        size: percentage,
        playerId: player.id,
        isBot: player.isBot,
        emoji: userData?.emoji || (player.isBot ? "🤖" : "👤")
      });
    }
  });
  
  return sectors;
}

// Админ функции
function adminCommand(command, data, adminId) {
  if (!ADMIN_IDS.includes(adminId.toString())) {
    return { success: false, error: "Access denied" };
  }
  
  switch (command) {
    case "add_balance":
      if (players[data.userId]) {
        players[data.userId].balance += data.amount;
        
        // Обновление в файле (в разработке) 
        if (usersData.users[data.userId]) {
          usersData.users[data.userId].balance = players[data.userId].balance;
          saveUsers(usersData);
        }
        
        broadcastState(players[data.userId].lobbyId);
        return { 
          success: true, 
          newBalance: players[data.userId].balance 
        };
      }
      break;
      
    case "get_stats":
      return { 
        success: true, 
        stats: gameStats,
        users: usersData,
        players: Object.values(players).filter(p => !p.isBot).map(p => ({
          id: p.id,
          name: p.name,
          balance: p.balance,
          lobbyId: p.lobbyId,
          wins: gameStats.playerStats[p.id]?.wins || 0,
          losses: gameStats.playerStats[p.id]?.losses || 0,
          totalBet: gameStats.playerStats[p.id]?.totalBet || 0,
          totalWon: gameStats.playerStats[p.id]?.totalWon || 0,
          emoji: usersData.users[p.id]?.emoji || "👤"
        }))
      };
      
    case "reset_game":
      Object.values(players).forEach(p => {
        if (!p.isBot) {
          p.balance = START_BALANCE;
          p.bet = 0;
          
          // Обновление в файле 
          if (usersData.users[p.id]) {
            usersData.users[p.id].balance = START_BALANCE;
          }
        }
      });
      saveUsers(usersData);
      return { success: true };
      
    case "set_balance":
      if (players[data.userId]) {
        players[data.userId].balance = data.amount;
        
        // Обновление в файле
        if (usersData.users[data.userId]) {
          usersData.users[data.userId].balance = data.amount;
          saveUsers(usersData);
        }
        
        broadcastState(players[data.userId].lobbyId);
        return { 
          success: true, 
          newBalance: players[data.userId].balance 
        };
      }
      break;
      
    case "kick_player":
      if (players[data.userId]) {
        // Удаление из лобби
        const lobby = lobbies[players[data.userId].lobbyId];
        if (lobby) {
          lobby.players = lobby.players.filter(id => id !== data.userId);
        }
        delete players[data.userId];
        return { success: true };
      }
      break;
      
    case "reset_user_stats":
      if (usersData.users[data.userId]) {
        usersData.users[data.userId] = {
          ...usersData.users[data.userId],
          balance: START_BALANCE,
          totalWins: 0,
          totalLosses: 0,
          totalBets: 0,
          totalWon: 0,
          gamesPlayed: 0
        };
        saveUsers(usersData);
        
        if (players[data.userId]) {
          players[data.userId].balance = START_BALANCE;
          broadcastState(players[data.userId].lobbyId);
        }
        
        return { success: true };
      }
      break;
  }
  return { success: false, error: "Unknown command" };
}

// WebSocket соединения
wss.on("connection", (ws, req) => {
  console.log("New connection from:", req.socket.remoteAddress);
  
  ws.on("message", msg => {
    try {
      const data = JSON.parse(msg);
      
      // Подключение игрока
      if (data.type === "join") {
        const isAdmin = ADMIN_IDS.includes(data.id.toString());
        const isNewPlayer = !players[data.id];
        
        // Инициализация или загрузка статистики игрока
        initPlayerStats(data.id, data.name || `Player_${data.id.toString().slice(-4)}`);
        
        if (isNewPlayer) {
          players[data.id] = {
            id: data.id,
            name: data.name || `Player_${data.id.toString().slice(-4)}`,
            bet: 0,
            balance: usersData.users[data.id]?.balance || START_BALANCE,
            isBot: false,
            ws,
            lobbyId: "bots",
            chanceMultiplier: 0.9 + Math.random() * 0.2,
            isAdmin: isAdmin,
            ready: false,
            emoji: usersData.users[data.id]?.emoji || getRandomEmoji()
          };
          
          lobbies.bots.players.push(data.id);
          
          if (!gameStats.playerStats[data.id]) {
            gameStats.playerStats[data.id] = { 
              wins: 0, 
              losses: 0, 
              totalBet: 0,
              totalWon: 0 
            };
          }
        } else {
          players[data.id].ws = ws;
          // Обновление баланса из сохраненных данных
          players[data.id].balance = usersData.users[data.id]?.balance || START_BALANCE;
        }
        
        // Отправление полной статистики игрока
        const userStats = usersData.users[data.id] || {};
        
        ws.send(JSON.stringify({
          type: "init",
          balance: players[data.id].balance,
          isAdmin: players[data.id].isAdmin,
          gameMode: players[data.id].lobbyId,
          playerId: data.id,
          playerEmoji: players[data.id].emoji,
          stats: {
            totalWins: userStats.totalWins || 0,
            totalLosses: userStats.totalLosses || 0,
            totalBets: userStats.totalBets || 0,
            totalWon: userStats.totalWon || 0,
            gamesPlayed: userStats.gamesPlayed || 0,
            joinDate: userStats.joinDate || new Date().toISOString()
          }
        }));
        
        broadcastState(players[data.id].lobbyId);
      }
      
      // Выбор режима игры
      if (data.type === "select_mode") {
        const player = players[data.id];
        if (player) {
          // Удаление из старого лобби
          const oldLobby = lobbies[player.lobbyId];
          if (oldLobby) {
            oldLobby.players = oldLobby.players.filter(id => id !== player.id);
          }
          
          // Добавление в новое лобби
          player.lobbyId = data.mode;
          lobbies[data.mode].players.push(player.id);
          player.ready = false;
          
          broadcastState(oldLobby?.id || "bots");
          broadcastState(data.mode);
          
          ws.send(JSON.stringify({
            type: "mode_changed",
            mode: data.mode
          }));
        }
      }
      
      // Готовность к игре (только для PvP)
      if (data.type === "toggle_ready") {
        const player = players[data.id];
        if (player && player.lobbyId === "pvp") {
          player.ready = !player.ready;
          
          // Проверка готовности лобби
          checkPvPReady();
          
          broadcastState("pvp");
        }
      }
      
      // Ставка
      if (data.type === "bet" && !roundActive) {
        const player = players[data.id];
        const amount = Number(data.amount);
        
        if (player && amount > 0 && player.balance >= amount) {
          player.balance -= amount;
          player.bet = amount;
          gameStats.totalBets += amount;
          
          if (!gameStats.playerStats[player.id]) {
            gameStats.playerStats[player.id] = { 
              wins: 0, 
              losses: 0, 
              totalBet: 0,
              totalWon: 0 
            };
          }
          gameStats.playerStats[player.id].totalBet += amount;
          
          // Если режим с ботами, боты тоже ставят
          if (player.lobbyId === "bots") {
            setTimeout(() => {
              if (!roundActive) {
                botMakeBets();
                broadcastState("bots");
              }
            }, 500);
          }
          
          broadcastState(player.lobbyId);
        }
      }
      
      // Сброс ставки
      if (data.type === "clear_bet" && !roundActive) {
        const player = players[data.id];
        if (player && player.bet > 0) {
          player.balance += player.bet;
          player.bet = 0;
          broadcastState(player.lobbyId);
        }
      }
      
      // Старт раунда
      if (data.type === "start" && !roundActive) {
        const player = players[data.id];
        if (player) {
          if (player.lobbyId === "pvp") {
            player.ready = true;
            checkPvPReady();
            broadcastState("pvp");
          } else {
            startRound(player.lobbyId);
          }
        }
      }
      
      // Админ команды
      if (data.type === "admin_command") {
        const player = players[data.id];
        if (player) {
          const result = adminCommand(data.command, data.data, player.id);
          ws.send(JSON.stringify({
            type: "admin_response",
            ...result
          }));
        }
      }
      
      // Сообщение поддержке
      if (data.type === "support_message") {
        const player = players[data.id];
        if (player) {
          console.log(`📩 Support message from ${player.name} (${player.id}): ${data.message}`);
          
          // Уведомление только администраторам (по id)
          Object.values(players).forEach(p => {
            if (p.isAdmin && p.ws) {
              p.ws.send(JSON.stringify({
                type: "support_notification",
                fromId: player.id,
                fromName: player.name,
                message: data.message,
                balance: player.balance
              }));
            }
          });
          
          ws.send(JSON.stringify({
            type: "support_response",
            message: "✅ Ваше сообщение получено. Администратор свяжется с вами."
          }));
        }
      }
      
      // Проверка состояния
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });
  
  ws.on("close", () => {
    console.log("Connection closed");
    for (const id in players) {
      if (players[id].ws === ws) {
        players[id].ws = null;
        broadcastState(players[id].lobbyId);
      }
    }
  });
  
  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// REST API для админ-панели (только для авторизованных)
app.post("/admin/api", (req, res) => {
  const { token, command, data } = req.body;
  
  // Проверка через id из параметра
  const adminId = req.query.adminId || data?.adminId;
  if (!adminId || !ADMIN_IDS.includes(adminId.toString())) {
    return res.status(403).json({ error: "Access denied" });
  }
  
  const result = adminCommand(command, data, adminId);
  res.json(result);
});

// Информация о сервере
app.get("/api/info", (req, res) => {
  res.json({
    status: "online",
    players: Object.values(players).filter(p => !p.isBot && p.ws).length,
    bots: Object.values(players).filter(p => p.isBot).length,
    totalRounds: gameStats.totalRounds,
    totalUsers: Object.keys(usersData.users).length,
    uptime: process.uptime()
  });
});

// Получение статистики пользователя
app.get("/api/user/:userId", (req, res) => {
  const userId = req.params.userId;
  
  if (usersData.users[userId]) {
    res.json({
      success: true,
      user: usersData.users[userId]
    });
  } else {
    res.json({
      success: false,
      error: "User not found"
    });
  }
});

// Сброс статистики пользователя (только для админа)
app.post("/api/reset-stats/:userId", (req, res) => {
  const userId = req.params.userId;
  const adminId = req.query.adminId;
  
  if (!adminId || !ADMIN_IDS.includes(adminId.toString())) {
    return res.status(403).json({ error: "Access denied" });
  }
  
  if (usersData.users[userId]) {
    usersData.users[userId] = {
      ...usersData.users[userId],
      balance: START_BALANCE,
      totalWins: 0,
      totalLosses: 0,
      totalBets: 0,
      totalWon: 0,
      gamesPlayed: 0
    };
    
    saveUsers(usersData);
    
    res.json({
      success: true,
      message: "User stats reset"
    });
  } else {
    res.json({
      success: false,
      error: "User not found"
    });
  }
});

// Получение всех пользователей (только для админа)
app.get("/api/all-users", (req, res) => {
  const adminId = req.query.adminId;
  
  if (!adminId || !ADMIN_IDS.includes(adminId.toString())) {
    return res.status(403).json({ error: "Access denied" });
  }
  
  res.json({
    success: true,
    totalUsers: Object.keys(usersData.users).length,
    users: Object.values(usersData.users).map(user => ({
      id: user.id,
      name: user.name,
      balance: user.balance,
      totalWins: user.totalWins,
      totalLosses: user.totalLosses,
      totalBets: user.totalBets,
      totalWon: user.totalWon,
      gamesPlayed: user.gamesPlayed,
      joinDate: user.joinDate,
      lastActive: user.lastActive,
      emoji: user.emoji
    }))
  });
});

// Проверка работоспособности
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    usersCount: Object.keys(usersData.users).length
  });
});

// Обслуживание статичного админ-интерфейса
app.get("/admin", (req, res) => {
  const adminId = req.query.id;
  if (!adminId || !ADMIN_IDS.includes(adminId)) {
    return res.status(403).send("Access denied");
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Panel - Spins</title>
        <style>
            body { font-family: Arial; padding: 20px; background: #0a0c14; color: white; }
            .container { max-width: 800px; margin: 0 auto; }
            .stat { background: #1a1f2e; padding: 15px; margin: 10px 0; border-radius: 5px; border: 1px solid #2fff9d33; }
            h1 { color: #2fff9d; }
            .user-list { margin-top: 20px; }
            .user-item { padding: 10px; border-bottom: 1px solid #2fff9d33; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Spins Backend</h1>
            <p>Status: <strong>Online</strong></p>
            <p>Админ ID: ${adminId}</p>
            <div class="stat">
                <h3>Статистика сервера:</h3>
                <p>Всего пользователей: ${Object.keys(usersData.users).length}</p>
                <p>Активных игроков: ${Object.values(players).filter(p => !p.isBot && p.ws).length}</p>
                <p>Всего раундов: ${gameStats.totalRounds}</p>
                <p>Дата обновления: ${usersData.lastUpdated || 'Нет данных'}</p>
            </div>
            <div class="user-list">
                <h3>Последние пользователи:</h3>
                ${Object.values(usersData.users).slice(-10).reverse().map(user => `
                    <div class="user-item">
                        ${user.emoji || '👤'} ${user.name} (${user.id}) - Баланс: ${user.balance} 
                        - Игр: ${user.gamesPlayed || 0}
                    </div>
                `).join('')}
            </div>
        </div>
    </body>
    </html>
  `);
});

// Корневой маршрут
app.get("/", (req, res) => {
  res.json({
    name: "Telegram Spins Backend",
    version: "1.0.0",
    endpoints: ["/health", "/api/info", "/api/user/:userId"],
    websocket: "wss://" + req.get('host'),
    totalUsers: Object.keys(usersData.users).length,
    dataFile: "users.json"
  });
});

// Обработка 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Backend server started on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
  console.log(`👑 Admin ID: 1743237033`);
  console.log(`📁 Users file: ${USERS_FILE}`);
  console.log(`👥 Total registered users: ${Object.keys(usersData.users).length}`);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log("\n⚡ Development mode");
    console.log("🤖 Bots created:", Object.values(players).filter(p => p.isBot).length);
    console.log("💾 Data will be saved to:", USERS_FILE);
  }
});
