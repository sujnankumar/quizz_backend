import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? ['https://quizz-coral-five.vercel.app']
      : ['http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: { threshold: 1024 },
  cookie: false,
});

const PORT = process.env.PORT || 3001;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory storage for rooms (in production, use Redis or database)
const rooms = new Map();

// Track which room a socket belongs to for O(1) disconnect cleanup
const socketRoomMap = new Map();

// Basic connection rate limiting per IP to prevent storms
const connectionTracker = new Map(); // ip -> { count, resetAt }

// Apply simple rate limit: max 20 connections per minute per IP
io.use((socket, next) => {
  try {
    const xfwd = socket.handshake.headers['x-forwarded-for'];
    const ip = Array.isArray(xfwd)
      ? xfwd[0]
      : xfwd
        ? xfwd.split(',')[0].trim()
        : socket.handshake.address || 'unknown';
    const now = Date.now();
    const entry = connectionTracker.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    connectionTracker.set(ip, entry);
    if (entry.count > 20) {
      return next(new Error('Rate limit exceeded'));
    }
    return next();
  } catch {
    return next();
  }
});

// Question generation function using Gemini
async function generateQuestions(topic, difficulty, count) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const schema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 4, maxItems: 4 },
          correctAnswer: { type: 'NUMBER', minimum: 0, maximum: 3 },
        },
        required: ['id', 'question', 'options', 'correctAnswer'],
      },
    };

    const prompt = `Generate ${count} multiple choice questions about ${topic} with ${difficulty} difficulty level. The questions should be educational, well-formed, and distinct.`;

    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });

    const response = await result.response;
    const jsonText = response.text();
    const questions = JSON.parse(jsonText);

    return questions.map((q, index) => ({
      id: q.id || `q_${Date.now()}_${index}`,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      difficulty,
    }));
  } catch (error) {
    console.error('Error generating questions from AI:', error);
    throw new Error(`Failed to generate questions: ${error.message}`);
  }
}

// Timer management
const questionTimers = new Map();

function startQuestionTimer(roomCode, room) {
  clearQuestionTimer(roomCode);

  const timer = setTimeout(() => {
    io.to(roomCode).emit('timeUp', room);

    // Auto-submit unanswered players
    room.players.forEach((player) => {
      if (!player.answered) {
        player.answered = true;
        player.selectedAnswer = -1; // No answer
        player.roundPoints = 0;
      }
    });

    io.to(roomCode).emit('allAnswered', room);
  }, Number(room.questionTime || 30) * 1000);

  questionTimers.set(roomCode, timer);
}

