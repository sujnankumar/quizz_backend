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
      : ["http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3001;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory storage for rooms (in production, use Redis or database)
const rooms = new Map();

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
    // Remove fallback to dummy questions - let the error propagate
    throw new Error(`Failed to generate questions: ${error.message}`);
  }
}


// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room
  socket.on('createRoom', async (data) => {
    try {
      const { playerName, topic, difficulty, questionCount } = data;

      // Generate unique room code
      let roomCode;
      do {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      } while (rooms.has(roomCode));

      const playerId = socket.id;
      const player = {
        id: playerId,
        name: playerName,
        score: 0,
        answered: false,
        selectedAnswer: null,
        answerTime: null
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
        questionTimer: null,
        createdAt: new Date()
      };

      rooms.set(roomCode, room);
      socket.join(roomCode);

      socket.emit('roomCreated', { room, playerId });
      console.log(`Room created: ${roomCode} by ${playerName}`);
    } catch (error) {
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join room
  socket.on('joinRoom', (data) => {
    const { roomCode, playerName } = data;

    const room = rooms.get(roomCode.toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.status !== 'waiting') {
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
      name: playerName,
      score: 0,
      answered: false,
      selectedAnswer: null,
      answerTime: null
    };

    room.players.push(player);
    socket.join(roomCode);

    // Update all players in room
    io.to(roomCode).emit('roomUpdated', room);
    socket.emit('roomJoined', { room, playerId });

    console.log(`${playerName} joined room ${roomCode}`);
  });

  // Start quiz
  socket.on('startQuiz', async () => {
    const roomCode = Array.from(socket.rooms)[1]; // Get room socket is in
    const room = rooms.get(roomCode);

    if (!room || room.adminId !== socket.id) {
      socket.emit('error', { message: 'Not authorized' });
      return;
    }

    try {
      // Generate questions
      const questions = await generateQuestions(room.topic, room.difficulty, room.questionCount);
      room.questions = questions;
      room.status = 'quiz';
      room.currentQuestion = 0;

      // Update all players
      io.to(roomCode).emit('quizStarted', room);
      console.log(`Quiz started in room ${roomCode}`);

      // Start first question timer
      startQuestionTimer(roomCode, room);
    } catch (error) {
      socket.emit('error', { message: 'Failed to start quiz' });
      console.error('Failed to start quiz:', error);
    }
  });

  // Player selects answer
  socket.on('selectAnswer', (data) => {
    const { answer, timeRemaining } = data;
    const roomCode = Array.from(socket.rooms)[1];
    const room = rooms.get(roomCode);

    if (!room || room.status !== 'quiz') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;

    const timeBonus = Math.floor(timeRemaining / 30 * 10); // Bonus based on remaining time
    const basePoints = 10;
    const totalPoints = basePoints + timeBonus;

    player.selectedAnswer = answer;
    player.answerTime = 30 - timeRemaining;
    player.answered = true;

    if (answer === room.questions[room.currentQuestion].correctAnswer) {
      player.score += totalPoints;
    }

    // Check if all players answered
    const allAnswered = room.players.every(p => p.answered);
    if (allAnswered) {
      io.to(roomCode).emit('allAnswered', room);
      clearQuestionTimer(roomCode);
    }

    // Update room for all players
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
    console.log('User disconnected:', socket.id);

    // Find and remove player from rooms
    for (const [roomCode, room] of rooms) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          // Delete empty room
          rooms.delete(roomCode);
          clearQuestionTimer(roomCode);
        } else {
          // Update room and appoint new admin if needed
          if (room.adminId === socket.id) {
            room.adminId = room.players[0].id;
          }
          io.to(roomCode).emit('roomUpdated', room);
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
  }, 30000); // 30 seconds

  questionTimers.set(roomCode, timer);
}

function clearQuestionTimer(roomCode) {
  const timer = questionTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    questionTimers.delete(roomCode);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Quiz Game Backend Running', rooms: rooms.size });
});

// Export for Vercel serverless functions
export default app;

// Start server (only when run directly, not in Vercel)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Cleanup timers on server shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down server...');
    for (const timer of questionTimers.values()) {
      clearTimeout(timer);
    }
    process.exit(0);
  });
}
