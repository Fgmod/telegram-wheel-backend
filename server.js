import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let players = [];
let roundActive = false;

wss.on("connection", ws => {

  ws.on("message", msg => {
    const data = JSON.parse(msg);

    if(data.type === "join"){
      if(!players.find(p=>p.id===data.id)){
        players.push({id:data.id, name:data.name, ws});
      }
      broadcastPlayers();
    }

    if(data.type === "start" && !roundActive){
      startRound();
    }
  });

  ws.on("close", ()=>{
    players = players.filter(p=>p.ws!==ws);
    broadcastPlayers();
  });
});

function broadcastPlayers(){
  broadcast({
    type:"players",
    players: players.map(p=>({id:p.id, name:p.name}))
  });
}

function broadcast(data){
  wss.clients.forEach(c=>{
    c.send(JSON.stringify(data));
  });
}

function startRound(){
  if(players.length === 0) return;
  roundActive = true;

  broadcast({type:"round_start", time:5});

  setTimeout(()=>{
    const winner = players[Math.floor(Math.random()*players.length)];
    broadcast({
      type:"round_end",
      winnerId: winner.id,
      winnerName: winner.name
    });
    roundActive = false;
  },5000);
}

app.get("/", (req,res)=>{
  res.send("Wheel backend running");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Backend started on "+PORT));
