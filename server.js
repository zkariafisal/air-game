/* ============================================================
   خادم حرب الطائرات — اللعب الجماعي (لاعبان)
   التشغيل:  npm install && node server.js
   ============================================================ */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript',
  '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.json':'application/json'
};

/* -------- ملفات ثابتة + الصور -------- */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, 'public', p.replace(/\.\./g, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

/* -------- WebSocket -------- */
const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextPid = 1;

const W = 480, H = 854;
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const bcast = (room, o) => {
  const s = JSON.stringify(o);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
};
const bcastExcept = (room, exceptId, o) => {
  const s = JSON.stringify(o);
  for (const p of room.players.values())
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s);
};

function newCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({length:5}, () => C[Math.floor(Math.random()*C.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function makeRoom(code) {
  return {
    code, players: new Map(), hostId: null, state: 'lobby',
    levelIndex: 0, enemies: [], ebullets: [], nextEid: 1, nextBid: 1,
    time: 0, duration: 30, bossSpawned: false, bossDone: false,
    spawnTimer: 1.2, timer: null, last: 0, snapAcc: 0
  };
}

function spawnEnemy(room) {
  const idx = room.levelIndex;
  const world = Math.floor(idx/20)+1, level = idx%20+1;
  const diff = 1 + idx*0.022;
  const pattern = (level + world) % 5;
  const roll = Math.random();
  const type = roll < Math.min(.48, .08 + diff*.065 + (pattern===2?.12:0)) ? 'tank'
             : roll < (.52 + (pattern===1?.18:0)) ? 'zig' : 'grunt';
  const r  = type==='tank' ? 25 : 19;
  const hp = type==='tank' ? Math.ceil(4 + diff*2.2)
           : type==='zig'  ? Math.ceil(1 + diff*.8)
           : Math.ceil(diff*.48);
  room.enemies.push({
    id: room.nextEid++, type, x: 40 + Math.random()*(W-80), y: -55, r, hp, max: hp,
    vy: (type==='tank'?75:125) + Math.min(210, diff*17) + (pattern===3?35:0),
    fire: 1 + Math.random()*1.5, t: 0, dir: 1
  });
}

function spawnBoss(room) {
  const idx = room.levelIndex, world = Math.floor(idx/20)+1, level = idx%20+1;
  const hp = Math.ceil(38 + idx*2.4 + level*3.5);
  room.enemies.push({
    id: room.nextEid++, type:'boss', x:W/2, y:-110, r:62, hp, max:hp,
    vy:0, fire:1.5, t:0, dir:1, enter:true
  });
  room.bossSpawned = true;
  bcast(room, { t:'boss' });
}

function nearestPlayer(room, x, y) {
  let best = null, d = Infinity;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const z = (p.x-x)**2 + (p.y-y)**2;
    if (z < d) { d = z; best = p; }
  }
  return best;
}

function aimed(room, x, y, tgt, sp = 235) {
  const dx = tgt.x-x, dy = tgt.y-y, L = Math.hypot(dx,dy) || 1;
  room.ebullets.push({ id: room.nextBid++, x, y, vx: dx/L*sp, vy: dy/L*sp, r: 7 });
}

/* ★ معدل اللقطة 20 مرة/ثانية (بدل 30) لتقليل الحِمل */
const SNAPSHOT_INTERVAL = 0.050;

function tickRoom(room) {
  if (room.state !== 'playing') return;
  const now = Date.now();
  const ds = Math.min(0.1, (now - room.last)/1000);
  room.last = now;
  room.time += ds;

  if (!room.bossSpawned && room.time >= room.duration) spawnBoss(room);

  if (!room.bossSpawned) {
    room.spawnTimer -= ds;
    if (room.spawnTimer <= 0) {
      spawnEnemy(room);
      const level = room.levelIndex % 20 + 1;
      room.spawnTimer = Math.max(.25, 1.12 - room.levelIndex*.0021 - (level%5)*.045) * (.7 + Math.random()*.6);
    }
  }

  for (const e of room.enemies) {
    e.t += ds;
    if (e.type === 'boss') {
      if (e.enter) { e.y += 95*ds; if (e.y >= 132) { e.y = 132; e.enter = false; } }
      else {
        e.x += e.dir * (80 + Math.floor(room.levelIndex/20)*9) * ds;
        if (e.x < 75 || e.x > W-75) e.dir *= -1;
        e.fire -= ds;
        if (e.fire <= 0) {
          e.fire = Math.max(.65, 1.6 - Math.floor(room.levelIndex/20)*.08);
          for (let j = 0; j < 7; j++) {
            const a = Math.PI * (.1 + j*.8/6);
            room.ebullets.push({ id: room.nextBid++, x: e.x, y: e.y+35,
              vx: Math.cos(a)*220, vy: Math.sin(a)*220, r: 7 });
          }
        }
      }
    } else {
      e.y += e.vy * ds;
      if (e.type === 'zig') e.x = Math.max(25, Math.min(W-25, e.x + Math.sin(e.t*5)*150*ds));
      if (e.type === 'tank' && e.y > 20) {
        e.fire -= ds;
        if (e.fire <= 0) {
          e.fire = 1.5;
          const t = nearestPlayer(room, e.x, e.y);
          if (t) aimed(room, e.x, e.y, t);
        }
      }
    }
  }
  room.enemies = room.enemies.filter(e => e.y < H+80);

  for (const b of room.ebullets) { b.x += b.vx*ds; b.y += b.vy*ds; }
  room.ebullets = room.ebullets.filter(b => b.y > -60 && b.y < H+60 && b.x > -60 && b.x < W+60);

  for (const p of room.players.values()) {
    if (!p.alive && p.respawnAt && now >= p.respawnAt) {
      p.alive = true; p.hp = p.maxHp; p.x = W/2; p.y = H-155;
      bcast(room, { t:'hp', id:p.id, hp:p.hp, alive:true });
    }
  }

  room.snapAcc += ds;
  if (room.snapAcc >= SNAPSHOT_INTERVAL) {
    room.snapAcc = 0;
    bcast(room, {
      t:'S',
      time: Math.round(room.time*10)/10,
      enemies: room.enemies.map(e => [e.id, e.type, Math.round(e.x), Math.round(e.y), Math.ceil(e.hp), e.max, e.r]),
      eb: room.ebullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]),
      players: [...room.players.values()].map(p =>
        [p.id, Math.round(p.x), Math.round(p.y), p.hp, p.alive ? 1 : 0, p.name])
    });
  }
}

