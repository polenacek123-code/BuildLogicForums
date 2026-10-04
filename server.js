const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();

// Připojení k PostgreSQL databázi na Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Seznam anglických sprostých slov pro filtr
const BAD_WORDS = ['badword1', 'fuck', 'shit', 'bitch', 'asshole', 'crap', 'bastard', 'dick', 'motmot', 'nigger', 'nigga', 'idiot', 'dumbass', 'shitty', 'ass', 'sex', '67'];

function filterBadWords(text) {
  if (!text) return text;
  let filtered = text;
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '***');
  });
  return filtered;
}

// Inicializace databázových tabulek v PostgreSQL
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS answers (
        id SERIAL PRIMARY KEY,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('PostgreSQL Tables ready.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
}
initDb();

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

// Anti-Spam Cooldown (15s)
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
app.get('/', async (req, res) => {
  const search = req.query.search || '';
  try {
    let query = `
      SELECT q.*, u.username, COUNT(a.id) as answer_count 
      FROM questions q 
      LEFT JOIN users u ON q.user_id = u.id 
      LEFT JOIN answers a ON q.id = a.question_id
    `;
    let params = [];

    if (search) {
      query += ` WHERE q.title ILIKE $1 OR q.body ILIKE $1`;
      params.push(`%${search}%`);
    }

    query += ` GROUP BY q.id, u.username ORDER BY q.created_at DESC`;

    const result = await pool.query(query, params);
    res.render('index', { questions: result.rows || [], search });
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

// Registrace
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
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
    res.redirect('/login');
  } catch (err) {
    if (err.code === '23505') {
      return res.send('Username is already taken.');
    }
    res.status(500).send('Error during registration: ' + err.message);
  }
});

// Přihlášení
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) return res.send('Invalid username or password.');

    const match = await bcrypt.compare(password, user.password);
    if (match) {
      req.session.user = { id: user.id, username: user.username };
      res.redirect('/');
    } else {
      res.send('Invalid username or password.');
    }
  } catch (err) {
    res.status(500).send('Login error: ' + err.message);
  }
});

// Admin Portal
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
app.get('/admin/dashboard', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');

  try {
    const usersRes = await pool.query('SELECT id, username, created_at FROM users ORDER BY id ASC');
    const questionsRes = await pool.query('SELECT q.id, q.title, u.username FROM questions q LEFT JOIN users u ON q.user_id = u.id ORDER BY q.id DESC');
    res.render('admin_dashboard', { users: usersRes.rows || [], questions: questionsRes.rows || [] });
  } catch (err) {
    res.status(500).send('Admin Error: ' + err.message);
  }
});

// Admin Akce
app.post('/admin/delete-question', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { question_id } = req.body;
  await pool.query('DELETE FROM questions WHERE id = $1', [question_id]);
  res.redirect('/admin/dashboard');
});

app.post('/admin/delete-answer', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { answer_id, question_id } = req.body;
  await pool.query('DELETE FROM answers WHERE id = $1', [answer_id]);
  res.redirect(`/questions/${question_id}`);
});

app.post('/admin/delete-user', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id } = req.body;
  await pool.query('DELETE FROM users WHERE id = $1', [user_id]);
  res.redirect('/admin/dashboard');
});

app.post('/admin/reset-password', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id, new_password } = req.body;
  const hashedPassword = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user_id]);
  res.redirect('/admin/dashboard');
});

// Odhlášení
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Přidání otázky
app.post('/questions', checkCooldown, async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { title, body } = req.body;

  title = filterBadWords(title);
  body = filterBadWords(body);

  try {
    await pool.query('INSERT INTO questions (title, body, user_id) VALUES ($1, $2, $3)', [title, body, req.session.user.id]);
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error saving question: ' + err.message);
  }
});

// Detail otázky
app.get('/questions/:id', async (req, res) => {
  try {
    const qRes = await pool.query('SELECT q.*, u.username FROM questions q LEFT JOIN users u ON q.user_id = u.id WHERE q.id = $1', [req.params.id]);
    const question = qRes.rows[0];

    if (!question) return res.status(404).send('Question not found.');

    const aRes = await pool.query('SELECT a.*, u.username FROM answers a LEFT JOIN users u ON a.user_id = u.id WHERE a.question_id = $1 ORDER BY a.created_at ASC', [req.params.id]);
    res.render('question', { question, answers: aRes.rows || [] });
  } catch (err) {
    res.status(500).send('Error loading question: ' + err.message);
  }
});

// Odpověď
app.post('/questions/:id/answers', checkCooldown, async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { body } = req.body;

  body = filterBadWords(body);

  try {
    await pool.query('INSERT INTO answers (question_id, user_id, body) VALUES ($1, $2, $3)', [req.params.id, req.session.user.id, body]);
    res.redirect(`/questions/${req.params.id}`);
  } catch (err) {
    res.status(500).send('Error saving answer: ' + err.message);
  }
});

// Uživatelský profil
app.get('/user/:username', async (req, res) => {
  try {
    const uRes = await pool.query('SELECT id, username, created_at FROM users WHERE username = $1', [req.params.username]);
    const profileUser = uRes.rows[0];

    if (!profileUser) return res.status(404).send('User not found.');

    const qRes = await pool.query('SELECT * FROM questions WHERE user_id = $1 ORDER BY created_at DESC', [profileUser.id]);
    const aRes = await pool.query('SELECT a.*, q.title as question_title FROM answers a JOIN questions q ON a.question_id = q.id WHERE a.user_id = $1 ORDER BY a.created_at DESC', [profileUser.id]);

    res.render('profile', { profileUser, questions: qRes.rows || [], answers: aRes.rows || [] });
  } catch (err) {
    res.status(500).send('Profile error: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Build Logic Forum is live on port ${PORT}`));
