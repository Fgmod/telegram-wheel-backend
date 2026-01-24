import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const START_BALANCE = 1000;
const BOT_COUNT = 3;

let players = {};   // id -> player object
let totalBank = 0;
let roundActive = false;

// ---- создаём ботов один раз ----
function createBots(){
  for(let i=1;i<=BOT_COUNT;i++){
    const id = "bot_"+i;
    players[id] = {
      id,
      name: "BOT_"+i,
      bet:0,
      balance: START_BALANCE,
      isBot:true,
      ws:null
    };
  }
}
createBots();

// ---- utils ----
function broadcast(data){
  wss.clients.forEach(c=>{
    c.send(JSON.stringify(data));
  });
}

function broadcastState(){
  broadcast({
    type:"state",
    players: Object.values(players).map(p=>({
      id:p.id,
      name:p.name,
      bet:p.bet,
      balance:p.balance,
      chance: totalBank>0 ? ((p.bet/totalBank)*100).toFixed(1) : "0.0"
    })),
    totalBank
  });
}

// ---- боты делают ставки ----
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

// ---- запуск раунда ----
function startRound(){
  if(roundActive || totalBank===0) return;
  roundActive = true;

  broadcast({type:"round_start", time:6});

  setTimeout(()=>{
    // weighted random
    let rand = Math.random() * totalBank;
    let winner;

    for(const p of Object.values(players)){
      rand -= p.bet;
      if(rand<=0){ winner = p; break; }
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
    Object.values(players).forEach(p=> p.bet = 0);
    totalBank = 0;
    roundActive = false;
    broadcastState();

  },6000);
}

// ---- websocket ----
wss.on("connection", ws=>{
  ws.on("message", msg=>{
    const data = JSON.parse(msg);

    // подключение пользователя
    if(data.type==="join"){
      // если игрок уже есть — просто привязываем сокет
      if(players[data.id]){
        players[data.id].ws = ws;
      } else {
        players[data.id] = {
          id:data.id,
          name:data.name,
          bet:0,
          balance: START_BALANCE,
          isBot:false,
          ws
        };
      }
      broadcastState();
    }

    // ставка
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

    // старт
    if(data.type==="start" && !roundActive){
      botMakeBets();
      broadcastState();
      startRound();
    }

    // запрос возврата в лобби
    if(data.type==="back_to_lobby"){
      ws.send(JSON.stringify({type:"back_ack"}));
    }
  });

  ws.on("close", ()=>{
    for(const id in players){
      if(players[id].ws === ws){
        players[id].ws = null;
      }
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Backend started"));
