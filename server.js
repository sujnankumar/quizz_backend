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
      ? ["https://quizz-coral-five.vercel.app"]
      : ["http://localhost:3000", "http://localhost:3001","http://192.168.13.69:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  path: '/socket.io',
  allowUpgrades: true,
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024
  },
  cookie: false
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
    const ip = Array.isArray(xfwd) ? xfwd[0] : (xfwd ? xfwd.split(',')[0].trim() : socket.handshake.address || 'unknown');
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
    // Use a model that supports JSON mode
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp"
    });

    // 1. Define the JSON Schema for the expected output
    const schema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: {
            type: "STRING",
            description: "A unique identifier for the question (e.g., 'q1_sci_med')."
          },
          question: {
            type: "STRING",
            description: "The text of the multiple-choice question."
          },
          options: {
            type: "ARRAY",
            items: { type: "STRING" },
            minItems: 4,
            maxItems: 4,
            description: "An array of exactly 4 string options."
          },
          correctAnswer: {
            type: "NUMBER",
            minimum: 0,
            maximum: 3,
            description: "The 0-based index of the correct answer in the 'options' array."
          }
        },
        required: ["id", "question", "options", "correctAnswer"]
      }
    };

    // 2. Create a prompt that focuses on what to generate
    const prompt = `Generate ${count} multiple choice questions about ${topic} with ${difficulty} difficulty level. The questions should be educational, well-formed, and distinct.`;

    // 3. Make the API call with the generationConfig
    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    const response = await result.response;
    const jsonText = response.text();

    // 4. Parse the guaranteed JSON response
    const questions = JSON.parse(jsonText);

    // 5. Post-process to add our known difficulty and ensure valid data
    return questions.map((q, index) => ({
      id: q.id || `q_${Date.now()}_${index}`,
      question: q.question,
      options: q.options,
      correctAnswer: q.correctAnswer,
      difficulty: difficulty // Add the difficulty from the function parameter
    }));

  } catch (error) {
    console.error('Error generating questions from AI:', error);
    Reovfllbkdok yqe.log('-leh p,o egto ode
    hww Err`Fi oignslayerName: $: aslAsssage}`
        answerTime: null,
        roundPoints: 0
      };


      const room = {
        id: roomCode,
        code: roomCode,
        adminId: playerId,
        players: [player],
        status: 'waiting',
        currentQuestion: 0,
        totalQuestions: questionCount,
        questions: [],
        topic,
        difficulty,
        questionCount,
        questionTime: 30, // default seconds, adjustable in lobby
        questionsReady: false, // require pre-generation before start
        questionTimer: null,
        createdAt: new Date()
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);
      socketRoomMap.set(socket.id, roomCode);

      socket.emit('roomCreated', { room, playerId, clientId: stableClientId });
      console.log(`Room created: ${roomCode} by ${playerName}`);
    } catch (error) {
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join room
  socket.on('joinRoom', (data) => {
    const { roomCode, playerName, clientId } = data;

    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.status !== 'waiting') {
      // Allow rejoin if clientId matches an existing player
      if (clientId) {
        const existing = room.players.find(p => p.clientId === clientId);
        if (existing) {
          existing.id = socket.id;
          socket.join(roomCode);
          socketRoomMap.set(socket.id, roomCode);
          io.to(roomCode).emit('roomUpdated', room);
          socket.emit('roomJoined', { room, playerId: existing.id });
          return;
        }
      }
      socket.emit('error', { message: 'Game has already started' });
      return;
    }

    if (room.players.length >= 10) { // Max 10 players
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const playerId = socket.id;
    const player = {
      id: playerId,
      clientId: clientId || `${socket.id}-${Date.now()}`,
      name: playerName,
      score: 0,
      answered: false,
      selectedAnswer: null,
      answerTime: null,
      roundPoints: 0
    };

    room.players.push(player);
    socket.join(roomCode);
    socketRoomMap.set(socket.id, roomCode);

    // Update all players in room
    io.to(roomCode).emit('roomUpdated', room);
    socket.emit('roomJoined', { room, playerId });

    console.log(`${playerName} joined room ${roomCode}`);
  });

  // Rejoin room (for refresh/reconnect)
  socket.on('rejoinRoom', (data) => {
    try {
      const { roomCode, clientId, playerName } = data;
      if (!roomCode || !clientId) {
        socket.emit('error', { message: 'Invalid rejoin payload' });
        return;
      }
      const room = rooms.get(roomCode.toUpperCase());
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      const existing = room.players.find(p => p.clientId === clientId);
      if (!existing) {
        // If room is waiting, allow joining as new; otherwise reject
        if (room.status !== 'waiting') {
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
          roundPoints: 0
        };
        room.players.push(player);
        socket.join(roomCode.toUpperCase());
        socketRoomMap.set(socket.id, roomCode.toUpperCase());
        io.to(roomCode.toUpperCase()).emit('roomUpdated', room);
        socket.emit('roomJoined', { room, playerId });
        return;
      }
      // Rebind socket id
      existing.id = socket.id;
      socket.join(roomCode.toUpperCase());
      socketRoomMap.set(socket.id, roomCode.toUpperCase());
      io.to(roomCode.toUpperCase()).emit('roomUpdated', room);
      socket.emit('roomJoined', { room, playerId: existing.id });
    } catch (e) {
      socket.emit('error', { message: 'Failed to rejoin' });
    }
  });

  // Start quiz (requires pre-generated questions)
  socket.on('startQuiz', async () => {
    const roomCode = Array.from(socket.rooms)[1]; // Get room socket is in
    const room = rooms.get(roomCode);

    if (!room || room.adminId !== socket.id) {
      socket.emit('error', { message: 'Not authorized' });
      return;
    }

    if (!Array.isArray(room.questions) || room.questions.length === 0 || !room.questionsReady) {
      socket.emit('error', { message: 'Generate questions first' });
      return;
    }

    try {
      room.status = 'quiz';
      room.currentQuestion = 0;

      // Update all players
      io.to(roomCode).emit('quizStarted', room);
      console.log(`Quiz started in room ${roomCode}`);

      // Start first question timer
      startQuestionTimer(roomCode, room);}
     ode).emit('allAnswered', room);
  

  io.to(roomCode).emit('roomUpdated', room);
  });

  // Next question
  socket.on('nextQuestion', () => {
    const roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);

    if (!room || room.adminId !== socket.id || room.status !== 'quiz') {
      return;
    }

    // Reset players for next question
    room.players.forEach(player => {
      player.answered = false;
      player.selectedAnswer = null;
      player.answerTime = null;
      player.roundPoints = 0;
    });

    room.currentQuestion++;

    if (room.currentQuestion >= room.questions.length) {
      // Quiz finished
      room.status = 'finished';
      io.to(roomCode).emit('quizFinished', room);
    } else {
      // Next question
      io.to(roomCode).emit('questionUpdated', room);
      startQuestionTimer(roomCode, room);
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const roomCode = socketRoomMap.get(socket.id);
    if (roomCode) {
      const room = rooms.get(roomCode);
      socketRoomMap.delete(socket.id);
      if (room) {
        const idx = room.players.findIndex(p => p.id === socket.id);
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
      return;
    }

    // Fallback: scan rooms (should be rare)
    for (const [rc, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delete(rc);
          clearQuestionTimer(rc);
        } else {
          if (room.adminId === socket.id) {
            room.adminId = room.players[0].id;
          }
          io.to(rc).emit('roomUpdated', room);
        }
        break;
      }
    }
  });
});

