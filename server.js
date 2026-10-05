const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();

// Middleware pro zpracování POST dat z formulářů a JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- SUPABASE & MULTER CONFIG (PRO OBRÁZKY) ---
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} else {
  console.warn('⚠️ Supabase URL/KEY missing in environment variables!');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

function parseImages(text) {
  if (!text) return text;
  const regex = /\/img\s+"([^"]+)"/g;
  return text.replace(regex, '<img src="$1" style="max-width:100%; height:auto; border-radius:8px; margin:10px 0; display:block;" alt="User Uploaded Image">');
}

app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded.' });
    }

    if (!supabase) {
      return res.status(500).json({ error: 'Supabase client is not configured.' });
    }

    // Vytvoření unikátního názvu souboru (např. 1700000000-obrazek.png)
    const fileExt = req.file.originalname.split('.').pop();
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExt}`;
    const filePath = `forum-uploads/${fileName}`;

    // Upload do Supabase Storage bucketu 'forum-images'
    const { data, error } = await supabase.storage
      .from('forum-images')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: error.message });
    }

    // Získání veřejné URL adresy nahraného obrázku
    const { data: publicUrlData } = supabase.storage
      .from('forum-images')
      .getPublicUrl(filePath);

    return res.json({ imageUrl: publicUrlData.publicUrl });
  } catch (err) {
    console.error('Upload route error:', err);
    return res.status(500).json({ error: 'Server error during upload.' });
  }
});
// ----------------------------------------------

const BAD_WORDS = ['badword1', 'fuck', 'shit', 'bitch', 'asshole', 'crap', 'bastard', 'dick'];
const ALLOWED_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'black', 'grey', 'white', 'gold', 'lime', 'brown', 'lightblue', 'skyblue', 'maroon'];

function filterBadWords(text) {
  if (!text) return text;
  let filtered = text;
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '***');
  });
  return filtered;
}

// Převod @username na odkaz do profilu
function parseMentions(text) {
  if (!text) return text;
  // Najde @Slovo (podporuje písmena, čísla a podtržítka)
  const regex = /@([a-zA-Z0-9_]+)/g;
  return text.replace(regex, '<a href="/user/$1" class="mention-link">@$1</a>');
}

// Převod #ID na odkaz na otázku
function parseQuestionLinks(text) {
  if (!text) return text;
  // Najde #123 (pouze čísla)
  const regex = /#(\d+)/g;
  return text.replace(regex, '<a href="/questions/$1" class="question-link">#$1</a>');
}

function getRoleBadge(role) {
  if (role === 'moderator') return '👑 ';
  if (role === 'helper') return '🛡️ ';
  return '';
}

// Funkce pro převod /colortext "barva" "text" na HTML
function parseColorText(text) {
  if (!text) return text;
  const regex = /\/colortext\s+"([^"]+)"\s+"([^"]+)"/g;
  return text.replace(regex, (match, color, content) => {
    const lowerColor = color.toLowerCase();
    if (ALLOWED_COLORS.includes(lowerColor)) {
      const extraStyle = lowerColor === 'white' ? 'background: #333; padding: 2px 4px; border-radius: 4px;' : '';
      return `<span style="color: ${lowerColor}; ${extraStyle}">${content}</span>`;
    }
    return match;
  });
}

// Spojená funkce pro kompletní formátování textu (včetně obrázků)
function formatPostContent(text) {
  if (!text) return text;
  let formatted = parseColorText(text);
  formatted = parseMentions(formatted);
  formatted = parseQuestionLinks(formatted);
  formatted = parseImages(formatted); // Přidáno zpracování /img "URL"
  return formatted;
}

async function initDb() {
  try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      tag VARCHAR(100) DEFAULT '',
      tag_color VARCHAR(50) DEFAULT 'blue',
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';
  `);
} catch (err) {
  console.error("Error creating users table:", err);
}
    `);

    // Přidání sloupce pro accepted answer do otázek
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS accepted_answer_id INTEGER DEFAULT NULL;`);

    // Tabulka pro sledování upvotů (aby každý mohol hlasovat jen jednou)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        target_type VARCHAR(20) NOT NULL, -- 'question' nebo 'answer'
        target_id INTEGER NOT NULL,
        UNIQUE(user_id, target_type, target_id)
      );
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tag VARCHAR(100) DEFAULT '';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tag_color VARCHAR(50) DEFAULT 'blue';`);

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
    console.log('PostgreSQL Tables & Schema ready.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}
initDb();

// 1. Zásadní řádek pro Render (řekne Expressu, že běží za HTTPS proxy)
app.set('trust proxy', 1);

// 2. Správné nastavení session
app.use(session({
  secret: 'vassuperklic123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dní
    secure: process.env.NODE_ENV === 'production', // true na Renderu díky HTTPS
    sameSite: 'lax'
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAdmin = req.session.isAdmin || false;
  res.locals.formatPostContent = formatPostContent;
  res.locals.getRoleBadge = getRoleBadge;
  next();
});

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
// --- HLAVNÍ STRÁNKA & VYHLEDÁVÁNÍ ---
app.get('/', async (req, res) => {
  const search = req.query.search || '';
  try {
    const qRes = await pool.query(`
      SELECT 
        q.*, 
        u.username, 
        u.tag, 
        u.tag_color,
        (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) as answer_count,
        (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'question' AND v.target_id = q.id) as upvotes
      FROM questions q
      LEFT JOIN users u ON q.user_id = u.id
      WHERE q.title ILIKE $1 OR q.body ILIKE $1
      ORDER BY q.created_at DESC
    `, [`%${search}%`]);

    res.render('index', { 
      questions: qRes.rows || [], 
      user: req.session.user || null,
      isAdmin: req.session.isAdmin || false,
      search 
    });
  } catch (err) {
    res.status(500).send('Error loading forum: ' + err.message);
  }
});
// --- AUTENTIZACE ---
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
console.log('--- TEST REGISTRACE ---', req.body); // <-- ZDE PŘIDEJ TENTO ŘÁDEK
  const { username, pass, confirm_pass } = req.body;
  if (!username || !pass || !confirm_pass) return res.send('Fill all fields.');
  if (pass !== confirm_pass) return res.send('Passwords do not match!');

  try {
    const hash = await bcrypt.hash(pass, 10);
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hash]);
    res.redirect('/login');
  } catch (err) {
    if (err.code === '23505') return res.send('Username taken.');
    res.status(500).send('Registration error: ' + err.message);
  }
});

app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  console.log('--- TEST LOGIN ---', req.body);
  const username = req.body?.username;
  const password = req.body?.pass || req.body?.password;

  if (!username || !password) {
    return res.status(400).send('Please enter both username and password.');
  }

  try {
    const uRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = uRes.rows[0];

    if (user && await bcrypt.compare(password, user.password)) {
      // 1. Uložíme uživatele do session
      // Příklad při úspěšném přihlášení:
      req.session.user = {
        id: dbUser.id,
        username: dbUser.username,
        role: dbUser.role || 'user',
        tag: dbUser.tag,
        tag_color: dbUser.tag_color
      };
      req.session.isAdmin = user.is_admin ? true : false;
      
      // 2. Vynutíme uložení session PŘED přesměrováním
      return req.session.save((err) => {
        if (err) {
          console.error('Session save error:', err);
          return res.status(500).send('Session error.');
        }
        console.log('Session saved successfully for:', user.username);
        return res.redirect('/');
      });

    } else {
      return res.send('Invalid username or password.');
    }
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).send('Login error occurred: ' + err.message);
  }
});
// Route pro Upvote (Otázka i Odpověď)
app.post('/vote', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { target_type, target_id, question_id } = req.body;

  try {
    // Pokus o vložení hlasu
    await pool.query(
      'INSERT INTO votes (user_id, target_type, target_id) VALUES ($1, $2, $3)',
      [req.session.user.id, target_type, target_id]
    );
  } catch (err) {
    // Pokud už hlasoval, smažeme hlas (toggle / zrušení upvotu)
    if (err.code === '23505') {
      await pool.query(
        'DELETE FROM votes WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [req.session.user.id, target_type, target_id]
      );
    }
  }

  res.redirect(question_id ? `/questions/${question_id}` : '/');
});

// Route pro Označení Accepted Answer (Autor otázky nebo Mod)
app.post('/questions/:id/accept-answer', async (req, res) => {
  if (!req.session.user && !req.session.isAdmin) return res.redirect('/login');
  const questionId = req.params.id;
  const { answer_id } = req.body;

  try {
    const qRes = await pool.query('SELECT user_id, accepted_answer_id FROM questions WHERE id = $1', [questionId]);
    const question = qRes.rows[0];

    // Povoleno pouze autorovi otázky nebo modovi/adminovi
    if (req.session.isAdmin || (req.session.user && req.session.user.id === question.user_id)) {
      // Pokud už byla vybraná stejná odpověď, odznačíme ji (toggle)
      const newAccepted = question.accepted_answer_id == answer_id ? null : answer_id;
      await pool.query('UPDATE questions SET accepted_answer_id = $1 WHERE id = $2', [newAccepted, questionId]);
    }
    res.redirect(`/questions/${questionId}`);
  } catch (err) {
    res.status(500).send('Error marking answer: ' + err.message);
  }
});

// --- UŽIVATELSKÁ NASTAVENÍ ---
app.post('/user/update-pass', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { current_pass, new_pass } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const account = result.rows[0];

    const match = await bcrypt.compare(current_pass, account.password);
    if (!match) return res.send('Current password wrong.');

    const hash = await bcrypt.hash(new_pass, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.session.user.id]);
    res.redirect(`/user/${req.session.user.username}`);
  } catch (err) {
    res.status(500).send('Error updating: ' + err.message);
  }
});

app.post('/user/remove-account', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.body.confirm_name !== req.session.user.username) return res.send('Name mismatch.');

  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.session.user.id]);
    req.session.destroy();
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error removing account: ' + err.message);
  }
});

app.post('/user/update-tag', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  const { tag, tag_color } = req.body;
  const userId = req.session.user.id;
  const role = req.session.user.role;

  if (role === 'helper' || role === 'moderator') {
    await pool.query(
      'UPDATE users SET tag = $1, tag_color = $2 WHERE id = $3',
      [tag, tag_color, userId]
    );
  }
  res.redirect('/user/' + req.session.user.username);
});

// --- MODERACE & ADMIN PANEL ---
app.get('/mod', (req, res) => res.render('admin_login'));
app.post('/mod', (req, res) => {
  if (req.body.mod_pass === 'ForumModeration75') {
    req.session.isAdmin = true;
    res.redirect('/mod/dashboard');
  } else {
    res.send('Incorrect Password.');
  }
});

function isModerator(req, res, next) {
  if (req.session.user && req.session.user.role === 'moderator') {
    return next();
  }
  res.status(403).send('Access denied: Moderator role required.');
}

app.get('/admin', isModerator, async (req, res) => {
  // Načteme uživatele rozdělené podle rolí
  const mods = await pool.query("SELECT * FROM users WHERE role = 'moderator'");
  const helpers = await pool.query("SELECT * FROM users WHERE role = 'helper'");
  const regularUsers = await pool.query("SELECT * FROM users WHERE role = 'user' OR role IS NULL");

  res.render('admin', {
    moderators: mods.rows,
    helpers: helpers.rows,
    users: regularUsers.rows
  });
});

app.get('/mod/dashboard', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  try {
    const uRes = await pool.query('SELECT id, username, tag, tag_color, created_at FROM users ORDER BY id ASC');
    const qRes = await pool.query('SELECT q.id, q.title, u.username FROM questions q LEFT JOIN users u ON q.user_id = u.id ORDER BY q.id DESC');
    res.render('admin_dashboard', { users: uRes.rows || [], questions: qRes.rows || [] });
  } catch (err) {
    res.status(500).send('Mod Error: ' + err.message);
  }
});

// Reset hesla uživatele administrátorem
app.post('/mod/reset-user-pass', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id, new_pass } = req.body;
  if (!new_pass) return res.send('Password cannot be empty.');

  const hash = await bcrypt.hash(new_pass, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user_id]);
  res.redirect('/mod/dashboard');
});

// Nastavení tagu a barvy administrátorem
app.post('/mod/set-user-tag', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  const { user_id, tag, tag_color } = req.body;
  
  const selectedColor = ALLOWED_COLORS.includes(tag_color) ? tag_color : 'blue';
  await pool.query('UPDATE users SET tag = $1, tag_color = $2 WHERE id = $3', [tag.trim(), selectedColor, user_id]);
  res.redirect('/mod/dashboard');
});

app.post('/mod/remove-question', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  await pool.query('DELETE FROM questions WHERE id = $1', [req.body.question_id]);
  res.redirect('/mod/dashboard');
});

app.post('/mod/remove-user', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Access Denied');
  await pool.query('DELETE FROM users WHERE id = $1', [req.body.user_id]);
  res.redirect('/mod/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Přesměrování starých odkazů z /admin na /mod
app.get('/admin', (req, res) => res.redirect('/mod'));
app.get('/admin/dashboard', (req, res) => res.redirect('/mod/dashboard'));

// --- OTÁZKY & ODPOVĚDI ---
app.post('/questions', checkCooldown, async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { title, body } = req.body;
  title = filterBadWords(title);
  body = filterBadWords(body);
  await pool.query('INSERT INTO questions (title, body, user_id) VALUES ($1, $2, $3)', [title, body, req.session.user.id]);
  res.redirect('/');
});

app.get('/questions/:id', async (req, res) => {
  try {
    // Otázka + počet upvotů
    const qRes = await pool.query(`
      SELECT 
        q.*, 
        u.username, 
        u.tag, 
        u.tag_color,
        (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'question' AND v.target_id = q.id) as upvotes
      FROM questions q 
      LEFT JOIN users u ON q.user_id = u.id 
      WHERE q.id = $1
    `, [req.params.id]);

    const question = qRes.rows[0];
    if (!question) return res.status(404).send('Question not found.');

    // Odpovědi + počet upvotů
    const aRes = await pool.query(`
      SELECT 
        a.*, 
        u.username, 
        u.tag, 
        u.tag_color,
        (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'answer' AND v.target_id = a.id) as upvotes
      FROM answers a 
      LEFT JOIN users u ON a.user_id = u.id 
      WHERE a.question_id = $1 
      ORDER BY a.created_at ASC
    `, [req.params.id]);

    res.render('question', { 
      question, 
      answers: aRes.rows || [], 
      user: req.session.user || null,
      isAdmin: req.session.isAdmin || false,
      parseColorText // Pomocná funkce pro /colortext
    });
  } catch (err) {
    res.status(500).send('Error loading question: ' + err.message);
  }
});

app.post('/questions/remove', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    await pool.query('DELETE FROM questions WHERE id = $1 AND user_id = $2', [req.body.question_id, req.session.user.id]);
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error removing question: ' + err.message);
  }
});

app.post('/questions/:id/answers', checkCooldown, async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  let { body } = req.body;
  body = filterBadWords(body);
  await pool.query('INSERT INTO answers (question_id, user_id, body) VALUES ($1, $2, $3)', [req.params.id, req.session.user.id, body]);
  res.redirect(`/questions/${req.params.id}`);
});

app.post('/answers/remove', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    await pool.query('DELETE FROM answers WHERE id = $1 AND user_id = $2', [req.body.answer_id, req.session.user.id]);
    res.redirect(`/questions/${req.body.question_id}`);
  } catch (err) {
    res.status(500).send('Error removing answer: ' + err.message);
  }
});

// Pomocná kontrola teoretického "moderačního" práva
function isStaff(user) {
  return user && (user.role === 'moderator' || user.role === 'helper');
}

// Route pro smazání otázky
app.post('/questions/remove', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  const { question_id } = req.body;
  const user = req.session.user;

  // Ověříme, zda je uživatel autor NEBO má roli helper/moderator
  const q = await pool.query('SELECT user_id FROM questions WHERE id = $1', [question_id]);
  const isOwner = q.rows[0] && q.rows[0].user_id === user.id;

  if (isOwner || isStaff(user)) {
    await pool.query('DELETE FROM questions WHERE id = $1', [question_id]);
  }
  res.redirect('/');
});

app.get('/users/search', async (req, res) => {
  const query = req.query.q || '';
  try {
    let users = [];
    if (query.trim()) {
      const uRes = await pool.query(
        'SELECT id, username, tag, tag_color, created_at FROM users WHERE username ILIKE $1 ORDER BY username ASC LIMIT 20',
        [`%${query}%`]
      );
      users = uRes.rows;
    }
    res.render('user_search', { users, query });
  } catch (err) {
    res.status(500).send('Error searching users: ' + err.message);
  }
});

// --- PROFIL ---
app.get('/user/:username', async (req, res) => {
  try {
    const uRes = await pool.query('SELECT id, username, tag, tag_color, created_at FROM users WHERE username = $1', [req.params.username]);
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
app.listen(PORT, () => console.log(`Forum live on port ${PORT}`));
