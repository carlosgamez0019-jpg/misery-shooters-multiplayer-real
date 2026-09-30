const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const players = new Map();
const rooms = new Map();

let nextId = 1;

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data, except = null) {
    const message = JSON.stringify(data);

    for (const client of wss.clients) {
        if (client !== except && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function getPlayers(roomCode = null) {
    if (!roomCode) return [...players.values()];

    return [...players.values()].filter(
        player => player.room === roomCode
    );
}

function generateRoomCode() {
    let code;

    do {
        code = Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase();
    } while (rooms.has(code));

    return code;
}

wss.on("connection", (ws) => {
    const id = String(nextId++);

    const player = {
        id,
        room: null,
        x: 0,
        y: 1.65,
        z: 2,
        yaw: 0,
        pitch: 0,
        team: "blue",
        hp: 100,
        kills: 0,
        deaths: 0
    };

    players.set(id, player);
    ws.playerId = id;
    ws.room = null;

    console.log(`Player ${id} connected (${player.team})`);

    send(ws, {
        type: "welcome",
        id,
        player,
        players: getPlayers()
    });

    broadcast({
        type: "playerJoined",
        player
    }, ws);

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }

        const p = players.get(id);
        if (!p) return;

        switch (data.type) {

            case "createRoom": {
                if (p.room) {
                    send(ws, {
                        type: "roomError",
                        message: "You are already in a room."
                    });
                    break;
                }

                const roomCode = generateRoomCode();

                rooms.set(roomCode, {
                    hostId: id,
                    players: new Set([id]),
                    started: false
                });

                p.team = "blue";

                p.room = roomCode;
                ws.room = roomCode;

                send(ws, {
                    type: "roomCreated",
                    room: roomCode,
                    players: getPlayers(roomCode)
                });

                console.log(`Room ${roomCode} created by Player ${id}`);
                break;
            }

            case "joinRoom": {
                const roomCode = String(data.room || "")
                    .trim()
                    .toUpperCase();

                const room = rooms.get(roomCode);

                if (!room) {
                    send(ws, {
                        type: "roomError",
                        message: "ROOM NOT FOUND."
                    });
                    break;
                }

                if (room.players.size >= 4) {
                    send(ws, {
                        type: "roomError",
                        message: "ROOM IS FULL."
                    });
                    break;
                }

                if (room.started) {
                    send(ws, {
                        type: "roomError",
                        message: "MATCH ALREADY STARTED."
                    });
                    break;
                }

                if (p.room) {
                    send(ws, {
                        type: "roomError",
                        message: "You are already in a room."
                    });
                    break;
                }

                const blueCount = [...room.players]
                    .map(pid => players.get(pid))
                    .filter(
                        player =>
                            player &&
                            player.team === "blue"
                    ).length;

                const redCount = [...room.players]
                    .map(pid => players.get(pid))
                    .filter(
                        player =>
                            player &&
                            player.team === "red"
                    ).length;

                p.team = redCount < blueCount ? "red" : "blue";

                if (blueCount === redCount) {
                    p.team = "red";
                }

                p.room = roomCode;
                ws.room = roomCode;

                room.players.add(id);

                send(ws, {
                    type: "roomJoined",
                    room: roomCode,
                    players: getPlayers(roomCode)
                });

                for (const otherId of room.players) {
                    if (otherId === id) continue;

                    for (const client of wss.clients) {
                        if (client.playerId === otherId) {
                            send(client, {
                                type: "playerJoinedRoom",
                                player: p
                            });
                        }
                    }
                }

                console.log(
                    `Player ${id} joined room ${roomCode}`
                );

                break;
            }

            case "startPrivateMatch": {
                if (!p.room) {
                    send(ws, {
                        type: "roomError",
                        message: "You are not in a private lobby."
                    });
                    break;
                }

                const room = rooms.get(p.room);

                if (!room) {
                    send(ws, {
                        type: "roomError",
                        message: "ROOM NOT FOUND."
                    });
                    break;
                }

                if (room.hostId !== id) {
                    send(ws, {
                        type: "roomError",
                        message:
                            "ONLY THE HOST CAN START THE MATCH."
                    });
                    break;
                }

                room.started = true;

                for (const client of wss.clients) {
                    if (
                        client.room === p.room &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        send(client, {
                            type: "roomStarted",
                            room: p.room,
                            hostId: room.hostId,
                            players: getPlayers(p.room)
                        });
                    }
                }

                console.log(
                    `Room ${p.room} started by Player ${id}`
                );

                break;
            }

            case "state": {
                console.log(
                    `Player ${id} state: x=${data.x}, z=${data.z}`
                );

                if (Number.isFinite(data.x))
                    p.x = data.x;

                if (Number.isFinite(data.y))
                    p.y = data.y;

                if (Number.isFinite(data.z))
                    p.z = data.z;

                if (Number.isFinite(data.yaw))
                    p.yaw = data.yaw;

                if (Number.isFinite(data.pitch))
                    p.pitch = data.pitch;

                broadcast({
                    type: "playerState",
                    player: p
                }, ws);

                break;
            }

            case "shoot": {
                broadcast({
                    type: "playerShot",
                    id,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    yaw: p.yaw,
                    pitch: p.pitch,
                    weapon: data.weapon || "rifle"
                }, ws);

                break;
            }

            case "hit": {
                if (typeof data.targetId === "string") {

                    const target = players.get(
                        data.targetId
                    );

                    if (
                        target &&
                        target.id !== id
                    ) {

                        const damage = Math.max(
                            0,
                            Math.min(
                                100,
                                Number(data.damage) || 0
                            )
                        );

                        target.hp -= damage;

                        if (target.hp <= 0) {

                            target.hp = 100;

                            p.kills++;
                            target.deaths++;

                            send(ws, {
                                type: "killConfirmed",
                                targetId: target.id,
                                kills: p.kills
                            });

                            broadcast({
                                type: "playerRespawned",
                                id: target.id,
                                killerId: id,
                                hp: target.hp,
                                kills: p.kills,
                                deaths: target.deaths
                            });

                        } else {

                            broadcast({
                                type: "playerHit",
                                targetId: target.id,
                                hp: target.hp,
                                attackerId: id
                            });
                        }
                    }
                }

                break;
            }

            case "chat": {

                if (typeof data.message === "string") {

                    const message =
                        data.message
                            .trim()
                            .slice(0, 150);

                    if (message) {

                        broadcast({
                            type: "chat",
                            id,
                            message
                        });
                    }
                }

                break;
            }
        }
    });

    ws.on("close", () => {

        players.delete(id);

        console.log(
            `Player ${id} disconnected`
        );

        broadcast({
            type: "playerLeft",
            id
        });
    });

    ws.on("error", (err) => {

        console.log(
            `Player ${id} socket error:`,
            err.message
        );
    });
});

console.log(`=================================`);
console.log(` MISERY SHOOTERS MULTIPLAYER`);
console.log(`=================================`);
console.log(`Server running on port ${PORT}`);
console.log(`WebSocket: ws://localhost:${PORT}`);