// Timer management
const questionTimers = new Map();

function startQuestionTimer(roomCode, room) {
  clearQuestionTimer(roomCode);

  const timer = setTimeout(() => {
    io.to(roomCode).emit('timeUp', room);

    // Auto-submit unanswered players
    room.players.forEach(player => {
      if (!player.answered) {
        player.answered = true;
        player.selectedAnswer = -1; // No answer
      }
    });

    io.to(roomCode).emit('allAnswered', room);
  }, (Number(room.questionTime || 30)) * 1000);

  questionTimers.set(roomCode, timer);
}

function clearQuestionTimer(roomCode) {
  const timer = questionTimers.get(roomCode);
  if (timer) {
    cDomol}haloss.env.NODE_ENV === 'production'
  s'pk/utca'(rpMon .ru
  }
  // Appy JSON par{  return express.json()(req, res, next);
    // Update settings (only admin, only while waiting)
so    const roomCode = Array.from(sock    const room = rooms.get(roomCode);
      if (!room || room.adminId !== socket.id || room.status !== 'waiting') return;
  
      const { topic, difficulty, questionCount, questionTime } = data || {};
c    if (typeof difficulty === 'string') room.difficulty = difficulty;
      if (typeof questionCount === 'number') {
        room.questionCount = Math.max(1, Math.min(20, questionCount));
        room.totalQuestions = room.questionCount;
      }
      if (typeofroom.nme =Id === socket.id== 'number') {
        const allowed = [10, 15, 20, 25, 30];
        room.questionTime = allowed.includes(questionTime) ? questionTime : 30;
      }
  
      // Settings changed -> questions need regeneration
      room.questions = [];
     ;rur;
}

    ///Fallback:/s aerate sog)hulobeera.neteQuestions', async () => {
   cforo(nst ro[oc, om(s]oo(!oom s|| room.adminId !== socket.id || room.status !== 'waiting') return;

  try {
    io.to(roomCode).emit('generatingQuestions', { roomCode });
    const questions = await generateQuestions(room.topic, room.difficulty, room.questionCount);
    room.questions = quec
    room.questionsReady = truec
    io.to(roomCode).emit('questionsGenerated', room);
    io.to(roomCode).emit('roomUpdated', room);
  } catch (e) {
    socket.emit('error', { message: 'Failed to generate questions' });
  }c
});
break;
  // Play again (reset same room back to lobby)
  so}
