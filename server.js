/*******************************************************************
 * server.js
 *
 * Features:
 *  - Teacher automatically creates session on page load (TEACHER_CREATE_SESSION).
 *  - Multiple questions: Start MCQ/Next Question -> Explanation -> ...
 *  - Real-time updates: MCQ answers, typed explanations.
 *  - Stop Quiz ends everything, teacher can download CSV.
 *  - CSV includes columns: Question #, Question Text, Username, MCQ Answer, Explanation.
 *  - Filenames have session code & timestamp (no extra libs required).
 *  - Keeps websockets alive up to 60 min or until quiz stops/closes.
 *******************************************************************/
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

// Serve the /public folder
app.use(express.static("public"));

// Teacher console at /console
app.get("/console", (req, res) => {
  res.sendFile(__dirname + "/public/console.html");
});

/**
 * sessions[sessionCode] = {
 *   teacher: WebSocket | null,
 *   stage: 'WAITING' | 'MCQ' | 'EXPLANATION' | 'STOPPED',
 *   currentQuestionIndex: number,
 *   questions: Array<{
 *     questionNumber: number,
 *     questionText: string,
 *     mcqOptions: number,
 *     stage: 'MCQ' | 'EXPLANATION' | 'DONE',
 *     answers: {
 *       [studentId]: {
 *         username: string,
 *         mcqAnswer: number | null,
 *         explanation: string
 *       }
 *     }
 *   }>,
 *   students: {
 *     [studentId]: {
 *       username: string,
 *       ws: WebSocket
 *     }
 *   }
 * }
 */
const sessions = {};

/** Generate a 6-char uppercase hex code (e.g. 'A1B2C3') */
function generateSessionCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

