/**
 * ============================================================================
 * Aethelgard Chronicles: Sovereign of the Rift
 * Dedicated Multiplayer Game Server & RESTful API (server.js)
 * ============================================================================
 * วิธีรันเซิร์ฟเวอร์บนเครื่องของคุณ (Local / Production VPS):
 * 1. ติดตั้งไลบรารี: npm install
 * 2. เริ่มรันเซิร์ฟเวอร์: npm start (หรือ node server.js)
 * 3. เซิร์ฟเวอร์จะเปิดทั้งหน้าเว็บเกม, REST API และ WebSocket ที่พอร์ต 4000:
 *    - เข้าเล่นเกมผ่านเซิร์ฟเวอร์: http://localhost:4000
 *    - WebSocket Endpoint:      ws://localhost:4000
 *    - REST API Status:         http://localhost:4000/api/status
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4000;
const DB_FILE = path.join(__dirname, 'aethelgard_db.json');

// ค้นหาหมายเลข IP IPv4 ของเครื่องในวงแลน / Wi-Fi เพื่อให้เพื่อนในเครือข่ายเข้าเล่นได้
function getLocalIpv4Addresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    return addresses;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// เสิร์ฟไฟล์หน้าเว็บเกม (index.html) จากโฟลเดอร์เดียวกันได้ทันที
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==================== PERSISTENT DATABASE & WORLD STATE ====================
let persistentDB = {
    characters: {},   // uid -> ข้อมูลเซฟตัวละครทั้งหมด (เลเวล, ทอง, อาวุธ, สเตตัส)
    leaderboard: {},  // uid -> ข้อมูลจัดอันดับพลังรบสูงสุด
    chatHistory: []   // ประวัติแชทโลก 50 ข้อความล่าสุด
};

// โหลดข้อมูลจากไฟล์ JSON หากเคยมีเซฟไว้บนเซิร์ฟเวอร์
function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            persistentDB = {
                characters: parsed.characters || {},
                leaderboard: parsed.leaderboard || {},
                chatHistory: parsed.chatHistory || []
            };
            console.log(`[DB] โหลดฐานข้อมูลสำเร็จ: ผู้เล่นสะสม ${Object.keys(persistentDB.characters).length} คน`);
        }
    } catch (err) {
        console.error('[DB] ไม่สามารถโหลดไฟล์ฐานข้อมูลได้:', err.message);
    }
}

// บันทึกฐานข้อมูลลงดิสก์อัตโนมัติ
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(persistentDB, null, 2), 'utf8');
    } catch (err) {
        console.error('[DB] บันทึกฐานข้อมูลล้มเหลว:', err.message);
    }
}

loadDatabase();
setInterval(saveDatabase, 15000); // Auto-save ลงดิสก์ทุก 15 วินาที

// สถานะผู้เล่นที่กำลังออนไลน์แบบ Real-time ในหน่วยความจำ
const activePlayers = new Map(); // uid -> { ws, state, lastSeen }

// สถานะบอสโลกและบอสเรด (Co-op Shared HP สำหรับตีบอสพร้อมกันทั้งเซิร์ฟเวอร์)
const worldBosses = {
    treant_boss: {
        id: 'treant_boss',
        name: 'ราชันย์พฤกษาต้องสาป มาลาคอร์',
        zone: 'forest',
        lv: 15,
        hp: 42000,
        maxHp: 42000,
        atk: 88,
        x: 68,
        z: 0,
        alive: true,
        respawnAt: 0
    },
    anubis_boss: {
        id: 'anubis_boss',
        name: 'จักรพรรดิสุสานทราย อานูบิส-เว็กซ์',
        zone: 'desert',
        lv: 30,
        hp: 95000,
        maxHp: 95000,
        atk: 155,
        x: 0,
        z: 68,
        alive: true,
        respawnAt: 0
    },
    frost_dragon: {
        id: 'frost_dragon',
        name: 'พญามังกรเหมันต์ ฟรอสต์วิง',
        zone: 'meadow',
        lv: 45,
        hp: 165000,
        maxHp: 165000,
        atk: 240,
        x: 0,
        z: -65,
        alive: true,
        respawnAt: 0
    },
    igneous_boss: {
        id: 'igneous_boss',
        name: 'มังกรเพลิงบรรพกาล IGNEOUS',
        zone: 'volcano',
        lv: 60,
        hp: 280000,
        maxHp: 280000,
        atk: 360,
        x: -68,
        z: 0,
        alive: true,
        respawnAt: 0
    }
};

// ==================== REST API ENDPOINTS ====================

/**
 * GET /api/status
 * ตรวจสอบสถานะเซิร์ฟเวอร์ จำนวนผู้เล่นออนไลน์ และเลือดบอสโลกทั้งหมด
 */
