import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const START_BALANCE = 1000;
const BOT_COUNT = 3;

let players = {}; 
let totalBank = 0;
let roundActive = false;

// ----- Создание ботов -----
function createBots(){
  for(let i=1;i<=BOT_COUNT;i++){
    const id = "bot_"+i;
    players[id] = {
      id,
      name: "BOT_"+i,
      bet: 0,
      balance: START_BALANCE,
      ws: null,
      isBot:true
    };
  }
}
createBots();

// --------------------------

function broadcast(data){
  wss.clients.forEach(c => c.send(JSON.stringify(data)));
}

function broadcastState(){
  broadcast({
    type:"state",
    players: Object.values(players).map(p=>({
      id:p.id,
      name:p.name,
      bet:p.bet,
      balance:p.balance,
      chance: totalBank>0 ? ((p.bet/totalBank)*100).toFixed(1) : 0
    })),
    totalBank
  });
}

// ----- Бот делает случайную ставку -----
function botMakeBets(){
  Object.values(players).forEach(p=>{
    if(p.isBot && p.balance>0){
      const amount = Math.floor(Math.random()*200)+50;
      if(p.balance>=amount){
        p.balance -= amount;
        p.bet += amount;
        totalBank += amount;
      }
    }
  });
}

// ----- Запуск раунда -----
function startRound(){
  if(roundActive) return;
  if(totalBank===0) return;

  roundActive = true;
  broadcast({type:"round_start", time:6});

  setTimeout(()=>{
    let rand = Math.random() * totalBank;
    let winner;

    for(const p of Object.values(players)){
      rand -= p.bet;
      if(rand<=0){ winner=p; break; }
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

    // сброс ставок
    Object.values(players).forEach(p=>p.bet=0);
    totalBank = 0;
    roundActive = false;
    broadcastState();

  },6000);
}

// ----- WebSocket -----
wss.on("connection", ws=>{
  ws.on("message", msg=>{
    const data = JSON.parse(msg);

    // подключение игрока
    if(data.type==="join"){
      players[data.id] = {
        id:data.id,
        name:data.name,
        bet:0,
        balance: START_BALANCE,
        ws,
        isBot:false
      };
      broadcastState();
    }

    // ставка игрока
    if(data.type==="bet" && !roundActive){
      const p = players[data.id];
      const amount = Number(data.amount);
      if(amount>0 && p.balance>=amount){
        p.balance -= amount;
        p.bet += amount;
        totalBank += amount;
        broadcastState();
      }
    }

    // старт раунда
    if(data.type==="start" && !roundActive){
      botMakeBets();   // боты ставят автоматически
      broadcastState();
      startRound();
    }
  });

  ws.on("close", ()=>{
    for(const id in players){
      if(players[id].ws===ws){
        delete players[id];
      }
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Backend started"));
