import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let players = {}; // id -> {name, bet, ws, balance}
let roundActive = false;
let totalBank = 0;

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
      chance: totalBank>0 ? ((p.bet/totalBank)*100).toFixed(1) : 0,
      balance:p.balance
    })),
    totalBank
  });
}

wss.on("connection", ws=>{
  ws.on("message", msg=>{
    const data = JSON.parse(msg);

    // регистрация
    if(data.type==="join"){
      if(!players[data.id]){
        players[data.id] = {
          id:data.id,
          name:data.name,
          bet:0,
          balance:1000, // стартовый баланс
          ws
        };
      }
      broadcastState();
    }

    // ставка
    if(data.type==="bet" && !roundActive){
      const p = players[data.id];
      const amount = Number(data.amount);
      if(p.balance >= amount && amount>0){
        p.balance -= amount;
        p.bet += amount;
        totalBank += amount;
        broadcastState();
      }
    }

    // запуск раунда
    if(data.type==="start" && !roundActive){
      if(totalBank>0) startRound();
    }
  });

  ws.on("close", ()=>{
    for(const id in players){
      if(players[id].ws === ws) delete players[id];
    }
    broadcastState();
  });
});

function startRound(){
  roundActive = true;
  broadcast({type:"round_start", time:5});

  setTimeout(()=>{
    // выбор победителя по весу ставок
    let rand = Math.random() * totalBank;
    let winner;

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
      winnerId: winner?.id,
      winnerName: winner?.name,
      winAmount: totalBank
    });

    // сброс
    for(const p of Object.values(players)) p.bet = 0;
    totalBank = 0;
    roundActive = false;
    broadcastState();

  },5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Backend running"));