function startRoom(room, levelIndex) {
  const world = Math.floor(levelIndex/20)+1, level = levelIndex%20+1;
  room.state = 'playing';
  room.levelIndex = levelIndex;
  room.duration = 24 + level*1.1 + Math.floor(levelIndex/40)*2;
  room.time = 0; room.enemies = []; room.ebullets = [];
  room.nextEid = 1; room.nextBid = 1;
  room.bossSpawned = false; room.bossDone = false; room.spawnTimer = 1.2;
  room.snapAcc = 0; room.last = Date.now();
  for (const p of room.players.values()) {
    p.maxHp = 3; p.hp = 3; p.alive = true; p.x = W/2; p.y = H-155; p.lastHurt = 0;
  }
  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => tickRoom(room), 33);
  bcast(room, { t:'start', levelIndex });
}

/* -------- الاتصالات -------- */
wss.on('connection', ws => {
  const pid = 'p' + (nextPid++);
  let room = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create') {
      const code = newCode();
      room = makeRoom(code);
      rooms.set(code, room);
      join(room, ws, pid, m.name);
      return;
    }
    if (m.t === 'join') {
      const r = rooms.get(String(m.code||'').toUpperCase());
      if (!r) return send(ws, { t:'err', msg:'الغرفة غير موجودة ❌' });
      if (r.players.size >= 2) return send(ws, { t:'err', msg:'الغرفة ممتلئة' });
      room = r;
      join(room, ws, pid, m.name);
      return;
    }
    if (!room) return;

    if (m.t === 'start' && room.hostId === pid) {
      startRoom(room, Math.max(0, Math.min(399, m.level|0)));
    }
    else if (m.t === 'restart' && room.hostId === pid) {
      startRoom(room, room.levelIndex);
    }
    /* ★ رسالة 'p' المدمجة: موقع + طلقات في وقت واحد */
    else if (m.t === 'p') {
      const p = room.players.get(pid);
      if (p) { p.x = Math.max(0, Math.min(W, m.x)); p.y = Math.max(0, Math.min(H, m.y)); }

      if (m.shoot && Array.isArray(m.shoot) && m.shoot.length) {
        /* حد أمان: لا نمرر أكثر من 60 طلقة في رسالة واحدة */
        const arr = m.shoot.length > 60 ? m.shoot.slice(-60) : m.shoot;
        bcastExcept(room, pid, { t:'shoot', owner: pid, bullets: arr });
      }
    }
    else if (m.t === 'hit') {
      const e = room.enemies.find(v => v.id === m.id);
      if (!e) return;
      e.hp -= Math.max(.1, Math.min(50, m.dmg));
      if (e.hp <= 0) {
        room.enemies = room.enemies.filter(v => v !== e);
        bcast(room, { t:'kill', id:e.id, type:e.type, x:Math.round(e.x), y:Math.round(e.y) });
        if (e.type === 'boss') {
          room.bossDone = true; room.state = 'over';
          if (room.timer) clearInterval(room.timer);
          bcast(room, { t:'over', win:true });
        }
      }
    }
    else if (m.t === 'hurt') {
      const p = room.players.get(pid);
      if (!p || !p.alive) return;
      const now = Date.now();
      if (now - (p.lastHurt||0) < 700) return;
      p.lastHurt = now;
      p.hp--;
      if (p.hp <= 0) {
        p.hp = 0; p.alive = false; p.respawnAt = now + 6000;
        bcast(room, { t:'hp', id:p.id, hp:0, alive:false });
      } else {
        bcast(room, { t:'hp', id:p.id, hp:p.hp, alive:true });
      }
    }
    /* WebRTC signaling (صوت) */
    else if (m.t === 'rtc-desc' || m.t === 'rtc-ice') {
      bcastExcept(room, pid, m);
    }
    else if (m.t === 'leave') ws.close();
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(pid);
    bcast(room, { t:'left', id:pid });
    if (room.players.size === 0) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === pid) room.hostId = room.players.keys().next().value;
    const list = [...room.players.values()].map(pl => ({ id:pl.id, name:pl.name }));
    bcast(room, { t:'lobby', players: list, host: room.hostId });
  });
});

function join(room, ws, pid, name) {
  const p = {
    id: pid, ws, name: (name || 'لاعب').slice(0, 12),
    x: W/2, y: H-155, hp: 3, maxHp: 3, alive: true, lastHurt: 0, respawnAt: 0
  };
  room.players.set(pid, p);
  if (!room.hostId) room.hostId = pid;

  const list = [...room.players.values()].map(pl => ({ id:pl.id, name:pl.name }));
  send(ws, { t:'joined', code: room.code, id: pid, hostId: room.hostId, players: list });
  bcast(room, { t:'lobby', players: list, host: room.hostId });
}

server.listen(PORT, () => console.log(`✅ الخادم يعمل: http://localhost:${PORT}`));
