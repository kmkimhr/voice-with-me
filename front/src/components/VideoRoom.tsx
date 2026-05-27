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
  speaking: boolean;
}

const RemoteVideo: FC<RemoteVideoProps> = ({ stream, label, speaking }) => {
  const ref: RefObject<HTMLVideoElement> = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className={`video-block${speaking ? ' speaking' : ''}`}>
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
  const audioProducerRef: RefObject<Producer | null> = useRef(null);
  const videoProducerRef: RefObject<Producer | null> = useRef(null);
  const peerStreamsRef: RefObject<Record<string, PeerStream>> = useRef({});
  const micOnRef = useRef<boolean>(false);
  const camOnRef = useRef<boolean>(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, AnalyserNode>>(new Map());

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [peerStreams, setPeerStreams] = useState<Record<string, PeerStream>>({});
  const [status, setStatus] = useState<string>('');
  const [startError, setStartError] = useState<string>('');
  const [micOn, setMicOn] = useState<boolean>(false);
  const [camOn, setCamOn] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string>('');
  const [selectedVideoId, setSelectedVideoId] = useState<string>('');
  const [deviceSwitching, setDeviceSwitching] = useState<'audio' | 'video' | null>(null);
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const attachAnalyser = (id: string, stream: MediaStream): void => {
    if (analysersRef.current.has(id)) return;
    if (stream.getAudioTracks().length === 0) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    ctx.createMediaStreamSource(stream).connect(analyser);
    analysersRef.current.set(id, analyser);
  };

  const detachAnalyser = (id: string): void => {
    analysersRef.current.delete(id);
  };

  // iOS Safari PWA requires getUserMedia to be called directly from a user gesture
  const handleStart = async (): Promise<void> => {
    setIsLoading(true);
    setStartError('');
    // AudioContext는 반드시 await 이전 동기 구간에서 생성해야 autoplay 정책을 통과함
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
      stream.getAudioTracks().forEach((t) => (t.enabled = false));
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
      localStreamRef.current = stream;
      // 4초 대기 후 video-room 진입
      await new Promise((r) => setTimeout(r, 4000));
      setLocalStream(stream);
      setIsLoading(false);
    } catch (e: any) {
      setStartError('카메라/마이크 접근 오류: ' + e.message);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // 로컬 스트림 analyser 등록
  useEffect(() => {
    if (!localStream) return;
    attachAnalyser('local', localStream);
  }, [localStream]); // eslint-disable-line react-hooks/exhaustive-deps

  // 발화 감지 폴링 (100ms 간격)
  useEffect(() => {
    if (!localStream) return;
    const buf = new Uint8Array(256);
    const intervalId = setInterval(() => {
      const next = new Set<string>();
      analysersRef.current.forEach((analyser, peerId) => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / buf.length) > 0.01) next.add(peerId);
      });
      setSpeakingPeers(next);
    }, 100);
    return () => clearInterval(intervalId);
  }, [localStream]);

  useEffect(() => {
    if (!localStream) return;
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
      if (consumer.kind === 'audio') {
        attachAnalyser(peerId, peerStreamsRef.current[peerId].stream);
      }
      if (!destroyed) setPeerStreams({ ...peerStreamsRef.current });
    };

    const init = async (): Promise<void> => {
      setStatus('연결 중...');
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

        for (const track of localStreamRef.current!.getTracks()) {
          const producer = await sendTransport.produce({ track });
          if (track.kind === 'audio') audioProducerRef.current = producer;
          else videoProducerRef.current = producer;
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
        detachAnalyser(peerId);
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
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peerStreamsRef.current = {};
      analysersRef.current.clear();
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, [localStream, roomId, username, onDuplicate]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const next = !micOnRef.current;
    track.enabled = next;
    // producer의 _paused 상태를 함께 동기화 (replaceTrack이 _paused 기준으로 enabled를 덮어씀)
    if (next) audioProducerRef.current?.resume();
    else audioProducerRef.current?.pause();
    micOnRef.current = next;
    setMicOn(next);
  };

  const toggleCam = (): void => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !camOnRef.current;
    track.enabled = next;
    if (next) videoProducerRef.current?.resume();
    else videoProducerRef.current?.pause();
    camOnRef.current = next;
    setCamOn(next);
  };

  const openSettings = async (): Promise<void> => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
    setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
    setSelectedAudioId(localStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId ?? '');
    setSelectedVideoId(localStreamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? '');
    setSettingsOpen(true);
  };

  const switchAudioDevice = async (deviceId: string): Promise<void> => {
    setSelectedAudioId(deviceId);
    setDeviceSwitching('audio');
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
          },
        }),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      const newTrack = stream.getAudioTracks()[0];
      const oldTrack = localStreamRef.current?.getAudioTracks()[0];
      if (oldTrack) {
        localStreamRef.current?.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStreamRef.current?.addTrack(newTrack);
      // replaceTrack이 producer의 _paused 기준으로 enabled를 덮어쓰므로, 호출 후 토글 상태로 다시 맞춤
      if (audioProducerRef.current) await audioProducerRef.current.replaceTrack({ track: newTrack });
      newTrack.enabled = micOnRef.current;
      // 새 트랙으로 analyser 재연결
      detachAnalyser('local');
      if (localStreamRef.current) attachAnalyser('local', localStreamRef.current);
    } catch (e) {
      console.error('switchAudioDevice error', e);
    } finally {
      setDeviceSwitching(null);
    }
  };

  const switchVideoDevice = async (deviceId: string): Promise<void> => {
    setSelectedVideoId(deviceId);
    setDeviceSwitching('video');
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } },
        }),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      const newTrack = stream.getVideoTracks()[0];
      const oldTrack = localStreamRef.current?.getVideoTracks()[0];
      if (oldTrack) {
        localStreamRef.current?.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStreamRef.current?.addTrack(newTrack);
      // replaceTrack이 producer의 _paused 기준으로 enabled를 덮어쓰므로, 호출 후 토글 상태로 다시 맞춤
      if (videoProducerRef.current) await videoProducerRef.current.replaceTrack({ track: newTrack });
      newTrack.enabled = camOnRef.current;
      if (localVideoRef.current) {
        // null로 초기화 후 재할당해야 브라우저가 트랙 교체를 감지함
        localVideoRef.current.srcObject = null;
        localVideoRef.current.srcObject = localStreamRef.current;
        await localVideoRef.current.play().catch(() => {});
      }
    } catch (e) {
      console.error('switchVideoDevice error', e);
    } finally {
      setDeviceSwitching(null);
    }
  };

  if (!localStream) {
    return (
      <div className="join-page">
        <div className="join-card">
          <h1>Voice With Me</h1>
          <p style={{ marginBottom: 16, color: '#A2A2A4', fontSize: 14 }}>
            카메라와 마이크 접근을 허용해주세요.
          </p>
          {startError && <p className="error-msg">{startError}</p>}
          {isLoading && (
            <div className="loading-container">
              <div className="loading-bar"></div>
              <p style={{ color: '#A2A2A4', fontSize: 12, margin: '8px 0 0 0' }}>연결 중...</p>
            </div>
          )}
          <button onClick={handleStart} disabled={isLoading}>카메라/마이크 시작</button>
          <button onClick={onLeave} style={{ marginTop: 8, background: '#1C1D21', color: '#DBDDE1' }} disabled={isLoading}>돌아가기</button>
        </div>
      </div>
    );
  }

  const localSpeaking = speakingPeers.has('local') && micOn;

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
          <div className="controls-row">
            <button className={`ctrl-btn sidebar ${micOn ? '' : 'off'}`} onClick={toggleMic}>
              {micOn ? '🎙' : '🔇'}
              <span className="tooltip">{micOn ? '마이크 끄기' : '마이크 켜기'}</span>
            </button>
            <button className={`ctrl-btn sidebar ${camOn ? '' : 'off'}`} onClick={toggleCam}>
              {camOn ? '📷' : '🚫'}
              <span className="tooltip">{camOn ? '카메라 끄기' : '카메라 켜기'}</span>
            </button>
            <button className="ctrl-btn sidebar" onClick={openSettings}>
              ⚙️
              <span className="tooltip">설정</span>
            </button>
          </div>
          <button className="leave-btn" onClick={handleLeave}>
            ✕ 퇴장
          </button>
        </div>
      </div>

      <div className="room-main">
        <div className="video-grid">
          <div className={`video-block local${localSpeaking ? ' speaking' : ''}`}>
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span>{username} (나) {!micOn && '🔇'}{!camOn && '🚫'}</span>
          </div>
          {Object.entries(peerStreams).map(([peerId, { stream, username: peerName }]) => (
            <RemoteVideo
              key={peerId}
              stream={stream}
              label={peerName}
              speaking={speakingPeers.has(peerId)}
            />
          ))}
        </div>
      </div>

      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>장치 설정</h2>
              <button className="settings-close" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="settings-body">
              <div className="settings-group">
                <label>마이크</label>
                <select
                  value={selectedAudioId}
                  onChange={(e) => switchAudioDevice(e.target.value)}
                  disabled={deviceSwitching !== null}
                >
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `마이크 ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
                {deviceSwitching === 'audio' && (
                  <div className="device-loading-track">
                    <div className="device-loading-bar" />
                  </div>
                )}
              </div>
              <div className="settings-group">
                <label>카메라</label>
                <select
                  value={selectedVideoId}
                  onChange={(e) => switchVideoDevice(e.target.value)}
                  disabled={deviceSwitching !== null}
                >
                  {videoDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `카메라 ${d.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
                {deviceSwitching === 'video' && (
                  <div className="device-loading-track">
                    <div className="device-loading-bar" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