function clearQuestionTimer(roomCode) {
  const timer = questionTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    questionTimers.delete(roomCode);
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  // Create room
  socket.on('createRoom', async (data) => {
    try {
      const { playerName, topic, difficulty, questionCount, clientId } = data || {};

      // Generate unique room code
      let roomCode;
      do {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      } while (rooms.has(roomCode));

      const playerId = socket.id;
      const stableClientId = clientId || `${socket.id}-${Date.now()}`;

      const player = {
        id: playerId,
        clientId: stableClientId,
        name: playerName || 'Player',
        score: 0,
        answered: false,
        selectedAnswer: null,
        answerTime: null,
        roundPoints: 0,
        ready: false,
      };

      const room = {
        id: roomCode,
        code: roomCode,
        adminId: playerId,
        players: [player],
        status: 'waiting',
        currentQuestion: 0,
        totalQuestions: Number(questionCount || 5),
        questions: [],
        topic: topic || 'General Knowledge',
        difficulty: difficulty || 'medium',
        questionCount: Number(questionCount || 5),
        questionTime: 30, // default seconds, adjustable in lobby
        questionsReady: false, // require pre-generation before start
        rematch: false, // rematch phase (finished state with lobby enabled)
        questionTimer: null,
        createdAt: new Date(),
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);
      socketRoomMap.set(socket.id, roomCode);

      socket.emit('roomCreated', { room, playerId, clientId: stableClientId });
    } catch (error) {
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join room (or rejoin if waiting or in rematch lobby)
  socket.on('joinRoom', (data) => {
    const { roomCode, playerName, clientId } = data || {};
    const rc = (roomCode || '').toUpperCase();

    const room = rooms.get(rc);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const canJoin =
      room.status === 'waiting' || (room.status === 'finished' && room.rematch === true);

    if (!canJoin) {
      // Allow rejoin if clientId matches an existing player
      if (clientId) {
        const existing = room.players.find((p) => p.clientId === clientId);
        if (existing) {
          existing.id = socket.id;
          socket.join(rc);
          socketRoomMap.set(socket.id, rc);
          io.to(rc).emit('roomUpdated', room);
          socket.emit('roomJoined', { room, playerId: existing.id });
          return;
        }
      }
      socket.emit('error', { message: 'Game has already started' });
      return;
    }

    if (room.players.length >= 10) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const playerId = socket.id;
    const player = {
      id: playerId,
      clientId: clientId || `${socket.id}-${Date.now()}`,
      name: playerName || 'Player',
      score: 0,
      answered: false,
      selectedAnswer: null,
      answerTime: null,
      roundPoints: 0,
      ready: false,
    };

    room.players.push(player);
    socket.join(rc);
    socketRoomMap.set(socket.id, rc);

    io.to(rc).emit('roomUpdated', room);
    socket.emit('roomJoined', { room, playerId });
  });

  // Rejoin room (for refresh/reconnect)
  socket.on('rejoinRoom', (data) => {
    try {
      const { roomCode, clientId, playerName } = data || {};
      const rc = (roomCode || '').toUpperCase();
      if (!rc || !clientId) {
        socket.emit('error', { message: 'Invalid rejoin payload' });
        return;
      }
      const room = rooms.get(rc);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      const existing = room.players.find((p) => p.clientId === clientId);
      if (!existing) {
        const canJoin =
          room.status === 'waiting' || (room.status === 'finished' && room.rematch === true);
        if (!canJoin) {
          socket.emit('error', { message: 'Game already in progress' });
          return;
        }
        // Join fresh
        const playerId = socket.id;
        const player = {
          id: playerId,
          clientId,
          name: playerName || 'Player',
          score: 0,
          answered: false,
          selectedAnswer: null,
          answerTime: null,
          roundPoints: 0,
          ready: false,
        };
        room.players.push(player);
        socket.join(rc);
        socketRoomMap.set(socket.id, rc);
        io.to(rc).emit('roomUpdated', room);
        socket.emit('roomJoined', { room, playerId });
        return;
      }
      // Rebind socket id
      existing.id = socket.id;
      socket.join(rc);
      socketRoomMap.set(socket.id, rc);
      io.to(rc).emit('roomUpdated', room);
      socket.emit('roomJoined', { room, playerId: existing.id });
    } catch {
      socket.emit('error', { message: 'Failed to rejoin' });
    }
  });

  // Update settings (admin only, while waiting or rematch)
  socket.on('updateSettings', (data) => {
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room || room.adminId !== socket.id) return;

    const inLobby = room.status === 'waiting' || (room.status === 'finished' && room.rematch === true);
    if (!inLobby) return;

    const { topic, difficulty, questionCount, questionTime } = data || {};
    if (typeof topic === 'string') room.topic = topic;
    if (typeof difficulty === 'string') room.difficulty = difficulty;
    if (typeof questionCount === 'number') {
      room.questionCount = Math.max(1, Math.min(20, questionCount));
      room.totalQuestions = room.questionCount;
    }
    if (typeof questionTime === 'number') {
      const allowed = [10, 15, 20, 25, 30];
      room.questionTime = allowed.includes(questionTime) ? questionTime : 30;
    }

    // Settings changed -> questions need regeneration
    room.questions = [];
    room.questionsReady = false;
    io.to(room.code).emit('roomUpdated', room);
  });

  // Generate questions (admin, while waiting or rematch)
  socket.on('generateQuestions', async () => {
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room || room.adminId !== socket.id) return;

    const inLobby = room.status === 'waiting' || (room.status === 'finished' && room.rematch === true);
    if (!inLobby) return;

    try {
      io.to(room.code).emit('generatingQuestions', { roomCode: room.code });
      const questions = await generateQuestions(room.topic, room.difficulty, room.questionCount);
      room.questions = questions;
      room.questionsReady = true;
      io.to(room.code).emit('questionsGenerated', room);
      io.to(room.code).emit('roomUpdated', room);
    } catch {
      socket.emit('error', { message: 'Failed to generate questions' });
    }
  });

  // Start quiz (requires pre-generated questions and all ready if rematch)
  socket.on('startQuiz', async () => {
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());

    if (!room || room.adminId !== socket.id) {
      socket.emit('error', { message: 'Not authorized' });
      return;
    }

    if (!Array.isArray(room.questions) || room.questions.length === 0 || !room.questionsReady) {
      socket.emit('error', { message: 'Generate questions first' });
      return;
    }

    // If rematch phase, require all players to be ready
    if (room.status === 'finished' && room.rematch === true) {
      const allReady = room.players.every((p) => p.ready === true);
      if (!allReady) {
        socket.emit('error', { message: 'All players must press Play Again to be ready' });
        return;
      }
    }

    try {
      // Reset players for a new match
      room.players.forEach((p) => {
        p.score = 0;
        p.answered = false;
        p.selectedAnswer = null;
        p.answerTime = null;
        p.roundPoints = 0;
        p.ready = false;
      });

      room.rematch = false;
      room.status = 'quiz';
      room.currentQuestion = 0;

      io.to(room.code).emit('quizStarted', room);
      startQuestionTimer(room.code, room);
    } catch {
      socket.emit('error', { message: 'Failed to start quiz' });
    }
  });

  // Player selects answer
  socket.on('selectAnswer', (data) => {
    const { answer, timeRemaining } = data || {};
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());

    if (!room || room.status !== 'quiz') return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.answered) return;

    const maxTime = Number(room.questionTime || 30);
    const timeBonus = Math.floor((Number(timeRemaining || 0) / maxTime) * 10);
    const basePoints = 10;
    const totalPoints = basePoints + timeBonus;

    player.selectedAnswer = answer;
    player.answerTime = maxTime - Number(timeRemaining || 0);
    player.answered = true;

    const isCorrect = answer === room.questions[room.currentQuestion].correctAnswer;
    player.roundPoints = isCorrect ? totalPoints : 0;

    if (isCorrect) {
      player.score += totalPoints;
    }

    // Notify submission
    io.to(room.code).emit('playerSubmitted', { playerId: player.id, playerName: player.name });

    // Check if all players answered
    const allAnswered = room.players.every((p) => p.answered);
    if (allAnswered) {
      io.to(room.code).emit('allAnswered', room);
      clearQuestionTimer(room.code);
    }

    io.to(room.code).emit('roomUpdated', room);
  });

  // Next question
  socket.on('nextQuestion', () => {
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());

    if (!room || room.adminId !== socket.id || room.status !== 'quiz') {
      return;
    }

    // Reset players for next question
    room.players.forEach((player) => {
      player.answered = false;
      player.selectedAnswer = null;
      player.answerTime = null;
      player.roundPoints = 0;
    });

    room.currentQuestion++;

    if (room.currentQuestion >= room.questions.length) {
      room.status = 'finished';
      io.to(room.code).emit('quizFinished', room);
    } else {
      io.to(room.code).emit('questionUpdated', room);
      startQuestionTimer(room.code, room);
    }
  });

  // Play again (personal lobby view + ready flag)
  socket.on('playAgain', () => {
    const roomCode = socketRoomMap.get(socket.id) || Array.from(socket.rooms)[1];
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    // Enter rematch phase and mark this player ready
    room.rematch = true;
    player.ready = true;

    // Clear questions readiness to force new generation for rematch
    room.questionsReady = false;

    io.to(room.code).emit('roomUpdated', room);
    // Do not change room.status; others can remain on results.
    socket.emit('goToLobby', room);
  });

  // Leave room
  socket.on('leaveRoom', () => {
    const roomCode = socketRoomMap.get(socket.id);
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    socket.leave(roomCode);
    socketRoomMap.delete(socket.id);

    if (room) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const leavingWasAdmin = room.players[idx].id === room.adminId;
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(roomCode);
          clearQuestionTimer(roomCode);
        } else {
          if (leavingWasAdmin) {
            room.adminId = room.players[0].id;
          }
          io.to(roomCode).emit('roomUpdated', room);
        }
      }
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const roomCode = socketRoomMap.get(socket.id);
    if (roomCode) {
      const room = rooms.get(roomCode);
      socketRoomMap.delete(socket.id);
      if (room) {
        const idx = room.players.findIndex((p) => p.id === socket.id);
        if (idx !== -1) {
          room.players.splice(idx, 1);
          if (room.players.length === 0) {
            rooms.delete(roomCode);
            clearQuestionTimer(roomCode);
          } else {
            if (room.adminId === socket.id) {
              room.adminId = room.players[0].id;
            }
            io.to(roomCode).emit('roomUpdated', room);
          }
        }
      }
    }
  });
});

// Middleware
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? ['https://quizz-coral-five.vercel.app']
  : ['http://localhost:3000', 'http://localhost:3001'];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// IMPORTANT: do not run express.json() on Engine.IO (Socket.IO) endpoints
app.use((req, res, next) => {
  if (req.url.startsWith('/socket.io/')) return next();
  return express.json()(req, res, next);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Quiz Game Backend Running', rooms: rooms.size });
});

// Debug endpoint to verify CORS headers and origin behavior in production
app.get('/api/health/cors', (req, res) => {
  const origin = req.headers.origin || null;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    origin,
    allowlist: (process.env.NODE_ENV === 'production'
      ? ['https://quizz-coral-five.vercel.app']
      : ['http://localhost:3000', 'http://localhost:3001']),
    corsApplied: true,
  });
});

// Export app (for tests or other runtimes)
export default app;

// Start server
if (!process.env.LAMBDA_TASK_ROOT && !process.env.VERCEL && process.argv[1] && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Gemini API Key: ${process.env.GEMINI_API_KEY ? 'Set' : 'Not set'}`);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down server...');
    for (const timer of questionTimers.values()) clearTimeout(timer);
    process.exit(0);
  });
}