app.get('/api/status', (req, res) => {
    const lanIps = getLocalIpv4Addresses();
    res.json({
        status: 'online',
        realm: 'Aethelgard Sovereign Dedicated Server',
        onlineCount: activePlayers.size,
        totalRegistered: Object.keys(persistentDB.characters).length,
        lanIps,
        lanUrls: lanIps.map(ip => `http://${ip}:${PORT}`),
        wsUrls: lanIps.map(ip => `ws://${ip}:${PORT}`),
        worldBosses,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: Date.now()
    });
});

/**
 * GET /api/players
 * ดึงรายชื่อและพิกัด 3D ของผู้เล่นทั้งหมดที่กำลังออนไลน์อยู่ในแมพ
 */
app.get('/api/players', (req, res) => {
    const list = [];
    activePlayers.forEach((val) => {
        list.push(val.state);
    });
    res.json({ count: list.length, players: list });
});

/**
 * GET /api/leaderboard
 * ดึงอันดับผู้เล่นที่มีค่าพลังโจมตีรวม (Combat Power) สูงสุด 20 อันดับแรก
 */
app.get('/api/leaderboard', (req, res) => {
    const topPlayers = Object.values(persistentDB.leaderboard)
        .sort((a, b) => (b.atk || 0) - (a.atk || 0))
        .slice(0, 20);
    res.json({ leaderboard: topPlayers });
});

/**
 * POST /api/character/sync
 * บันทึกข้อมูลตัวละครและอัปเดตอันดับ Leaderboard
 */
app.post('/api/character/sync', (req, res) => {
    const data = req.body;
    if (!data || !data.uid) {
        return res.status(400).json({ error: 'Missing required field: uid' });
    }

    const now = Date.now();
    // บันทึกข้อมูลตัวละครลงฐานข้อมูล
    persistentDB.characters[data.uid] = {
        ...persistentDB.characters[data.uid],
        ...data,
        updatedAt: now
    };

    // อัปเดตตารางจัดอันดับโลก
    persistentDB.leaderboard[data.uid] = {
        uid: data.uid,
        name: String(data.name || 'โซเวอเรน').slice(0, 24),
        className: data.className || 'warrior',
        level: Number(data.level) || 1,
        atk: Number(data.atk) || 50,
        weaponName: data.weaponName || 'ศาสตราเริ่มต้น',
        updatedAt: now
    };

    saveDatabase();
    res.json({
        success: true,
        message: 'ซิงค์ข้อมูลตัวละครและจัดอันดับสำเร็จ',
        syncedAt: now
    });
});

/**
 * GET /api/character/:uid
 * โหลดข้อมูลตัวละครจากเซิร์ฟเวอร์ด้วย UID
 */
app.get('/api/character/:uid', (req, res) => {
    const uid = req.params.uid;
    const charData = persistentDB.characters[uid];
    if (!charData) {
        return res.status(404).json({ error: 'Character not found' });
    }
    res.json({ character: charData });
});

/**
 * POST /api/boss/damage
 * โจมตีบอสโลกผ่าน REST API (รองรับทั้ง REST และ WebSocket)
 */