ck})'playAgain', () => {
c);onst roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);
if Timer m!nmgement
uonst;questinTier=nwMp(;

unti startQueionTime(Cde,
  clearQuestionTimer(roomCode);

room.stattmer = s;tTmout() {
 io.to(romCod)emt('timeUp', room

    //rAuto-submot.unanswerereplayersn = 0;
    .questions = forEach(];ayr=> {
    ro.que!sReady=aaswered
playeanswrd = ue
    // Rptpyer.relecsedAoswes = -1; // Noranswer
oompr }.forEach(p => {
    });

  p.oo.to = 0;Coe).et('allAwre',room);
  }, (Number(room.questionTime || 30)) *p1000);

.aquestionTimees.set(rredCo e, tifer);
}

functaol;caQuetonTimer(roomCoe) {ectedAnswer = null;
  const timer = questswnTimems=g llCo
  if (timer) {oundPoints = 0;
    clrTimeout(timer)
questionTimers.delete(roomCode);
  clearQuestionTimer(roomCode);
 o.to(roomCode).emit('roomUpdated', room);
);
  // Leave room
  socket.on('leaveRoom', () => {
    const roomCode = socketRoomMap.get(socket.id);
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    socket.leave(roomCode);
    socketRoomMap.delete(socket.id);

    if (room) {
      const idx = room.players.findIndex(p => p.id === socket.id);
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
      }son()(req, res, next);
  // Update settings (only admin, only while waiting)
  socket.on('updateSettings', (data) => {
    const roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);
    if (!room || room.adminId !== socket.id || room.status !== 'waiting') return;

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
    io.to(roomCode).emit('roomUpdated', room);
  });

  // Generate questions (admin, waiting)
  socket.on('generateQuestions', async () => {
    const roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);
    if (!room || room.adminId !== socket.id || room.status !== 'waiting') return;

    try {
      io.to(roomCode).emit('generatingQuestions', { roomCode });
      cont questis = await generateQuestionsroom.topic, room.difficulty, room.questionCount;
      room.questions = questions;
      room.questionsReady = true;
      io.tooomCode).mit('uestionsGenerated', room);
      io.to(roomCode).emit('roomUpdated'oom);
    } catch () {
      ocket.emit('error' { message: 'Failed to generate questions' });
    }
  });

  //Play agai (rest same room back to lobby)
  socket.on('playAgain', () => {
    const roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);
    if (!room) return;

    room.status = 'waiting';
    room.currentQuestion = 0;
    room.questions = [];
    room.questionsReady = false;

    // Reset players to fresh state (scores reset for a new match)
    room.players.forEach(p => {
      p.score = 0;
      p.answered = false;
      p.selectedAnswer = null;
      p.answerTime = null;
      p.roundPoints = 0;
    });

    clearQuestionTimer(roomCode);
    io.to(roomCode).emit('roomUpdated', room);
  });

  // Leave room
  socket.on('leaveRoom', () => {
    const roomCode = socketRoomMap.get(socket.id);
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    socket.leave(roomCode);
    socketRoomMap.delete(socket.id);

    if (room) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const leavingWasAdmin = room.players[id].id === room.adminId;
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          rooms.delee(roomCode
          clearQuestionTimer(roomCode);
          else {
          if (leavingWasAdmin  {
            room.adminId = room.players[0].id  }
          }  });
          io.to(roomCode).emit('roomUpdated', room);
        }
      }
    }
  });
});

// Health check
});

// Health check
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
      : ['http://localhost:3000', 'http://localhost:3001','http://192.168.13.69:3000']),
    corsApplied: true
  });
});

// Export apper (only wh n (un directly, not in Vercel)for tests or other runtimes)
export default app;

// Start server (only when run directly, not in Vercel)
if (!process.env.LAMBDA_TASK_ROOT && !process.env.VERCEL && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Gemini API Key: ${process.env.GEMINI_API_KEY ? 'Set' : 'Not set'}`);
  });

  // Cleanup timers on server shutdown
  process.on('SIGINT', () onsole.log('Shutting down server...');
      clearTimeout(timer);
    }
    process.exit(0);
  });
}
