# Video Chat Flow

## 구성 요소

| 역할 | 기술 |
|------|------|
| Frontend | Vite + React |
| SFU (시그널링 + 미디어) | Node.js + mediasoup |
| TURN | coturn (Docker) |
| Reverse Proxy | nginx (HTTPS) |

---

## 입장 흐름

```
Client                        nginx                  SFU (mediasoup)
  │                              │                         │
  │── GET https://kmkim.space ──>│                         │
  │<── React 앱 (index.html) ───│                         │
  │                              │                         │
  │── WebSocket /socket.io/ ────>│── proxy :3000 ─────────>│
  │                              │                         │
  │──── joinRoom(roomId) ───────────────────────────────>  │
  │<─── rtpCapabilities + existingProducers ─────────────  │
  │                              │                         │
  │──── createTransport() × 2 ─────────────────────────>  │  (send / recv)
  │<─── transportParams × 2 ────────────────────────────  │
  │                              │                         │
  │  [로컬 카메라/마이크 획득]    │                         │
  │                              │                         │
  │──── connectTransport(dtls) ────────────────────────>  │
  │──── produce(video) ─────────────────────────────────>  │
  │──── produce(audio) ─────────────────────────────────>  │
  │<─── producerId ─────────────────────────────────────   │
  │                              │                         │── newProducer → 다른 Client들
```

---

## 신규 참여자가 기존 참여자 화면을 가져오는 흐름

```
신규 Client                                        SFU
  │                                                 │
  │── joinRoom() ─────────────────────────────────> │
  │<── existingProducers: [{producerId, peerId}...] │  (기존 참여자 producer 목록)
  │                                                 │
  │── consume(producerId, rtpCapabilities) ────────>│
  │<── consumerParams (id, kind, rtpParameters) ────│
  │                                                 │
  │  [MediaStream에 track 추가 → <video> 렌더링]    │
```

---

## 기존 참여자가 신규 참여자 화면을 받는 흐름

```
기존 Client                    SFU                신규 Client
  │                              │                     │
  │                              │<── produce(video) ──│
  │<── newProducer(producerId) ──│                     │
  │                              │                     │
  │── consume(producerId) ──────>│                     │
  │<── consumerParams ───────────│                     │
  │                              │                     │
  │  [화면에 신규 참여자 영상 추가]                    │
```

---

## 미디어 전송 경로

```
Client A  ──[UDP]──>  SFU (mediasoup)  ──[UDP]──>  Client B
              ↑
        직접 연결 실패 시
              ↓
Client A  ──> coturn (TURN relay) ──> SFU ──> coturn ──> Client B
```

---

## 퇴장 흐름

```
Client                                SFU
  │── disconnect ───────────────────> │
  │                                   │── peerLeft(peerId) → 같은 방 모든 Client
  │                                   │   [해당 transport / producer 정리]
  │                                   │
다른 Client: peerLeft 수신 → 해당 peerId 화면 블록 제거
```

---

## 포트 정리

| 포트 | 프로토콜 | 역할 |
|------|----------|------|
| 80 | TCP | HTTP → HTTPS 리다이렉트 |
| 443 | TCP | HTTPS (프론트 서빙 + 시그널링 프록시) |
| 3000 | TCP | SFU 내부 포트 (nginx가 프록시) |
| 3478 | UDP/TCP | coturn TURN/STUN |
| 10000~10100 | UDP | mediasoup RTC 미디어 |