app.post('/api/boss/damage', (req, res) => {
    const { bossId = 'igneous_boss', damage = 0, attackerName = 'ผู้กล้า' } = req.body;
    const boss = worldBosses[bossId];
    if (!boss) {
        return res.status(404).json({ error: 'Boss not found' });
    }

    applyBossDamage(bossId, Number(damage) || 0, attackerName);
    res.json({ success: true, boss });
});

// ==================== WEBSOCKET REAL-TIME ENGINE ====================

function broadcastAll(payload, excludeWs = null) {
    const raw = JSON.stringify(payload);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === 1) {
            client.send(raw);
        }
    });
}

function applyBossDamage(bossId, dmg, attackerName) {
    const boss = worldBosses[bossId] || worldBosses.igneous_boss;
    if (!boss.alive || dmg <= 0) return;

    boss.hp = Math.max(0, boss.hp - dmg);
    if (boss.hp === 0) {
        boss.alive = false;
        boss.respawnAt = Date.now() + 25000; // เกิดใหม่ใน 25 วินาที

        // ประกาศข่าวการสังหารบอสไปทั่วทั้งเซิร์ฟเวอร์
        const sysMsg = {
            uid: 'SYSTEM',
            sender: 'ประกาศแห่งเอเธลการ์ด',
            className: 'warrior',
            text: `ผู้พิชิต [${attackerName}] ได้สังหารราชันย์บอส ${boss.name} ลงสำเร็จ!`,
            time: Date.now()
        };
        persistentDB.chatHistory.push(sysMsg);
        broadcastAll({ type: 'CHAT_BROADCAST', message: sysMsg });
    }

    broadcastAll({
        type: 'WORLD_BOSS_SYNC',
        worldBoss: boss,
        allBosses: worldBosses
    });
}

wss.on('connection', (ws) => {
    let playerUid = null;

    // ส่งข้อมูลต้อนรับ: รายชื่อผู้เล่นทั้งหมดในแมพ + ประวัติแชท + สถานะบอสโลก
    const snapshotPlayers = [];
    activePlayers.forEach((val) => snapshotPlayers.push(val.state));

    ws.send(JSON.stringify({
        type: 'WELCOME_SNAPSHOT',
        players: snapshotPlayers,
        chatHistory: persistentDB.chatHistory.slice(-20),
        worldBosses,
        serverTime: Date.now()
    }));

    ws.on('message', (rawMessage) => {
        try {
            const data = JSON.parse(rawMessage);

            // 1. ซิงค์พิกัดตัวละคร 3D, การหมุนตัว, มังกรขี่ และการใช้สกิล
            if (data.type === 'PLAYER_STATE' && data.uid) {
                playerUid = String(data.uid);
                const cleanState = {
                    uid: playerUid,
                    name: String(data.name || 'ผู้กล้า').slice(0, 20),
                    className: data.className || 'warrior',
                    level: Number(data.level) || 1,
                    atk: Number(data.atk) || 60,
                    hp: Number(data.hp) || 100,
                    maxHp: Number(data.maxHp) || 100,
                    weaponName: data.weaponName || 'ศาสตราผู้พิชิต',
                    x: Number(data.x) || 0,
                    z: Number(data.z) || 8,
                    rotY: Number(data.rotY) || 0,
                    dragonMounted: Boolean(data.dragonMounted),
                    attackSeq: Number(data.attackSeq) || 0,
                    updatedAt: Date.now()
                };

                activePlayers.set(playerUid, {
                    ws,
                    state: cleanState,
                    lastSeen: Date.now()
                });

                // อัปเดต Leaderboard อัตโนมัติ
                persistentDB.leaderboard[playerUid] = {
                    uid: playerUid,
                    name: cleanState.name,
                    className: cleanState.className,
                    level: cleanState.level,
                    atk: cleanState.atk,
                    weaponName: cleanState.weaponName,
                    updatedAt: Date.now()
                };

                // กระจายพิกัดให้ผู้เล่นคนอื่นในแมพทันที
                broadcastAll({
                    type: 'REMOTE_PLAYER_UPDATE',
                    player: cleanState
                }, ws);
            }

            // 2. ซิงค์การใช้สกิลพิเศษ (Skill Cast Broadcast)
            if (data.type === 'SKILL_CAST' && data.uid) {
                broadcastAll({
                    type: 'REMOTE_SKILL_VFX',
                    uid: data.uid,
                    slotIndex: data.slotIndex,
                    className: data.className,
                    x: data.x,
                    z: data.z
                }, ws);
            }

            // 3. ซิงค์ดาเมจตีบอสโลกแบบ Co-op
            if (data.type === 'BOSS_DAMAGE') {
                applyBossDamage(
                    data.bossId || 'igneous_boss',
                    Number(data.damage) || 0,
                    data.attackerName || 'ผู้พิชิต'
                );
            }

            // 4. ระบบแชทโลก (World Realm Chat)
            if (data.type === 'CHAT_MSG' && data.text) {
                const msgObj = {
                    uid: data.uid || playerUid || 'anon',
                    sender: String(data.sender || 'ผู้กล้า').slice(0, 20),
                    className: data.className || 'warrior',
                    text: String(data.text).trim().slice(0, 120),
                    time: Date.now()
                };
                persistentDB.chatHistory.push(msgObj);
                if (persistentDB.chatHistory.length > 50) {
                    persistentDB.chatHistory.shift();
                }
                broadcastAll({
                    type: 'CHAT_BROADCAST',
                    message: msgObj
                });
            }

            // 5. เช็คค่า Ping (Latency Check)
            if (data.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG', clientTime: data.clientTime, serverTime: Date.now() }));
            }
        } catch (err) {
            console.error('[WS Packet Error]:', err.message);
        }
    });

    ws.on('close', () => {
        if (playerUid && activePlayers.has(playerUid)) {
            activePlayers.delete(playerUid);
            broadcastAll({
                type: 'PLAYER_LEFT',
                uid: playerUid
            });
        }
    });
});

