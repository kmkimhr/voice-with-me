import { useEffect, useRef, useState, FC, RefObject } from 'react';
import { Socket, io } from 'socket.io-client';
import { Device, Transport, Producer, Consumer } from 'mediasoup-client/lib/types';

interface PeerStream {
  stream: MediaStream;
  username: string;
}

interface RtpCapabilities {
  [key: string]: any;
}

interface ExistingProducer {
  producerId: string;
  peerId: string;
  peerUsername: string;
}

interface JoinRoomResponse {
  error?: string;
  rtpCapabilities?: RtpCapabilities;
  existingProducers?: ExistingProducer[];
}

interface TransportParams {
  id: string;
  iceParameters: any;
  iceCandidates: any;
  dtlsParameters: any;
  sctpParameters?: any;
}

interface ConsumeParams {
  error?: string;
  id?: string;
  producerId?: string;
  kind?: string;
  rtpParameters?: any;
}

interface ProduceResponse {
  error?: string;
  id?: string;
}

function emitAsync(socket: Socket, event: string, data: object = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, (res: any) => {
      if (res?.error) reject(new Error(res.error));
      else resolve(res);
    });
  });
}

interface RemoteVideoProps {
  stream: MediaStream;
  label: string;
}

const RemoteVideo: FC<RemoteVideoProps> = ({ stream, label }) => {
  const ref: RefObject<HTMLVideoElement> = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="video-block">
      <video ref={ref} autoPlay playsInline />
      <span>{label}</span>
    </div>
  );
};

interface VideoRoomProps {
  roomId: string;
  username: string;
  onLeave: () => void;
  onDuplicate: () => void;
}

