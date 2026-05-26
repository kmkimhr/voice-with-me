import { useState, FC } from 'react';
import VideoRoom from './components/VideoRoom';

const App: FC = () => {
  const [roomInput, setRoomInput] = useState<string>('test');
  const [username, setUsername] = useState<string>('');
  const [joined, setJoined] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const handleJoin = (): void => {
    if (!roomInput.trim()) {
      setError('방 이름을 입력해주세요.');
      return;
    }
    if (!username.trim()) {
      setError('이름을 입력해주세요.');
      return;
    }
    setError('');
    setJoined(true);
  };

  const handleLeave = (): void => {
    setJoined(false);
    setUsername('');
    setError('');
  };

  const handleDuplicateError = (): void => {
    setJoined(false);
    setError('이미 존재하는 유저 이름입니다.');
  };

  if (joined) {
    return (
      <VideoRoom
        roomId={roomInput.trim()}
        username={username.trim()}
        onLeave={handleLeave}
        onDuplicate={handleDuplicateError}
      />
    );
  }

  return (
    <div className="join-page">
      <div className="join-card">
        <h1>Video Chat</h1>
        <input
          type="text"
          placeholder="방 ID 입력"
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value)}
        />
        <input
          type="text"
          placeholder="이름 입력"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          autoFocus
        />
        {error && <p className="error-msg">{error}</p>}
        <button onClick={handleJoin}>입장</button>
      </div>
    </div>
  );
};

export default App;