// ==================== SERVER TICK LOOP (BOSS RESPAWN & CLEANUP) ====================
setInterval(() => {
    const now = Date.now();

    // 1. ล้างผู้เล่นที่ขาดการเชื่อมต่อเกิน 45 วินาที
    activePlayers.forEach((val, uid) => {
        if (now - val.lastSeen > 45000) {
            activePlayers.delete(uid);
            broadcastAll({ type: 'PLAYER_LEFT', uid });
        }
    });

    // 2. ตรวจสอบการเกิดใหม่ของราชันย์บอส
    Object.values(worldBosses).forEach((boss) => {
        if (!boss.alive && now >= boss.respawnAt) {
            boss.alive = true;
            boss.hp = boss.maxHp;
            broadcastAll({
                type: 'WORLD_BOSS_SYNC',
                worldBoss: boss,
                allBosses: worldBosses
            });
        }
    });
}, 5000);

// เริ่มต้นรัน HTTP + WebSocket Server (รับทั้ง Localhost และ LAN)
server.listen(PORT, '0.0.0.0', () => {
    const lanIps = getLocalIpv4Addresses();
    console.log('====================================================================');
    console.log(`⚔️  Aethelgard Chronicles — Dedicated Multiplayer Server Online!`);
    console.log(`🌐 Local Web Client:  http://localhost:${PORT}`);
    if (lanIps.length > 0) {
        lanIps.forEach(ip => {
            console.log(`🌐 LAN / Wi-Fi Client: http://${ip}:${PORT}  (แชร์ให้เพื่อนในวงแลนเล่นด้วยกัน)`);
        });
    }
    console.log(`🔌 WebSocket Server:  ws://localhost:${PORT}`);
    console.log(`📡 REST API Status:   http://localhost:${PORT}/api/status`);
    console.log('====================================================================');
});