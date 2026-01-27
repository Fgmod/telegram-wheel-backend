import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Настройки CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

// Настройки игры
const START_BALANCE = 1000;
const ADMIN_IDS = ["1743237033"]; // Ваш Telegram ID

// Хранилища данных
let players = {};
let lobbies = {
  bots: { players: [], ready: true, bets: {} },
  pvp: { players: [], ready: false, bets: {}, readyCount: 0 }
};
let roundActive = false;
let gameMode = "bots";

// Статистика
let gameStats = {
  totalRounds: 0,
  totalWins: 0,
  totalLosses: 0,
  totalBets: 0,
  playerStats: {}
};

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
    ready: true
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
  
  // Рассчитываем общий банк для лобби
  const lobbyBank = lobbyPlayers.reduce((sum, p) => sum + (p.bet || 0), 0);
  
  const data = {
    type: "state",
    players: lobbyPlayers.map(p => {
      const chance = lobbyBank > 0 ? ((p.bet / lobbyBank) * 100 * (p.chanceMultiplier || 1)).toFixed(1) : "0.0";
      return {
        id: p.id,
        name: p.name,
        bet: p.bet || 0,
        balance: p.balance || START_BALANCE,
        chance: chance,
        isBot: p.isBot,
        isOnline: p.ws !== null,
        ready: p.ready || false,
        lobbyId: p.lobbyId
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
    // Уведомляем всех о готовности
    broadcastToLobby("pvp", {
      type: "lobby_ready",
      message: "Все игроки готовы! Раунд начинается через 5 секунд..."
    });
    
    // Автоматически запускаем раунд через 5 секунд
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
  
  broadcastToLobby(lobbyId, { 
    type: "round_start", 
    time: 6,
    sectors: calculateSectors(lobbyPlayers)
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
        if (!gameStats.playerStats[winner.id]) {
          gameStats.playerStats[winner.id] = { 
            wins: 0, 
            losses: 0, 
            totalBet: 0,
            totalWon: 0 
          };
        }
        gameStats.playerStats[winner.id].wins++;
        gameStats.playerStats[winner.id].totalWon += lobbyBank;
      }
    }
    
    // Статистика проигравших
    lobbyPlayers.forEach(p => {
      if (p !== winner && !p.isBot) {
        gameStats.totalLosses++;
        if (!gameStats.playerStats[p.id]) {
          gameStats.playerStats[p.id] = { 
            wins: 0, 
            losses: 0, 
            totalBet: 0,
            totalWon: 0 
          };
        }
        gameStats.playerStats[p.id].losses++;
        gameStats.playerStats[p.id].totalBet += p.bet;
      }
    });
    
    gameStats.totalRounds++;
    
    // Сбрасываем готовность для PvP
    if (lobbyId === "pvp") {
      lobbyPlayers.forEach(p => {
        if (!p.isBot) p.ready = false;
      });
      lobby.ready = false;
      lobby.readyCount = 0;
    }
    
    broadcastToLobby(lobbyId, {
      type: "round_end",
      winnerId: winner?.id,
      winnerName: winner?.name,
      winAmount: lobbyBank,
      stats: gameStats
    });
    
    // Сброс ставок
    lobbyPlayers.forEach(p => p.bet = 0);
    roundActive = false;
    
    broadcastState(lobbyId);
    
  }, 6000);
}

// Расчет секторов колеса
function calculateSectors(lobbyPlayers) {
  const playersWithBets = lobbyPlayers.filter(p => p.bet > 0);
  const totalBet = playersWithBets.reduce((sum, p) => sum + p.bet, 0);
  
  if (playersWithBets.length === 0) {
    return [
      { name: "Пусто", color: "#666", size: 100 }
    ];
  }
  
  const sectors = [];
  const colors = ["#2fff9d", "#ff4d4d", "#4d7cff", "#ffd54a", "#9d2fff", "#2fffcf", "#ff9d2f", "#4dffb8"];
  
  playersWithBets.forEach((player, index) => {
    const percentage = (player.bet / totalBet) * 100;
    if (percentage > 0) {
      sectors.push({
        name: player.name.substring(0, 10),
        color: colors[index % colors.length],
        size: percentage,
        playerId: player.id
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
        players: Object.values(players).filter(p => !p.isBot).map(p => ({
          id: p.id,
          name: p.name,
          balance: p.balance,
          lobbyId: p.lobbyId,
          wins: gameStats.playerStats[p.id]?.wins || 0,
          losses: gameStats.playerStats[p.id]?.losses || 0,
          totalBet: gameStats.playerStats[p.id]?.totalBet || 0,
          totalWon: gameStats.playerStats[p.id]?.totalWon || 0
        }))
      };
      
    case "reset_game":
      Object.values(players).forEach(p => {
        if (!p.isBot) {
          p.balance = START_BALANCE;
          p.bet = 0;
        }
      });
      return { success: true };
      
    case "set_balance":
      if (players[data.userId]) {
        players[data.userId].balance = data.amount;
        broadcastState(players[data.userId].lobbyId);
        return { 
          success: true, 
          newBalance: players[data.userId].balance 
        };
      }
      break;
      
    case "kick_player":
      if (players[data.userId]) {
        // Удаляем из лобби
        const lobby = lobbies[players[data.userId].lobbyId];
        if (lobby) {
          lobby.players = lobby.players.filter(id => id !== data.userId);
        }
        delete players[data.userId];
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
        
        if (isNewPlayer) {
          players[data.id] = {
            id: data.id,
            name: data.name || `Player_${data.id.toString().slice(-4)}`,
            bet: 0,
            balance: START_BALANCE,
            isBot: false,
            ws,
            lobbyId: "bots",
            chanceMultiplier: 0.9 + Math.random() * 0.2,
            isAdmin: isAdmin,
            ready: false
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
        }
        
        ws.send(JSON.stringify({
          type: "init",
          balance: players[data.id].balance,
          isAdmin: players[data.id].isAdmin,
          gameMode: players[data.id].lobbyId,
          playerId: data.id
        }));
        
        broadcastState(players[data.id].lobbyId);
      }
      
      // Выбор режима игры
      if (data.type === "select_mode") {
        const player = players[data.id];
        if (player) {
          // Удаляем из старого лобби
          const oldLobby = lobbies[player.lobbyId];
          if (oldLobby) {
            oldLobby.players = oldLobby.players.filter(id => id !== player.id);
          }
          
          // Добавляем в новое лобби
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
          
          // Проверяем готовность лобби
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
          
          // Уведомление только администраторам
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
  
  // Проверка через Telegram ID из параметра
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
    uptime: process.uptime()
  });
});

// Проверка работоспособности
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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
        <title>Admin Panel - Wheel Game</title>
        <style>
            body { font-family: Arial; padding: 20px; }
            .container { max-width: 800px; margin: 0 auto; }
            .stat { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Wheel Game Backend</h1>
            <p>Status: <strong>Online</strong></p>
            <p>Админ ID: ${adminId}</p>
            <div class="stat">
                <h3>Для управления используйте команды в боте:</h3>
                <p>Админ-панель доступна только через Telegram бота</p>
            </div>
        </div>
    </body>
    </html>
  `);
});

// Корневой маршрут
app.get("/", (req, res) => {
  res.json({
    name: "Telegram Wheel Game Backend",
    version: "1.0.0",
    endpoints: ["/health", "/api/info"],
    websocket: "wss://" + req.get('host')
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
  
  if (process.env.NODE_ENV !== 'production') {
    console.log("\n⚡ Development mode");
    console.log("👥 Bots created:", Object.values(players).filter(p => p.isBot).length);
  }
});
