const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('forum.db');

// Seznam anglických sprostých slov pro filtr
const BAD_WORDS = ['badword1', 'fuck', 'shit', 'bitch', 'asshole', 'crap', 'bastard', 'dick'];

function filterBadWords(text) {
  if (!text) return text;
  let filtered = text;
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '***');
  });
  return filtered;
}

// Inicializace databáze
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      body TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER,
      user_id INTEGER,
      body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'build-logic-super-secret-key-12345',
  resave: false,
  saveUninitialized: false
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAdmin = req.session.isAdmin || false;
  next();
});

// Middleware pro Cooldown (15 sekund mezi příspěvky)
function checkCooldown(req, res, next) {
  const now = Date.now();
  const lastPost = req.session.lastPostTime || 0;
  if (now - lastPost < 15000) {
    const remaining = Math.ceil((15000 - (now - lastPost)) / 1000);
    return res.send(`Please wait ${remaining} seconds before posting again (Anti-Spam Cooldown).`);
  }
  req.session.lastPostTime = now;
  next();
}

// Hlavní stránka + Vyhledávání
app.get('/', (req, res) => {
  const search = req.query.search || '';
  let query = `
    SELECT q.*, u.username, COUNT(a.id) as answer_count 
    FROM questions q 
    LEFT JOIN users u ON q.user_id = u.id 
    LEFT JOIN answers a ON q.id = a.question_id
  `;
  let params = [];

  if (search) {
    query += ` WHERE q.title LIKE ? OR q.body LIKE ?`;
    params = [`%${search}%`, `%${search}%`];
  }

  query += ` GROUP BY q.id ORDER BY q.created_at DESC`;

  db.all(query, params, (err, questions) => {
    if (err) return res.status(500).send("Database error: " + err.message);
    res.render('index', { questions: questions || [], search });
  });
});

// Registrace (s 2x heslem)
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  const { username, password, confirm_password } = req.body;
  
  if (!username || !password || !confirm_password) {
    return res.send('Please fill in all fields.');
  }

  if (password !== confirm_password) {
    return res.send('Passwords do not match!');
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
      if (err) return res.send('Username is already taken.');
      res.redirect('/login');
    });
  } catch (err) {
    res.status(500).send('Error during registration: ' + err.message);
  }
});

// Přihlášení
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.send('Invalid username or password.');

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = { id: user.id, username: user.username };
      res.redirect('/');
    } else {
      res.send('Invalid username or password.');
    }
  });
});

// Admin Login (heslo: ForumModeration75)
app.get('/admin', (req, res) => res.render('admin_login'));
app.post('/admin', (req, res) => {
  const { admin_password } = req.body;
  if (admin_password === 'ForumModeration75') {
    req.session.isAdmin = true;
    res.redirect('/admin/dashboard');
  } else {
    res.send('Incorrect Admin Password.');
  }
});

// Admin Dashboard
app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');

  db.all('SELECT id, username, created_at FROM users', [], (err, users) => {
    db.all('SELECT q.id, q.title, u.username FROM questions q LEFT JOIN users u ON q.user_id = u.id', [], (err, questions) => {
      res.render('admin_dashboard', { users: users || [], questions: questions || [] });
    });
  });
});

// Admin - Smazat otázku
app.post('/admin/delete-question', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { question_id } = req.body;
  db.run('DELETE FROM questions WHERE id = ?', [question_id], () => {
    db.run('DELETE FROM answers WHERE question_id = ?', [question_id], () => {
      res.redirect('/admin/dashboard');
    });
  });
});

// Admin - Smazat odpověď
app.post('/admin/delete-answer', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { answer_id, question_id } = req.body;
  db.run('DELETE FROM answers WHERE id = ?', [answer_id], () => {
    res.redirect(`/questions/${question_id}`);
  });
});

// Admin - Smazat uživatele
app.post('/admin/delete-user', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id } = req.body;
  db.run('DELETE FROM users WHERE id = ?', [user_id], () => {
    db.run('DELETE FROM questions WHERE user_id = ?', [user_id], () => {
      db.run('DELETE FROM answers WHERE user_id = ?', [user_id], () => {
        res.redirect('/admin/dashboard');
      });
    });
  });
});

// Admin - Resetovat heslo uživatele
app.post('/admin/reset-password', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id, new_password } = req.body;
  const hashedPassword = await bcrypt.hash(new_password, 10);
  db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user_id], () => {
    res.redirect('/admin/dashboard');
  });
});

// Odhlášení
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Přidání otázky (s filtry a cooldownem)
app.post('/questions', checkCooldown, (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { title, body } = req.body;

  title = filterBadWords(title);
  body = filterBadWords(body);

  db.run('INSERT INTO questions (title, body, user_id) VALUES (?, ?, ?)', [title, body, req.session.user.id], (err) => {
    if (err) return res.status(500).send('Error saving question.');
    res.redirect('/');
  });
});

// Detail otázky
app.get('/questions/:id', (req, res) => {
  db.get('SELECT q.*, u.username FROM questions q LEFT JOIN users u ON q.user_id = u.id WHERE q.id = ?', [req.params.id], (err, question) => {
    if (err || !question) return res.status(404).send('Question not found.');

    db.all('SELECT a.*, u.username FROM answers a LEFT JOIN users u ON a.user_id = u.id WHERE a.question_id = ? ORDER BY a.created_at ASC', [req.params.id], (err, answers) => {
      res.render('question', { question, answers: answers || [] });
    });
  });
});

// Přidání odpovědi (s filtry a cooldownem)
app.post('/questions/:id/answers', checkCooldown, (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { body } = req.body;

  body = filterBadWords(body);

  db.run('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)', [req.params.id, req.session.user.id, body], (err) => {
    if (err) return res.status(500).send('Error saving answer.');
    res.redirect(`/questions/${req.params.id}`);
  });
});

// Uživatelský profil (zobrazení všech otázek a odpovědí uživatele)
app.get('/user/:username', (req, res) => {
  db.get('SELECT id, username, created_at FROM users WHERE username = ?', [req.params.username], (err, profileUser) => {
    if (err || !profileUser) return res.status(404).send('User not found.');

    db.all('SELECT * FROM questions WHERE user_id = ? ORDER BY created_at DESC', [profileUser.id], (err, questions) => {
      db.all('SELECT a.*, q.title as question_title FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.user_id = ? ORDER BY a.created_at DESC', [profileUser.id], (err, answers) => {
        res.render('profile', { profileUser, questions: questions || [], answers: answers || [] });
      });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Forum is running on port ${PORT}`));
