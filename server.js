const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('forum.db');

// Initialize Database Tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      body TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER,
      user_id INTEGER,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(question_id) REFERENCES questions(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
});

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

  if (search) {
    const query = `
      SELECT q.*, u.username, COUNT(a.id) as answer_count 
      FROM questions q 
      JOIN users u ON q.user_id = u.id 
      LEFT JOIN answers a ON q.id = a.question_id
      WHERE q.title LIKE ? OR q.body LIKE ?
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `;
    db.all(query, [`%${search}%`, `%${search}%`], (err, questions) => {
      if (err) return res.status(500).send('Database error.');
      res.render('index', { questions: questions || [], search });
    });
  } else {
    const query = `
      SELECT q.*, u.username, COUNT(a.id) as answer_count 
      FROM questions q 
      JOIN users u ON q.user_id = u.id 
      LEFT JOIN answers a ON q.id = a.question_id
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `;
    db.all(query, [], (err, questions) => {
      if (err) return res.status(500).send('Database error.');
      res.render('index', { questions: questions || [], search });
    });
  }
});

// User Registration
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send('Please provide username and password.');

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function(err) {
      if (err) {
        return res.send('Username is already taken.');
      }
      res.redirect('/login');
    });
  } catch (err) {
    res.status(500).send('Server error during registration.');
  }
});

// User Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) {
      return res.send('Invalid username or password.');
    }

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = { id: user.id, username: user.username };
      res.redirect('/');
    } else {
      res.send('Invalid username or password.');
    }
  });
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

  db.run('INSERT INTO questions (title, body, user_id) VALUES (?, ?, ?)', [title, body, req.session.user.id], (err) => {
    if (err) return res.status(500).send('Failed to post question.');
    res.redirect('/');
  });
});

// Question Details & Answers
app.get('/questions/:id', (req, res) => {
  const questionQuery = `
    SELECT q.*, u.username 
    FROM questions q 
    JOIN users u ON q.user_id = u.id 
    WHERE q.id = ?
  `;

  db.get(questionQuery, [req.params.id], (err, question) => {
    if (err || !question) return res.status(404).send('Question not found.');

    const answersQuery = `
      SELECT a.*, u.username 
      FROM answers a 
      JOIN users u ON a.user_id = u.id 
      WHERE a.question_id = ? 
      ORDER BY a.created_at ASC
    `;

    db.all(answersQuery, [req.params.id], (err, answers) => {
      if (err) return res.status(500).send('Error loading answers.');
      res.render('question', { question, answers: answers || [] });
    });
  });
});

// Post an Answer
app.post('/questions/:id/answers', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { body } = req.body;

  db.run('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)', [req.params.id, req.session.user.id, body], (err) => {
    if (err) return res.status(500).send('Failed to post answer.');
    res.redirect(`/questions/${req.params.id}`);
  });
});

// Cleanup inactive questions (e.g., older than 30 days with fewer than 2 answers)
app.post('/admin/cleanup', (req, res) => {
  if (!req.session.user) return res.status(403).send('Access denied.');

  const cleanupQuery = `
    DELETE FROM questions 
    WHERE created_at < datetime('now', '-30 days')
    AND id IN (
      SELECT q.id 
      FROM questions q 
      LEFT JOIN answers a ON q.id = a.question_id 
      GROUP BY q.id 
      HAVING COUNT(a.id) < 2
    )
  `;

  db.run(cleanupQuery, function(err) {
    if (err) return res.status(500).send('Cleanup failed.');
    res.send(`Cleaned up ${this.changes} inactive question(s).`);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Build Logic Forum is running on port ${PORT}`));