/** Safely send JSON via WebSocket */
function sendJSON(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Broadcast to teacher + all students in a session */
function broadcastToSession(sessionCode, data) {
  const session = sessions[sessionCode];
  if (!session) return;
  if (session.teacher) sendJSON(session.teacher, data);
  Object.values(session.students).forEach((stu) => {
    sendJSON(stu.ws, data);
  });
}

/** Gets the current question object (if any) in the session */
function getCurrentQuestion(sessionCode) {
  const session = sessions[sessionCode];
  if (!session) return null;
  const idx = session.currentQuestionIndex;
  if (idx < 0 || idx >= session.questions.length) return null;
  return session.questions[idx];
}

/**
 * Broadcast a "teacher view" update:
 *  - stage
 *  - current question text, options
 *  - array of answers for that question
 */
/*******************************************************************
 * server.js
 * (Only relevant parts shown, the rest is unchanged)
 *******************************************************************/

// ... same initial code ...

function broadcastTeacherView(sessionCode) {
  const session = sessions[sessionCode];
  if (!session || !session.teacher) return;

  const currentQ = getCurrentQuestion(sessionCode);

  let questionText = "";
  let mcqOptions = 0;
  let answersArr = [];

  if (currentQ) {
    questionText = currentQ.questionText;
    mcqOptions = currentQ.mcqOptions;
    // Flatten the answers map into an array for easy UI
    answersArr = Object.values(currentQ.answers);
  }

  // NEW: Build a separate array of all student names
  const studentNames = Object.values(session.students).map((stu) => stu.username);

  sendJSON(session.teacher, {
    type: "TEACHER_VIEW_UPDATE",
    payload: {
      sessionCode,
      stage: session.stage,
      questionText,
      mcqOptions,
      answers: answersArr,    // for results
      studentNames: studentNames,  // for real-time "who joined"
    },
  });
}

/** Create CSV with columns: Question#, QuestionText, Username, MCQAnswer, Explanation */
function generateCSV(session) {
  const rows = [
    ["Question #", "Question Text", "Username", "MCQ Answer", "Explanation"]
  ];
  session.questions.forEach((q) => {
    const qNum = q.questionNumber;
    const qTxt = q.questionText;
    // For each student's answers
    for (const studentId in q.answers) {
      const ans = q.answers[studentId];
      rows.push([
        qNum,
        qTxt,
        ans.username || "",
        ans.mcqAnswer || "",
        ans.explanation || ""
      ]);
    }
  });

  // Convert to CSV string
  return rows
    .map((r) => r.map((val) => `"${String(val).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

/** Simple timestamp for filename, e.g. 20230310-150501 */
function getTimestampString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${HH}${MM}${SS}`;
}

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Keep track of isAlive for keep-alive pings
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.log("Invalid JSON from client");
      return;
    }

    const { type, payload } = data;

    // ===== TEACHER ACTIONS =====
    if (type === "TEACHER_CREATE_SESSION") {
      const code = generateSessionCode();
      sessions[code] = {
        teacher: ws,
        stage: "WAITING",
        currentQuestionIndex: -1,
        questions: [],
        students: {}
      };
      console.log("Teacher created session", code);

      sendJSON(ws, {
        type: "SESSION_CREATED",
        payload: { sessionCode: code }
      });

    } else if (type === "TEACHER_START_MCQ") {
      const { sessionCode, questionText, options } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      session.stage = "MCQ";

      // Mark previous question "DONE" if it was in EXPLANATION
      if (session.currentQuestionIndex >= 0) {
        const prevQ = getCurrentQuestion(sessionCode);
        if (prevQ && prevQ.stage === "EXPLANATION") {
          prevQ.stage = "DONE";
        }
      }

      // Create a new question
      const newQnum = session.questions.length + 1;
      const questionObj = {
        questionNumber: newQnum,
        questionText: questionText || "",
        mcqOptions: options,
        stage: "MCQ",
        answers: {}
      };
      session.questions.push(questionObj);
      session.currentQuestionIndex = session.questions.length - 1;

      // Add answer slots for existing students
      Object.entries(session.students).forEach(([stuId, stu]) => {
        questionObj.answers[stuId] = {
          username: stu.username,
          mcqAnswer: null,
          explanation: ""
        };
      });

      broadcastToSession(sessionCode, {
        type: "MCQ_STARTED",
        payload: {
          questionText: questionObj.questionText,
          options: questionObj.mcqOptions
        }
      });

      broadcastTeacherView(sessionCode);

    } else if (type === "TEACHER_NEXT_EXPLANATION") {
      const { sessionCode } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      session.stage = "EXPLANATION";
      const curQ = getCurrentQuestion(sessionCode);
      if (curQ && curQ.stage === "MCQ") {
        curQ.stage = "EXPLANATION";
      }

      broadcastToSession(sessionCode, {
        type: "SHOW_EXPLANATION_INPUT"
      });
      broadcastTeacherView(sessionCode);

    } else if (type === "TEACHER_STOP_QUIZ") {
      const { sessionCode } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      session.stage = "STOPPED";
      broadcastToSession(sessionCode, {
        type: "QUIZ_STOPPED"
      });
      console.log("Teacher STOP_QUIZ for session", sessionCode);

      // close student websockets
      Object.values(session.students).forEach((stu) => {
        stu.ws.close();
      });
      broadcastTeacherView(sessionCode);

    } else if (type === "TEACHER_CLOSE_PAGE") {
      // If teacher closes tab
      const { sessionCode } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      session.stage = "STOPPED";
      broadcastToSession(sessionCode, {
        type: "QUIZ_STOPPED"
      });
      console.log("Teacher closed page -> stop session", sessionCode);

      // close all students
      Object.values(session.students).forEach((stu) => {
        stu.ws.close();
      });
      delete sessions[sessionCode];

    } else if (type === "TEACHER_DOWNLOAD_CSV") {
      const { sessionCode } = payload;
      const session = sessions[sessionCode];
      if (!session) {
        sendJSON(ws, {
          type: "ERROR",
          payload: { message: "No such session." }
        });
        return;
      }
      const csvStr = generateCSV(session);
      const ts = getTimestampString();
      const filename = `quiz_data_${sessionCode}_${ts}.csv`;

      sendJSON(ws, {
        type: "CSV_DATA",
        payload: {
          csv: csvStr,
          filename
        }
      });

    } else if (type === "TEACHER_REJOIN_SESSION") {
      // If teacher refreshes page
      const { sessionCode } = payload;
      if (sessions[sessionCode]) {
        sessions[sessionCode].teacher = ws;
        broadcastTeacherView(sessionCode);
      } else {
        sendJSON(ws, {
          type: "ERROR",
          payload: { message: "Session code not found" }
        });
      }

    // ===== STUDENT ACTIONS =====
    } else if (type === "STUDENT_JOIN_SESSION") {
      const { sessionCode, username } = payload;
      const session = sessions[sessionCode];
      if (!session) {
        sendJSON(ws, {
          type: "ERROR",
          payload: { message: "Invalid session code" }
        });
        return;
      }
      const studentId = crypto.randomBytes(3).toString("hex");
      session.students[studentId] = {
        username,
        ws
      };

      console.log(`Student ${username} joined session ${sessionCode}`);

      // If there's a current question, add an answers entry for them
      const curQ = getCurrentQuestion(sessionCode);
      if (curQ) {
        curQ.answers[studentId] = {
          username,
          mcqAnswer: null,
          explanation: ""
        };
      }

      sendJSON(ws, {
        type: "JOINED_SESSION",
        payload: {
          studentId,
          sessionCode,
          stage: session.stage // WAITING, MCQ, EXPLANATION, STOPPED
        }
      });

      broadcastTeacherView(sessionCode);

    } else if (type === "STUDENT_SUBMIT_MCQ") {
      const { sessionCode, studentId, answer } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      const curQ = getCurrentQuestion(sessionCode);
      if (!curQ) return;

      if (!curQ.answers[studentId]) {
        // Student joined late
        const stuInfo = session.students[studentId];
        if (!stuInfo) return;
        curQ.answers[studentId] = {
          username: stuInfo.username,
          mcqAnswer: null,
          explanation: ""
        };
      }
      curQ.answers[studentId].mcqAnswer = answer;
      broadcastTeacherView(sessionCode);

    } else if (type === "STUDENT_EXPLANATION_UPDATE") {
      const { sessionCode, studentId, explanation } = payload;
      const session = sessions[sessionCode];
      if (!session) return;

      const curQ = getCurrentQuestion(sessionCode);
      if (!curQ) return;

      if (!curQ.answers[studentId]) {
        const stuInfo = session.students[studentId];
        if (!stuInfo) return;
        curQ.answers[studentId] = {
          username: stuInfo.username,
          mcqAnswer: null,
          explanation: ""
        };
      }
      curQ.answers[studentId].explanation = explanation;
      broadcastTeacherView(sessionCode);
    }
  });

  ws.on("close", () => {
    // optional cleanup
  });
});

// Keep connections alive for up to 60 minutes
const KEEP_ALIVE_INTERVAL = 30_000; // 30s
const MAX_DURATION = 60 * 60_000;   // 60 min
let totalUptime = 0;

const keepAliveInterval = setInterval(() => {
  totalUptime += KEEP_ALIVE_INTERVAL;
  if (totalUptime >= MAX_DURATION) {
    // forcibly close all websockets
    wss.clients.forEach((ws) => ws.close());
    clearInterval(keepAliveInterval);
    return;
  }

  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, KEEP_ALIVE_INTERVAL);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
