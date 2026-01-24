import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const START_BALANCE = 1000;
const BOT_COUNT = 3;

let players = {};   // id -> player
let totalBank = 0;
let roundActive = false;

// --------------------
// Создаём ботов
// --------------------
function createBots(){
  for(let i=1;i<=BOT_COUNT;i++){
    const id = "bot_"+i;
    players[id] = {
      id,
      name: "BOT_"+i,
      bet: 0,
      balance: START_BALANCE,
      isBot: true,
      ws: null
    };
  }
}
createBots();

// --------------------
// Вспомогательные функции
// --------------------
function broadcast(data){
  const msg = JSON.stringify(data);
  wss.clients.forEach(client=>{
    if(client.readyState === 1){
      client.send(msg);
    }
  });
}

function broadcastState(){
  const plist = Object.values(players).map(p=>({
    id: p.id,
    name: p.name,
    bet: p.bet,
    balance: p.balance,
    chance: totalBank > 0 
      ? ((p.bet / totalBank) * 100).toFixed(1) 
      : "0.0"
  }));

  broadcast({
    type: "state",
    players: plist,
    totalBank
  });
}

// --------------------
// Боты делают ставки
// --------------------
function botMakeBets(){
  Object.values(players).forEach(p=>{
    if(p.isBot && p.balance > 0){
      const amount = Math.floor(Math.random()*200)+50;
      if(p.balance >= amount){
        p.balance -= amount;
        p.bet += amount;
        totalBank += amount;
      }
    }
  });
}

// --------------------
// Запуск раунда
// --------------------
function startRound(){
  if(roundActive || totalBank === 0) return;

  roundActive = true;

  broadcast({ type:"round_start", time:6 });

  setTimeout(()=>{
    // выбор победителя по весу ставки
    let rand = Math.random() * totalBank;
    let winner = null;

    for(const p of Object.values(players)){
      rand -= p.bet;
      if(rand <= 0){
        winner = p;
        break;
      }
    }

    if(winner){
      winner.balance += totalBank;
    }

    broadcast({
      type:"round_end",
      winnerId: winner.id,
      winnerName: winner.name,
      winAmount: totalBank
    });

    // сброс раунда
    Object.values(players).forEach(p=>p.bet = 0);
    totalBank = 0;
    roundActive = false;

    broadcastState();

  },6000);
}

// --------------------
// WebSocket
// --------------------
wss.on("connection", ws=>{

  ws.on("message", message=>{
    let data;
    try { data = JSON.parse(message); }
    catch(e){ return; }

    // подключение игрока
    if(data.type === "join"){
      if(players[data.id]){
        players[data.id].ws = ws;
      } else {
        players[data.id] = {
          id: data.id,
          name: data.name || "Player",
          bet: 0,
          balance: START_BALANCE,
          isBot: false,
          ws
        };
      }
      broadcastState();
    }

    // ставка
    if(data.type === "bet" && !roundActive){
      const p = players[data.id];
      const amount = Number(data.amount);
      if(p && amount > 0 && p.balance >= amount){
        p.balance -= amount;
        p.bet += amount;
        totalBank += amount;
        broadcastState();
      }
    }

    // старт раунда
    if(data.type === "start" && !roundActive){
      botMakeBets();
      broadcastState();
      startRound();
    }
  });

  ws.on("close", ()=>{
    // отвязываем сокет, но игрока оставляем (для сохранения баланса)
    for(const id in players){
      if(players[id].ws === ws){
        players[id].ws = null;
      }
    }
  });
});

// --------------------
// HTTP (не обязателен, но полезен для Render)
 // --------------------
app.get("/", (req,res)=>{
  res.send("SPINS backend running");
});

// --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>{
  console.log("SPINS backend started on port", PORT);
});
