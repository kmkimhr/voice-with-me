const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT || '10000');
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT || '10100');
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const TURN_PORT = process.env.TURN_PORT || '3478';
const TURN_USERNAME = process.env.TURN_USERNAME || 'videochat';
const TURN_PASSWORD = process.env.TURN_PASSWORD || 'videochatpass';

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

// rooms: Map<roomId, { router, peers: Map<socketId, peer> }>
const rooms = new Map();
let worker;

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  const router = await worker.createRouter({ mediaCodecs });
  const room = { router, peers: new Map(), usernames: new Set() };
  rooms.set(roomId, room);
  console.log(`[room] created: ${roomId}`);
  return room;
}

async function createWebRtcTransport(router) {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    iceServers: [
      {
        urls: `turn:${TURN_HOST}:${TURN_PORT}`,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      },
    ],
  });
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  let room = null;
  let roomId = null;
  let peerUsername = null;

  const peer = {
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    username: null,
  };

  socket.on('joinRoom', async ({ roomId: rid, username }, cb) => {
    try {
      roomId = rid;
      room = await getOrCreateRoom(roomId);

      // 중복 유저명 체크
      if (room.usernames.has(username)) {
        console.warn(`[joinRoom] duplicate username="${username}" in room=${roomId}`);
        return cb({ error: 'duplicate_username' });
      }

      peerUsername = username;
      peer.username = username;
      room.usernames.add(username);
      room.peers.set(socket.id, peer);
      socket.join(roomId);

      const existingProducers = [];
      for (const [peerId, p] of room.peers) {
        if (peerId === socket.id) continue;
        for (const producerId of p.producers.keys()) {
          existingProducers.push({ producerId, peerId, peerUsername: p.username });
        }
      }

      console.log(`[joinRoom] ${socket.id} username="${username}" → room=${roomId}, existing=${existingProducers.length}`);
      cb({ rtpCapabilities: room.router.rtpCapabilities, existingProducers });
    } catch (e) {
      console.error('[joinRoom] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('createTransport', async (_, cb) => {
    try {
      const transport = await createWebRtcTransport(room.router);
      peer.transports.set(transport.id, transport);
      console.log(`[createTransport] ${socket.id} transportId=${transport.id}`);
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (e) {
      console.error('[createTransport] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    try {
      const transport = peer.transports.get(transportId);
      await transport.connect({ dtlsParameters });
      console.log(`[connectTransport] ${socket.id} transportId=${transportId}`);
      cb({});
    } catch (e) {
      console.error('[connectTransport] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    try {
      const transport = peer.transports.get(transportId);
      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);

      console.log(`[produce] ${socket.id} kind=${kind} producerId=${producer.id}`);

      socket.to(roomId).emit('newProducer', {
        producerId: producer.id,
        peerId: socket.id,
        peerUsername,
      });

      cb({ id: producer.id });
    } catch (e) {
      console.error('[produce] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, cb) => {
    try {
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        console.warn(`[consume] canConsume=false producerId=${producerId}`);
        return cb({ error: 'cannot consume' });
      }
      const transport = peer.transports.get(transportId);
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });
      peer.consumers.set(consumer.id, consumer);

      console.log(`[consume] ${socket.id} kind=${consumer.kind} producerId=${producerId}`);
      cb({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (e) {
      console.error('[consume] error', e);
      cb({ error: e.message });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    if (!room) return;

    room.peers.delete(socket.id);
    if (peerUsername) room.usernames.delete(peerUsername);
    for (const transport of peer.transports.values()) {
      try { transport.close(); } catch (_) {}
    }

    // roomId 클로저 변수 사용 (disconnect 시 socket.rooms 는 이미 비워짐)
    if (roomId) {
      socket.to(roomId).emit('peerLeft', { peerId: socket.id });
      console.log(`[peerLeft] notified room=${roomId} about ${socket.id}`);
    }

    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(roomId);
      console.log(`[room] removed: ${roomId}`);
    }
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

async function main() {
  worker = await mediasoup.createWorker({
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });
  console.log(`mediasoup worker started, RTC ports: ${RTC_MIN_PORT}-${RTC_MAX_PORT}`);

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log(`SFU listening on :${PORT}`));
}

main().catch(console.error);
