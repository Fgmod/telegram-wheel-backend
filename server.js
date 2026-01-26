import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Настройки CORS для фронтенда
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

// Настройки игры
const START_BALANCE = 1000;
const MAX_PLAYERS_IN_LOBBY = 6;
const ADMIN_IDS = ["1743237033"]; // Замените на ваш Telegram ID

// Хранилище данных
let players = {};
let totalBank = 0;
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
        lobbyId: "bots"
    };
}

// Инициализация ботов (5 штук)
for (let i = 1; i <= 5; i++) {
    players["bot_" + i] = createBot(i);
}

// Утилиты
function broadcast(data, lobbyId = null) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            const player = Object.values(players).find(p => p.ws === client);
            if (player && (!lobbyId || player.lobbyId === lobbyId)) {
                client.send(JSON.stringify(data));
            }
        }
    });
}

function broadcastState(lobbyId = null) {
    const lobbyPlayers = Object.values(players).filter(p => 
        !lobbyId || p.lobbyId === lobbyId
    );
    
    broadcast({
        type: "state",
        players: lobbyPlayers.map(p => ({
            id: p.id,
            name: p.name,
            bet: p.bet,
            balance: p.balance,
            chance: totalBank > 0 ? ((p.bet / totalBank) * 100 * (p.chanceMultiplier || 1)).toFixed(1) : "0.0",
            isBot: p.isBot,
            isOnline: p.ws !== null,
            lobbyId: p.lobbyId
        })),
        totalBank,
        gameMode,
        lobbyId
    }, lobbyId);
}

// Боты делают ставки
function botMakeBets(lobbyId = "bots") {
    Object.values(players).forEach(p => {
        if (p.isBot && p.balance > 0 && p.lobbyId === lobbyId) {
            const baseBet = Math.min(p.balance * (0.1 + Math.random() * 0.3), 500);
            const amount = Math.floor(baseBet / 10) * 10;
            
            if (p.balance >= amount) {
                p.balance -= amount;
                p.bet += amount;
                totalBank += amount;
                gameStats.totalBets += amount;
            }
        }
    });
}

// Запуск раунда
function startRound(lobbyId) {
    if (roundActive || totalBank === 0) return;
    roundActive = true;
    
    broadcast({ type: "round_start", time: 6 }, lobbyId);
    
    setTimeout(() => {
        const lobbyPlayers = Object.values(players).filter(p => 
            p.bet > 0 && p.lobbyId === lobbyId
        );
        
        if (lobbyPlayers.length === 0) {
            roundActive = false;
            broadcastState(lobbyId);
            return;
        }
        
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
        
        if (winner) {
            winner.balance += totalBank;
            
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
                gameStats.playerStats[winner.id].totalWon += totalBank;
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
        
        broadcast({
            type: "round_end",
            winnerId: winner?.id,
            winnerName: winner?.name,
            winAmount: totalBank,
            stats: gameStats
        }, lobbyId);
        
        // Сброс ставок
        lobbyPlayers.forEach(p => p.bet = 0);
        totalBank = 0;
        roundActive = false;
        
        broadcastState(lobbyId);
        
    }, 6000);
}

// Админ функции
function adminCommand(command, data) {
    switch (command) {
        case "add_balance":
            if (players[data.userId]) {
                players[data.userId].balance += data.amount;
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
            totalBank = 0;
            return { success: true };
            
        case "set_balance":
            if (players[data.userId]) {
                players[data.userId].balance = data.amount;
                return { 
                    success: true, 
                    newBalance: players[data.userId].balance 
                };
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
                        name: data.name || `Player_${data.id.slice(0, 4)}`,
                        bet: 0,
                        balance: START_BALANCE,
                        isBot: false,
                        ws,
                        lobbyId: "bots",
                        chanceMultiplier: 0.9 + Math.random() * 0.2,
                        isAdmin
                    };
                    
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
                    isAdmin,
                    gameMode,
                    playerId: data.id
                }));
                
                broadcastState(players[data.id].lobbyId);
            }
            
            // Выбор режима игры
            if (data.type === "select_mode") {
                const player = players[data.id];
                if (player) {
                    player.lobbyId = data.mode;
                    broadcastState(data.mode);
                }
            }
            
            // Ставка
            if (data.type === "bet" && !roundActive) {
                const player = players[data.id];
                const amount = Number(data.amount);
                
                if (player && amount > 0 && player.balance >= amount) {
                    player.balance -= amount;
                    player.bet += amount;
                    totalBank += amount;
                    gameStats.totalBets += amount;
                    gameStats.playerStats[player.id].totalBet += amount;
                    broadcastState(player.lobbyId);
                }
            }
            
            // Старт раунда
            if (data.type === "start" && !roundActive) {
                const player = players[data.id];
                if (player) {
                    if (player.lobbyId === "bots") {
                        botMakeBets(player.lobbyId);
                    }
                    broadcastState(player.lobbyId);
                    startRound(player.lobbyId);
                }
            }
            
            // Админ команды
            if (data.type === "admin_command") {
                const player = players[data.id];
                if (player && player.isAdmin) {
                    const result = adminCommand(data.command, data.data);
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
                    
                    // Уведомление всех админов
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
                        message: "✅ Ваше сообщение получено. Администратор свяжется с вами в ближайшее время."
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

// REST API для админ-панели
app.post("/admin/api", (req, res) => {
    const { token, command, data } = req.body;
    
    // Простая проверка токена
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1743237033";
    if (token === ADMIN_TOKEN) {
        const result = adminCommand(command, data);
        res.json(result);
    } else {
        res.status(403).json({ error: "Access denied" });
    }
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
                <p>Для управления игрой используйте фронтенд админ-панель</p>
                <div class="stat">
                    <h3>API Endpoints:</h3>
                    <ul>
                        <li><strong>GET /health</strong> - Проверка работоспособности</li>
                        <li><strong>GET /api/info</strong> - Информация о сервере</li>
                        <li><strong>POST /admin/api</strong> - Админ API (требует токен)</li>
                    </ul>
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
        endpoints: ["/health", "/api/info", "/admin"],
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
    console.log(`🔧 Admin API: http://localhost:${PORT}/admin`);
    console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
    
    if (process.env.NODE_ENV !== 'production') {
        console.log("\n⚡ Development mode");
        console.log("👥 Pre-created bots:", Object.values(players).filter(p => p.isBot).length);
    }
});