const VideoRoom: FC<VideoRoomProps> = ({ roomId, username, onLeave, onDuplicate }) => {
  const localVideoRef: RefObject<HTMLVideoElement> = useRef(null);
  const socketRef: RefObject<Socket | null> = useRef(null);
  const deviceRef: RefObject<Device | null> = useRef(null);
  const sendTransportRef: RefObject<Transport | null> = useRef(null);
  const recvTransportRef: RefObject<Transport | null> = useRef(null);
  const localStreamRef: RefObject<MediaStream | null> = useRef(null);
  const peerStreamsRef: RefObject<Record<string, PeerStream>> = useRef({});
  const [peerStreams, setPeerStreams] = useState<Record<string, PeerStream>>({});
  const [status, setStatus] = useState<string>('연결 중...');
  const [micOn, setMicOn] = useState<boolean>(false);
  const [camOn, setCamOn] = useState<boolean>(false);

  useEffect(() => {
    let localStream: MediaStream | null = null;
    let destroyed = false;

    const consumeProducer = async (
      socket: Socket,
      device: Device,
      recvTransport: Transport,
      producerId: string,
      peerId: string,
      peerUsername: string
    ): Promise<void> => {
      const res: ConsumeParams = await emitAsync(socket, 'consume', {
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      if (res.error) {
        console.error('consume error:', res.error);
        return;
      }

      const consumer: Consumer = await recvTransport.consume({
        id: res.id!,
        producerId: res.producerId!,
        kind: res.kind as 'audio' | 'video',
        rtpParameters: res.rtpParameters,
      });

      if (!peerStreamsRef.current[peerId]) {
        peerStreamsRef.current[peerId] = { stream: new MediaStream(), username: peerUsername };
      }
      peerStreamsRef.current[peerId].stream.addTrack(consumer.track);
      if (!destroyed) setPeerStreams({ ...peerStreamsRef.current });
    };

    const init = async (): Promise<void> => {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 1 },
          latency: { ideal: 0.01 },
        },
      });
      if (destroyed) {
        localStream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = localStream;
      localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      localStream.getVideoTracks().forEach((t) => (t.enabled = false));
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

      const socket: Socket = io({ path: '/socket.io' });
      socketRef.current = socket;

      socket.on('connect', async () => {
        if (destroyed) return;
        setStatus('방 입장 중...');

        const joinRes: JoinRoomResponse = await emitAsync(socket, 'joinRoom', { roomId, username });
        if (joinRes.error) {
          if (joinRes.error === 'duplicate_username') {
            onDuplicate();
          }
          return;
        }

        const { rtpCapabilities, existingProducers } = joinRes;

        const device: Device = new (await import('mediasoup-client')).Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        deviceRef.current = device;

        // Send Transport
        const sendParams: TransportParams = await emitAsync(socket, 'createTransport', {});
        const sendTransport: Transport = device.createSendTransport(sendParams);
        sendTransportRef.current = sendTransport;

        sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          emitAsync(socket, 'connectTransport', { transportId: sendTransport.id, dtlsParameters })
            .then(callback)
            .catch(errback);
        });

        sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
          try {
            const { id }: ProduceResponse = await emitAsync(socket, 'produce', {
              transportId: sendTransport.id,
              kind,
              rtpParameters,
            });
            callback({ id });
          } catch (e) {
            errback(e);
          }
        });

        // Recv Transport
        const recvParams: TransportParams = await emitAsync(socket, 'createTransport', {});
        const recvTransport: Transport = device.createRecvTransport(recvParams);
        recvTransportRef.current = recvTransport;

        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
          emitAsync(socket, 'connectTransport', { transportId: recvTransport.id, dtlsParameters })
            .then(callback)
            .catch(errback);
        });

        for (const track of localStream!.getTracks()) {
          await sendTransport.produce({ track });
        }

        for (const { producerId, peerId, peerUsername } of existingProducers || []) {
          await consumeProducer(socket, device, recvTransport, producerId, peerId, peerUsername);
        }

        setStatus('');
      });

      socket.on('newProducer', async ({ producerId, peerId, peerUsername }) => {
        if (destroyed) return;
        await consumeProducer(
          socketRef.current!,
          deviceRef.current!,
          recvTransportRef.current!,
          producerId,
          peerId,
          peerUsername
        );
      });

      socket.on('peerLeft', ({ peerId }) => {
        delete peerStreamsRef.current[peerId];
        if (!destroyed) setPeerStreams({ ...peerStreamsRef.current });
      });

      socket.on('connect_error', (e: Error) => setStatus('연결 실패: ' + e.message));
      socket.on('disconnect', () => {
        if (!destroyed) setStatus('연결 끊김');
      });
    };

    init().catch((e: Error) => {
      console.error('[init] error', e);
      setStatus('오류: ' + e.message);
    });

    return () => {
      destroyed = true;
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();
      socketRef.current?.disconnect();
      localStream?.getTracks().forEach((t) => t.stop());
      peerStreamsRef.current = {};
    };
  }, [roomId, username, onDuplicate]);

  const handleLeave = (): void => {
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    socketRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    onLeave();
  };

  const toggleMic = (): void => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  };

  const toggleCam = (): void => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  };

  return (
    <div className="video-room">
      <div className="room-sidebar">
        <div className="users-section">
          <h3>현재 참석중인 유저</h3>
          <ul className="user-list">
            <li className="user-item">
              <span className="user-name">{username}</span>
              <span className="user-badge">나</span>
              {!micOn && <span className="status-icon">🔇</span>}
              {!camOn && <span className="status-icon">🚫</span>}
            </li>
            {Object.entries(peerStreams).map(([peerId, { username: peerName }]) => (
              <li key={peerId} className="user-item">
                <span className="user-name">{peerName}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="controls-section">
          <button className={`ctrl-btn sidebar ${micOn ? '' : 'off'}`} onClick={toggleMic}>
            {micOn ? '🎙' : '🔇'}
            <span className="tooltip">{micOn ? '마이크 끄기' : '마이크 켜기'}</span>
          </button>
          <button className={`ctrl-btn sidebar ${camOn ? '' : 'off'}`} onClick={toggleCam}>
            {camOn ? '📷' : '🚫'}
            <span className="tooltip">{camOn ? '카메라 끄기' : '카메라 켜기'}</span>
          </button>
          <button className="leave-btn" onClick={handleLeave}>
            ✕<span className="tooltip">퇴장</span>
          </button>
        </div>
      </div>
      <div className="room-main">
        <div className="video-grid">
          <div className="video-block local">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span>{username} (나) {!micOn && '🔇'}{!camOn && '🚫'}</span>
          </div>
          {Object.entries(peerStreams).map(([peerId, { stream, username: peerName }]) => (
            <RemoteVideo key={peerId} stream={stream} label={peerName} />
          ))}
        </div>
      </div>
      {status && (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)',
            padding: '8px 16px',
            borderRadius: 8,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
};

export default VideoRoom;
