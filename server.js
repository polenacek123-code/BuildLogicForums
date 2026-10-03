const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('forum.db');

// Initialize Database Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER,
    user_id INTEGER,
    body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(question_id) REFERENCES questions(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'build-logic-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Pass user context to EJS templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Home Page & Search
app.get('/', (req, res) => {
  const search = req.query.search || '';
  let questions;

  if (search) {
    const stmt = db.prepare(`
      SELECT q.*, u.username, COUNT(a.id) as answer_count 
      FROM questions q 
      JOIN users u ON q.user_id = u.id 
      LEFT JOIN answers a ON q.id = a.question_id
      WHERE q.title LIKE ? OR q.body LIKE ?
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `);
    questions = stmt.all(`%${search}%`, `%${search}%`);
  } else {
    const stmt = db.prepare(`
      SELECT q.*, u.username, COUNT(a.id) as answer_count 
      FROM questions q 
      JOIN users u ON q.user_id = u.id 
      LEFT JOIN answers a ON q.id = a.question_id
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `);
    questions = stmt.all();
  }

  res.render('index', { questions, search });
});

// User Registration
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    stmt.run(username, hashedPassword);
    res.redirect('/login');
  } catch (err) {
    res.send('Username is already taken.');
  }
});

// User Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);

  if (user && await bcrypt.compare(password, user.password)) {
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/');
  } else {
    res.send('Invalid username or password.');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Post a new question
app.post('/questions', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { title, body } = req.body;
  const stmt = db.prepare('INSERT INTO questions (title, body, user_id) VALUES (?, ?, ?)');
  stmt.run(title, body, req.session.user.id);
  res.redirect('/');
});

// Question Details & Answers
app.get('/questions/:id', (req, res) => {
  const questionStmt = db.prepare(`
    SELECT q.*, u.username 
    FROM questions q 
    JOIN users u ON q.user_id = u.id 
    WHERE q.id = ?
  `);
  const question = questionStmt.get(req.params.id);

  if (!question) return res.status(404).send('Question not found.');

  const answersStmt = db.prepare(`
    SELECT a.*, u.username 
    FROM answers a 
    JOIN users u ON a.user_id = u.id 
    WHERE a.question_id = ? 
    ORDER BY a.created_at ASC
  `);
  const answers = answersStmt.all(req.params.id);

  res.render('question', { question, answers });
});

// Post an Answer
app.post('/questions/:id/answers', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { body } = req.body;
  const stmt = db.prepare('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)');
  stmt.run(req.params.id, req.session.user.id, body);
  res.redirect(`/questions/${req.params.id}`);
});

// Cleanup inactive questions (e.g., older than 30 days with fewer than 2 answers)
app.post('/admin/cleanup', (req, res) => {
  if (!req.session.user) return res.status(403).send('Access denied.');

  const deleteStmt = db.prepare(`
    DELETE FROM questions 
    WHERE created_at < datetime('now', '-30 days')
    AND id IN (
      SELECT q.id 
      FROM questions q 
      LEFT JOIN answers a ON q.id = a.question_id 
      GROUP BY q.id 
      HAVING COUNT(a.id) < 2
    )
  `);

  const result = deleteStmt.run();
  res.send(`Cleaned up ${result.changes} inactive question(s).`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Build Logic Forum is running on port ${PORT}`));
