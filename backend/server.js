const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const { queryAll, queryOne, queryRun, initDB, pool } = require('./database');
const app = express();
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.resolve(__dirname, process.env.UPLOAD_DIR || '../uploads');
// JWT_SECRET DEVE ser definido no .env — sem fallback inseguro
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ERRO: JWT_SECRET não está definido no .env! O servidor não pode iniciar sem ele.');
  process.exit(1);
}

// Garante que a pasta de uploads existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// CORS — lista fixa de origens permitidas (definir no .env separado por vírgula)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',').map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ─── AUTH MIDDLEWARE ───
const authMiddleware = (req, res, next) => {
  if (req.path === '/auth/login') return next();
  if (req.path === '/auth/verify') return next();
  if (req.path === '/qz-cert' || req.path === '/qz-sign') return next();
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token necessário' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};
app.use('/api', authMiddleware);

// ─── RBAC MIDDLEWARE — controle de permissão por role ───
// Roles: admin > gestor > gerente > vendedor
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Sem permissão para esta ação' });
  }
  next();
};

// Multer — upload de fotos de produtos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `product-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
    cb(ok ? null : new Error('Apenas imagens!'), ok);
  }
});

// Helpers
const genId = () => uuidv4().split('-')[0] + Date.now().toString(36).slice(-4);
const today = () => new Date().toISOString().split('T')[0];
const now = () => new Date().toISOString();

// ═══════════════════════════════════════════
// ═══  STORES                             ═══
// ═══════════════════════════════════════════
app.get('/api/stores', async (req, res) => {
  try {
    const stores = await queryAll('SELECT * FROM stores');
    res.json(stores);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  AUTH / USERS                       ═══
// ═══════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = await queryOne(
      `SELECT * FROM users WHERE (LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1)) AND active = true`,
      [login]
    );
    if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    let valid = false;
    if (user.password?.startsWith('$2')) {
      // Senha já com bcrypt
      valid = await bcrypt.compare(password, user.password);
    } else {
      // Senha em texto puro (legado) — valida e já atualiza para bcrypt
      valid = user.password === password || user.pin === password;
      if (valid) {
        const hash = await bcrypt.hash(password, 10);
        await queryRun('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
      }
    }

    if (!valid) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role, store_id: user.store_id },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    const { password: _p, pin: _pin, ...safeUser } = user;
    res.json({ ...safeUser, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verifica se uma senha pertence a um usuário com permissão de cancelar
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.json({ authorized: false });
    const users = await queryAll(`SELECT * FROM users WHERE active = true AND role IN ('admin','gestor','gerente')`);
    for (const u of users) {
      let valid = false;
      if (u.password?.startsWith('$2')) {
        valid = await bcrypt.compare(password, u.password);
      } else {
        valid = u.password === password || u.pin === password;
      }
      if (valid) {
        const { password: _p, pin: _pin, ...safeUser } = u;
        return res.json({ authorized: true, user: safeUser });
      }
    }
    res.json({ authorized: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Retorna o usuário autenticado pelo token
app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1 AND active = true', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    const { password: _p, pin: _pin, ...safeUser } = user;
    res.json(safeUser);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await queryAll('SELECT id, name, email, role, store_id, active, avatar, created_at FROM users ORDER BY name');
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { name, email, password, pin, role, store_id, avatar } = req.body;
    const id = genId();
    const rawPass = password || pin || 'mudar123';
    const hash = await bcrypt.hash(rawPass, 10);
    await queryRun(
      'INSERT INTO users (id, name, email, password, role, store_id, avatar) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, name, email || '', hash, role || 'vendedor', store_id || 'all', avatar || name.slice(0, 2).toUpperCase()]
    );
    res.json({ id, name, email, role, store_id, active: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { name, email, password, pin, role, store_id, active, avatar } = req.body;
    const rawPass = password || pin;
    let hash = undefined;
    if (rawPass && !rawPass.startsWith('$2')) {
      hash = await bcrypt.hash(rawPass, 10);
    }
    if (hash) {
      await queryRun(
        'UPDATE users SET name=$1, email=$2, password=$3, role=$4, store_id=$5, active=$6, avatar=$7 WHERE id=$8',
        [name, email || '', hash, role, store_id, active !== false, avatar, req.params.id]
      );
    } else {
      await queryRun(
        'UPDATE users SET name=$1, email=$2, role=$3, store_id=$4, active=$5, avatar=$6 WHERE id=$7',
        [name, email || '', role, store_id, active !== false, avatar, req.params.id]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir seu próprio usuário' });
    await queryRun('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  PRODUCTS                           ═══
// ═══════════════════════════════════════════
app.get('/api/products', async (req, res) => {
  try {
    const products = await queryAll('SELECT * FROM products ORDER BY created_at DESC');
    products.forEach(p => {
      try { p.variations = JSON.parse(p.variations || '[]'); } catch { p.variations = []; }
    });
    res.json(products);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const p = req.body;
    const id = p.id || genId();
    const margin = p.cost > 0 ? ((p.price - p.cost) / p.cost * 100) : 0;
    const vars = JSON.stringify(p.variations || []);
    await queryRun(
      `INSERT INTO products (id, name, sku, ean, ref, category, brand, supplier, size, color, price, cost, margin, min_stock, img, photo, variations, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, p.name, p.sku, p.ean || '', p.ref || '', p.category || 'Camisetas', p.brand || "D'Black",
       p.supplier || '', p.size || '', p.color || '', p.price, p.cost, margin, p.min_stock || 10,
       p.img || '👕', p.photo || '', vars, p.active !== false]
    );

    // Inicializa estoque em todos os stock_ids
    const stores = await queryAll('SELECT DISTINCT stock_id FROM stores');
    for (const s of stores) {
      await queryRun(
        'INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1,$2,0) ON CONFLICT DO NOTHING',
        [s.stock_id, id]
      );
    }

    res.json({ id, ...p, margin, variations: p.variations || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const p = req.body;
    const margin = p.cost > 0 ? ((p.price - p.cost) / p.cost * 100) : 0;
    const vars = JSON.stringify(p.variations || []);
    await queryRun(
      `UPDATE products SET name=$1, sku=$2, ean=$3, ref=$4, category=$5, brand=$6, supplier=$7, size=$8, color=$9,
       price=$10, cost=$11, margin=$12, min_stock=$13, img=$14, photo=$15, variations=$16, active=$17, updated_at=NOW() WHERE id=$18`,
      [p.name, p.sku, p.ean || '', p.ref || '', p.category, p.brand, p.supplier || '', p.size || '',
       p.color || '', p.price, p.cost, margin, p.min_stock || 10, p.img || '👕', p.photo || '', vars, p.active !== false, req.params.id]
    );
    res.json({ success: true, margin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await queryRun('UPDATE products SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload de foto
app.post('/api/products/:id/photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    const photoUrl = `/uploads/${req.file.filename}`;
    await queryRun('UPDATE products SET photo = $1 WHERE id = $2', [photoUrl, req.params.id]);
    res.json({ photo: photoUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  CATEGORIES                         ═══
// ═══════════════════════════════════════════
app.get('/api/categories', async (req, res) => {
  try {
    const rows = await queryAll('SELECT name FROM categories ORDER BY name');
    res.json(rows.map(c => c.name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', async (req, res) => {
  try {
    await queryRun('INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.name]);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: 'Categoria já existe' }); }
});

app.delete('/api/categories/:name', async (req, res) => {
  try {
    await queryRun('DELETE FROM categories WHERE name = $1', [req.params.name]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  STOCK                              ═══
// ═══════════════════════════════════════════
app.get('/api/stock', async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM stock');
    const result = {};
    rows.forEach(r => {
      if (!result[r.stock_id]) result[r.stock_id] = {};
      result[r.stock_id][r.product_id] = r.quantity;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stock/:stockId', async (req, res) => {
  try {
    const rows = await queryAll('SELECT product_id, quantity FROM stock WHERE stock_id = $1', [req.params.stockId]);
    const result = {};
    rows.forEach(r => { result[r.product_id] = r.quantity; });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync em massa — recebe todo o estoque de uma vez
app.post('/api/stock/bulk', async (req, res) => {
  try {
    const { stock } = req.body; // { stockId: { productId: qty, ... }, ... }
    let count = 0;
    for (const [stockId, products] of Object.entries(stock)) {
      for (const [productId, quantity] of Object.entries(products)) {
        await queryRun(
          'INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (stock_id, product_id) DO UPDATE SET quantity = $3',
          [stockId, productId, quantity]
        );
        count++;
      }
    }
    res.json({ success: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stock/:stockId/:productId', async (req, res) => {
  try {
    const { quantity, delta, type, reason, user_name } = req.body;
    const { stockId, productId } = req.params;

    if (delta !== undefined) {
      await queryRun(
        'UPDATE stock SET quantity = GREATEST(0, quantity + $1) WHERE stock_id = $2 AND product_id = $3',
        [delta, stockId, productId]
      );
    } else {
      await queryRun(
        'INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (stock_id, product_id) DO UPDATE SET quantity = $3',
        [stockId, productId, quantity]
      );
    }

    if (type) {
      await queryRun(
        'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [genId(), stockId, productId, type, Math.abs(delta ?? quantity), reason || '', user_name || '']
      );
    }

    const current = await queryOne('SELECT quantity FROM stock WHERE stock_id = $1 AND product_id = $2', [stockId, productId]);
    res.json({ quantity: current?.quantity || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stock/transfer', async (req, res) => {
  const client = await pool.connect();
  try {
    const { fromStockId, toStockId, productId, quantity, user_name } = req.body;

    await client.query('BEGIN');

    // Trava a linha de estoque para evitar race condition
    const { rows } = await client.query(
      'SELECT quantity FROM stock WHERE stock_id = $1 AND product_id = $2 FOR UPDATE',
      [fromStockId, productId]
    );
    if (!rows[0] || rows[0].quantity < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Estoque insuficiente' });
    }

    await client.query('UPDATE stock SET quantity = quantity - $1 WHERE stock_id = $2 AND product_id = $3', [quantity, fromStockId, productId]);
    await client.query(
      'INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1,$2,$3) ON CONFLICT (stock_id, product_id) DO UPDATE SET quantity = stock.quantity + $3',
      [toStockId, productId, quantity]
    );

    await client.query(
      'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, from_store, to_store, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [genId(), fromStockId, productId, 'transfer_out', quantity, 'Transferência', fromStockId, toStockId, user_name || '']
    );
    await client.query(
      'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, from_store, to_store, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [genId(), toStockId, productId, 'transfer_in', quantity, 'Transferência', fromStockId, toStockId, user_name || '']
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/stock/movements/:stockId', async (req, res) => {
  try {
    const movements = await queryAll(
      'SELECT * FROM stock_movements WHERE stock_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.stockId]
    );
    res.json(movements);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  SALES                              ═══
// ═══════════════════════════════════════════
app.get('/api/sales', async (req, res) => {
  try {
    const { store_id } = req.query;
    const sales = store_id
      ? await queryAll('SELECT * FROM sales WHERE store_id = $1 ORDER BY created_at DESC', [store_id])
      : await queryAll('SELECT * FROM sales ORDER BY created_at DESC');
    sales.forEach(s => {
      try { s.items = JSON.parse(s.items); } catch { s.items = []; }
      try { s.payments = JSON.parse(s.payments || '[]'); } catch { s.payments = []; }
    });
    res.json(sales);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sales', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = req.body;
    const id = s.id || genId();

    await client.query('BEGIN');

    // Verifica e baixa estoque dentro da transação
    if (s.items && s.stock_id) {
      for (const item of s.items) {
        const { rows } = await client.query(
          'SELECT quantity FROM stock WHERE stock_id = $1 AND product_id = $2 FOR UPDATE',
          [s.stock_id, item.id]
        );
        if (rows[0] && rows[0].quantity < item.qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Estoque insuficiente para "${item.name || item.id}". Disponível: ${rows[0].quantity}, Solicitado: ${item.qty}` });
        }
      }
      for (const item of s.items) {
        await client.query(
          'UPDATE stock SET quantity = quantity - $1 WHERE stock_id = $2 AND product_id = $3',
          [item.qty, s.stock_id, item.id]
        );
      }
    }

    await client.query(
      `INSERT INTO sales (id, store_id, date, customer, customer_id, customer_whatsapp, seller, seller_id, items, subtotal, discount, discount_label, total, payment, payments, status, cupom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, s.store_id, s.date || today(), s.customer || 'Avulso', s.customer_id || '',
       s.customer_whatsapp || '', s.seller || '', s.seller_id || '',
       JSON.stringify(s.items), s.subtotal || 0, s.discount || 0, s.discount_label || '',
       s.total, s.payment || '', JSON.stringify(s.payments || []), s.status || 'Concluída', s.cupom || '']
    );

    await client.query('COMMIT');
    res.json({ id, ...s });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.put('/api/sales/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, payment, payments, canceled_by, canceled_at } = req.body;

    // Se está cancelando, devolver itens ao estoque
    if (status === 'Cancelada') {
      const sale = await client.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
      if (sale.rows[0] && sale.rows[0].status !== 'Cancelada') {
        await client.query('BEGIN');
        const saleData = sale.rows[0];
        const items = JSON.parse(saleData.items || '[]');
        // Busca o stock_id da loja
        const store = await client.query('SELECT stock_id FROM stores WHERE id = $1', [saleData.store_id]);
        const stockId = store.rows[0]?.stock_id || saleData.store_id;

        for (const item of items) {
          await client.query(
            'UPDATE stock SET quantity = quantity + $1 WHERE stock_id = $2 AND product_id = $3',
            [item.qty, stockId, item.id]
          );
          await client.query(
            'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [genId(), stockId, item.id, 'devolucao_cancelamento', item.qty, `Cancelamento da venda ${req.params.id}`, canceled_by || '']
          );
        }

        await client.query(
          'UPDATE sales SET status=$1, payment=$2, payments=$3, canceled_by=$4, canceled_at=$5 WHERE id=$6',
          [status, payment || '', JSON.stringify(payments || []), canceled_by || '', canceled_at || '', req.params.id]
        );
        await client.query('COMMIT');
        client.release();
        return res.json({ success: true });
      }
    }

    // Atualização normal (sem cancelamento)
    await client.query(
      'UPDATE sales SET status=$1, payment=$2, payments=$3, canceled_by=$4, canceled_at=$5 WHERE id=$6',
      [status, payment || '', JSON.stringify(payments || []), canceled_by || '', canceled_at || '', req.params.id]
    );
    client.release();
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// ═══  CUSTOMERS                          ═══
// ═══════════════════════════════════════════
app.get('/api/customers', async (req, res) => {
  try {
    const customers = await queryAll('SELECT * FROM customers ORDER BY name');
    customers.forEach(c => {
      try { c.tags = JSON.parse(c.tags || '[]'); } catch { c.tags = []; }
    });
    res.json(customers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers', async (req, res) => {
  try {
    const c = req.body;
    const id = c.id || genId();
    await queryRun(
      `INSERT INTO customers (id, name, phone, email, cpf, whatsapp, city, notes, tags, points, total_spent, visits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, c.name, c.phone || '', c.email || '', c.cpf || '', c.whatsapp || '', c.city || '',
       c.notes || '', JSON.stringify(c.tags || ['Novo']), c.points || 0, c.total_spent || 0, c.visits || 0]
    );
    res.json({ id, ...c, tags: c.tags || ['Novo'] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/customers/:id', async (req, res) => {
  try {
    const c = req.body;
    await queryRun(
      `UPDATE customers SET name=$1, phone=$2, email=$3, cpf=$4, whatsapp=$5, city=$6, notes=$7, tags=$8, points=$9, total_spent=$10, visits=$11 WHERE id=$12`,
      [c.name, c.phone || '', c.email || '', c.cpf || '', c.whatsapp || '', c.city || '',
       c.notes || '', JSON.stringify(c.tags || []), c.points || 0, c.total_spent || 0, c.visits || 0, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  EXPENSES                           ═══
// ═══════════════════════════════════════════
app.get('/api/expenses', async (req, res) => {
  try {
    const { store_id } = req.query;
    const expenses = store_id
      ? await queryAll('SELECT * FROM expenses WHERE store_id = $1 ORDER BY date DESC', [store_id])
      : await queryAll('SELECT * FROM expenses ORDER BY date DESC');
    res.json(expenses);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const e = req.body;
    const id = genId();
    await queryRun(
      'INSERT INTO expenses (id, store_id, date, category, description, value, recurring, expense_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, e.store_id, e.date || today(), e.category || '', e.description || '', e.value, e.recurring || false, e.expense_type || 'operacional']
    );
    res.json({ id, ...e });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const e = req.body;
    await queryRun(
      'UPDATE expenses SET date=$1, category=$2, description=$3, value=$4, recurring=$5, expense_type=$6 WHERE id=$7',
      [e.date, e.category || '', e.description || '', e.value, e.recurring || false, e.expense_type || 'operacional', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await queryRun('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Expense Categories ──
app.get('/api/expense-categories', async (req, res) => {
  try {
    const cats = await queryAll('SELECT * FROM expense_categories ORDER BY name');
    res.json(cats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expense-categories', async (req, res) => {
  try {
    await queryRun('INSERT INTO expense_categories (name) VALUES ($1)', [req.body.name]);
    res.json({ success: true, name: req.body.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expense-categories/:name', async (req, res) => {
  try {
    await queryRun('DELETE FROM expense_categories WHERE name = $1', [decodeURIComponent(req.params.name)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  CASH                               ═══
// ═══════════════════════════════════════════
app.get('/api/cash/:storeId', async (req, res) => {
  try {
    const state = await queryOne('SELECT * FROM cash_state WHERE store_id = $1', [req.params.storeId]);
    const movements = await queryAll('SELECT * FROM cash_movements WHERE store_id = $1 ORDER BY created_at DESC', [req.params.storeId]);
    res.json({ state: state || { store_id: req.params.storeId, is_open: false, initial_value: 500 }, movements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cash/:storeId', async (req, res) => {
  try {
    const { action, value, description, type } = req.body;
    const storeId = req.params.storeId;

    if (action === 'open') {
      await queryRun('UPDATE cash_state SET is_open = true, initial_value = $1, opened_at = NOW() WHERE store_id = $2', [value || 500, storeId]);
    } else if (action === 'close') {
      await queryRun('UPDATE cash_state SET is_open = false, closed_at = NOW() WHERE store_id = $1', [storeId]);
    } else if (action === 'movement') {
      await queryRun(
        'INSERT INTO cash_movements (id, store_id, type, value, description) VALUES ($1,$2,$3,$4,$5)',
        [genId(), storeId, type || 'entrada', value, description || '']
      );
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  CASH WITHDRAWALS (Retiradas)       ═══
// ═══════════════════════════════════════════
app.get('/api/withdrawals', async (req, res) => {
  try {
    const storeId = req.query.store_id;
    const withdrawals = storeId
      ? await queryAll('SELECT * FROM cash_withdrawals WHERE store_id = $1 ORDER BY created_at DESC', [storeId])
      : await queryAll('SELECT * FROM cash_withdrawals ORDER BY created_at DESC');
    res.json(withdrawals);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdrawals', async (req, res) => {
  try {
    const w = req.body;
    const id = genId();
    await queryRun(
      'INSERT INTO cash_withdrawals (id, store_id, value, description, responsible, destination) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, w.store_id, w.value, w.description || '', w.responsible || '', w.destination || '']
    );

    // Registra a saída no caixa para que o saldo seja atualizado
    await queryRun(
      'INSERT INTO cash_movements (id, store_id, type, value, description) VALUES ($1,$2,$3,$4,$5)',
      [genId(), w.store_id, 'saida', w.value, `Retirada: ${w.description || 'Sem descrição'} (${w.responsible || ''})`.trim()]
    );

    res.json({ id, ...w, created_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/withdrawals/:id', async (req, res) => {
  try {
    await queryRun('DELETE FROM cash_withdrawals WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  CASH ADVANCES (Vales)              ═══
// ═══════════════════════════════════════════
app.get('/api/advances', async (req, res) => {
  try {
    const storeId = req.query.store_id;
    const month = req.query.month;
    let q = 'SELECT * FROM cash_advances';
    const params = [];
    const conditions = [];
    if (storeId) { conditions.push('store_id = $' + (params.length + 1)); params.push(storeId); }
    if (month) { conditions.push('month = $' + (params.length + 1)); params.push(month); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ' ORDER BY created_at DESC';
    const advances = await queryAll(q, params);
    res.json(advances);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/advances', async (req, res) => {
  try {
    const a = req.body;
    const id = genId();
    const month = a.month || new Date().toISOString().slice(0, 7);
    await queryRun(
      'INSERT INTO cash_advances (id, store_id, emp_id, emp_name, value, description, authorized_by, month) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, a.store_id, a.emp_id, a.emp_name, a.value, a.description || '', a.authorized_by || '', month]
    );

    // Registra saída no caixa
    await queryRun(
      'INSERT INTO cash_movements (id, store_id, type, value, description) VALUES ($1,$2,$3,$4,$5)',
      [genId(), a.store_id, 'saida', a.value, `Vale: ${a.emp_name} - ${a.description || 'Adiantamento'}`]
    );

    res.json({ id, ...a, month, created_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/advances/:id', async (req, res) => {
  try {
    await queryRun('DELETE FROM cash_advances WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Soma de vales por colaborador/mês (para folha de pagamento)
app.get('/api/advances/summary', async (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: 'Informe o mês (month=YYYY-MM)' });
    const summary = await queryAll(
      'SELECT emp_id, emp_name, SUM(value) as total FROM cash_advances WHERE month = $1 GROUP BY emp_id, emp_name',
      [month]
    );
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  EMPLOYEES                          ═══
// ═══════════════════════════════════════════
app.get('/api/employees', async (req, res) => {
  try {
    const employees = await queryAll('SELECT * FROM employees ORDER BY name');
    res.json(employees);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/employees', requireRole('admin', 'gestor', 'gerente'), async (req, res) => {
  try {
    const e = req.body;
    const id = genId();
    await queryRun(
      'INSERT INTO employees (id, name, cpf, role, store_id, salary, pix, admission, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)',
      [id, e.name, e.cpf || '', e.role || 'Vendedor', e.store_id, e.salary || 0, e.pix || '', e.admission || today()]
    );
    res.json({ id, ...e, active: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/employees/:id', async (req, res) => {
  try {
    const e = req.body;
    await queryRun(
      'UPDATE employees SET name=$1, cpf=$2, role=$3, store_id=$4, salary=$5, pix=$6, admission=$7, active=$8 WHERE id=$9',
      [e.name, e.cpf || '', e.role, e.store_id, e.salary || 0, e.pix || '', e.admission || '', e.active !== false, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/employees/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await queryRun('DELETE FROM employees WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  PAYROLLS                           ═══
// ═══════════════════════════════════════════
app.get('/api/payrolls', async (req, res) => {
  try {
    const payrolls = await queryAll('SELECT * FROM payrolls ORDER BY created_at DESC');
    res.json(payrolls);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payrolls', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const p = req.body;
    const id = genId();
    await queryRun(
      `INSERT INTO payrolls (id, month, emp_id, emp_name, emp_cpf, emp_role, emp_pix, store_id, store_name,
       base_salary, meta_bonus, awards, overtime, store_discount, advances, other_deductions,
       total_earnings, total_deductions, net_pay, paid, paid_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, p.month, p.emp_id, p.emp_name || '', p.emp_cpf || '', p.emp_role || '', p.emp_pix || '',
       p.store_id || '', p.store_name || '', p.base_salary || 0, p.meta_bonus || 0, p.awards || 0,
       p.overtime || 0, p.store_discount || 0, p.advances || 0, p.other_deductions || 0,
       p.total_earnings || 0, p.total_deductions || 0, p.net_pay || 0, p.paid || false, p.paid_date || null, p.notes || '']
    );
    res.json({ id, ...p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/payrolls/:id', async (req, res) => {
  try {
    const p = req.body;
    await queryRun(
      `UPDATE payrolls SET month=$1, emp_name=$2, emp_cpf=$3, emp_role=$4, emp_pix=$5,
       store_id=$6, store_name=$7, base_salary=$8, meta_bonus=$9, awards=$10, overtime=$11,
       store_discount=$12, advances=$13, other_deductions=$14,
       total_earnings=$15, total_deductions=$16, net_pay=$17, notes=$18 WHERE id=$19`,
      [p.month, p.emp_name || '', p.emp_cpf || '', p.emp_role || '', p.emp_pix || '',
       p.store_id || '', p.store_name || '', p.base_salary || 0, p.meta_bonus || 0, p.awards || 0,
       p.overtime || 0, p.store_discount || 0, p.advances || 0, p.other_deductions || 0,
       p.total_earnings || 0, p.total_deductions || 0, p.net_pay || 0, p.notes || '', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/payrolls/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await queryRun('DELETE FROM payrolls WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  SELLERS                            ═══
// ═══════════════════════════════════════════
app.get('/api/sellers', async (req, res) => {
  try {
    const sellers = await queryAll('SELECT * FROM sellers ORDER BY total_sold DESC');
    res.json(sellers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sellers/:id', async (req, res) => {
  try {
    await queryRun('UPDATE sellers SET commission = $1 WHERE id = $2', [req.body.commission, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  EXCHANGES                          ═══
// ═══════════════════════════════════════════
app.get('/api/exchanges', async (req, res) => {
  try {
    const { store_id } = req.query;
    const exchanges = store_id
      ? await queryAll('SELECT * FROM exchanges WHERE store_id = $1 ORDER BY created_at DESC', [store_id])
      : await queryAll('SELECT * FROM exchanges ORDER BY created_at DESC');
    exchanges.forEach(e => {
      try { e.items = JSON.parse(e.items || '[]'); } catch { e.items = []; }
      try { e.new_items = JSON.parse(e.new_items || '[]'); } catch { e.new_items = []; }
    });
    res.json(exchanges);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchanges', async (req, res) => {
  const client = await pool.connect();
  try {
    const e = req.body;
    const id = genId();

    await client.query('BEGIN');

    // Busca o stock_id da loja
    const storeResult = await client.query('SELECT stock_id FROM stores WHERE id = $1', [e.store_id]);
    const stockId = storeResult.rows[0]?.stock_id || e.store_id;

    // Devolve itens trocados ao estoque (entrada)
    if (e.items && e.items.length > 0) {
      for (const item of e.items) {
        await client.query(
          'UPDATE stock SET quantity = quantity + $1 WHERE stock_id = $2 AND product_id = $3',
          [item.qty || 1, stockId, item.id]
        );
        await client.query(
          'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [genId(), stockId, item.id, 'troca_entrada', item.qty || 1, `Troca ${id} - devolução`, '']
        );
      }
    }

    // Baixa novos itens do estoque (saída)
    if (e.new_items && e.new_items.length > 0) {
      for (const item of e.new_items) {
        await client.query(
          'UPDATE stock SET quantity = GREATEST(0, quantity - $1) WHERE stock_id = $2 AND product_id = $3',
          [item.qty || 1, stockId, item.id]
        );
        await client.query(
          'INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [genId(), stockId, item.id, 'troca_saida', item.qty || 1, `Troca ${id} - novo item`, '']
        );
      }
    }

    await client.query(
      `INSERT INTO exchanges (id, store_id, date, customer, type, reason, items, new_items, difference, cupom_original, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, e.store_id, e.date || today(), e.customer || '', e.type || 'Troca', e.reason || '',
       JSON.stringify(e.items || []), JSON.stringify(e.new_items || []), e.difference || 0, e.cupom_original || '', 'Concluída']
    );

    await client.query('COMMIT');
    res.json({ id, ...e });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/exchanges/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    await queryRun('UPDATE exchanges SET status = $1 WHERE id = $2', ['Cancelada', id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  PROMOS                             ═══
// ═══════════════════════════════════════════
app.get('/api/promos', async (req, res) => {
  try {
    const promos = await queryAll('SELECT * FROM promos ORDER BY created_at DESC');
    res.json(promos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/promos', async (req, res) => {
  try {
    const p = req.body;
    const id = genId();
    await queryRun(
      'INSERT INTO promos (id, name, type, value, min_purchase, valid_until, active, usage_count) VALUES ($1,$2,$3,$4,$5,$6,true,0)',
      [id, p.name, p.type || 'percent', p.value, p.min_purchase || 0, p.valid_until || '']
    );
    res.json({ id, ...p, active: true, usage_count: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/promos/:id', async (req, res) => {
  try {
    await queryRun('UPDATE promos SET active = $1 WHERE id = $2', [req.body.active !== false, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  INVESTMENTS                        ═══
// ═══════════════════════════════════════════
app.get('/api/investments', async (req, res) => {
  try {
    const investments = await queryAll('SELECT * FROM investments ORDER BY date DESC');
    investments.forEach(i => {
      try { i.categories = JSON.parse(i.categories || '[]'); } catch { i.categories = []; }
    });
    res.json(investments);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/investments', async (req, res) => {
  try {
    const i = req.body;
    const id = genId();
    await queryRun(
      'INSERT INTO investments (id, week, date, value, supplier, categories, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, i.week || '', i.date || today(), i.value, i.supplier || '', JSON.stringify(i.categories || []), i.notes || '']
    );
    res.json({ id, ...i });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ═══  START SERVER                       ═══
// ═══════════════════════════════════════════
// Health check (sem autenticação)
// ── QZ Tray: chave privada e certificado lidos dos arquivos .pem ──

app.post('/api/qz-sign', (req, res) => {
  try {
    const { data } = req.body;
    // Tenta variável de ambiente primeiro (produção), fallback para arquivo (local)
    let privateKey = process.env.QZ_PRIVATE_KEY;
    if (!privateKey) {
      privateKey = fs.readFileSync(path.join(__dirname, 'qz-private.pem'), 'utf8');
    }
    const sign = require('crypto').createSign('SHA1');
    sign.update(data);
    const signature = sign.sign(privateKey, 'base64');
    res.json({ signature });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qz-cert', (req, res) => {
  try {
    const cert = fs.readFileSync(path.join(__dirname, 'qz-certificate.pem'), 'utf8');
    res.type('text/plain').send(cert);
  } catch(e) { res.status(500).json({ error: 'Certificado não encontrado' }); }
});

// ═══════════════════════════════════════════
// ═══  BLACK IA — AGENTE DE SUPORTE       ═══
// ═══════════════════════════════════════════

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Rate limiter simples (em memória)
const agentLimits = {};
function checkAgentLimit(userId) {
  const now = Date.now();
  if (!agentLimits[userId] || agentLimits[userId].resetAt < now) {
    agentLimits[userId] = { count: 0, resetAt: now + 60000 };
  }
  agentLimits[userId].count++;
  return agentLimits[userId].count <= 20; // máx 20 msgs/min
}

// ─── Definição das ferramentas do agente ───
const AGENT_TOOLS = [
  {
    name: 'consultar_caixa',
    description: 'Consulta o estado do caixa (aberto/fechado, saldo, movimentações) de uma loja',
    input_schema: {
      type: 'object',
      properties: { store_id: { type: 'string', description: 'ID da loja (loja1, loja2, loja3, loja4)' } },
      required: ['store_id']
    }
  },
  {
    name: 'abrir_caixa',
    description: 'Abre o caixa de uma loja com um valor inicial. SEMPRE peça confirmação antes.',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: 'ID da loja' },
        valor_inicial: { type: 'number', description: 'Valor inicial do caixa em reais' }
      },
      required: ['store_id', 'valor_inicial']
    }
  },
  {
    name: 'fechar_caixa',
    description: 'Fecha o caixa de uma loja. SEMPRE peça confirmação antes.',
    input_schema: {
      type: 'object',
      properties: { store_id: { type: 'string', description: 'ID da loja' } },
      required: ['store_id']
    }
  },
  {
    name: 'registrar_movimento_caixa',
    description: 'Registra uma entrada (suprimento) ou saída (sangria) no caixa. SEMPRE peça confirmação antes.',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: 'ID da loja' },
        tipo: { type: 'string', enum: ['entrada', 'saida'], description: 'Tipo: entrada (suprimento) ou saida (sangria)' },
        valor: { type: 'number', description: 'Valor em reais' },
        descricao: { type: 'string', description: 'Motivo do movimento' }
      },
      required: ['store_id', 'tipo', 'valor']
    }
  },
  {
    name: 'consultar_vendas',
    description: 'Lista as vendas de uma loja, opcionalmente filtrando por data',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: 'ID da loja' },
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD (opcional, padrão=hoje)' },
        limite: { type: 'number', description: 'Quantidade máxima de vendas (padrão=20)' }
      },
      required: ['store_id']
    }
  },
  {
    name: 'consultar_venda_por_id',
    description: 'Busca os detalhes completos de uma venda específica pelo ID ou cupom',
    input_schema: {
      type: 'object',
      properties: { busca: { type: 'string', description: 'ID da venda ou número do cupom' } },
      required: ['busca']
    }
  },
  {
    name: 'cancelar_venda',
    description: 'Cancela uma venda e devolve os itens ao estoque. Ação CRÍTICA — exige confirmação do usuário.',
    input_schema: {
      type: 'object',
      properties: {
        venda_id: { type: 'string', description: 'ID da venda a cancelar' },
        motivo: { type: 'string', description: 'Motivo do cancelamento' }
      },
      required: ['venda_id']
    }
  },
  {
    name: 'consultar_estoque',
    description: 'Consulta o estoque de um produto em uma ou todas as lojas',
    input_schema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Nome ou SKU do produto' },
        stock_id: { type: 'string', description: 'ID do estoque (loja1, loja2, shared_matriz). Se vazio, mostra todos.' }
      },
      required: ['busca']
    }
  },
  {
    name: 'buscar_cliente',
    description: 'Busca um cliente pelo nome, telefone ou CPF',
    input_schema: {
      type: 'object',
      properties: { busca: { type: 'string', description: 'Nome, telefone ou CPF do cliente' } },
      required: ['busca']
    }
  },
  {
    name: 'notificar_denilson',
    description: 'Escala um problema para o Denilson (dono). Use quando não conseguir resolver o problema.',
    input_schema: {
      type: 'object',
      properties: {
        resumo: { type: 'string', description: 'Resumo do problema' },
        urgencia: { type: 'string', enum: ['baixa', 'media', 'alta'], description: 'Nível de urgência' }
      },
      required: ['resumo', 'urgencia']
    }
  }
];

// ─── Executor das ferramentas ───
async function executeTool(toolName, input, user) {
  switch (toolName) {
    case 'consultar_caixa': {
      const state = await queryOne('SELECT * FROM cash_state WHERE store_id=$1', [input.store_id]);
      const movements = await queryAll('SELECT * FROM cash_movements WHERE store_id=$1 ORDER BY created_at DESC LIMIT 20', [input.store_id]);
      const totalEntradas = movements.filter(m => m.type === 'entrada').reduce((s, m) => s + parseFloat(m.value || 0), 0);
      const totalSaidas = movements.filter(m => m.type === 'saida').reduce((s, m) => s + parseFloat(m.value || 0), 0);
      const saldo = parseFloat(state?.initial_value || 0) + totalEntradas - totalSaidas;
      return { estado: state?.is_open ? 'aberto' : 'fechado', valor_inicial: state?.initial_value, saldo_estimado: saldo, aberto_em: state?.opened_at, movimentacoes_recentes: movements.slice(0, 10) };
    }
    case 'abrir_caixa': {
      const current = await queryOne('SELECT * FROM cash_state WHERE store_id=$1', [input.store_id]);
      if (current?.is_open) return { erro: 'Caixa já está aberto!' };
      await queryRun('UPDATE cash_state SET is_open=true, initial_value=$1, opened_at=NOW() WHERE store_id=$2', [input.valor_inicial, input.store_id]);
      return { sucesso: true, mensagem: `Caixa aberto com R$${input.valor_inicial}` };
    }
    case 'fechar_caixa': {
      const current = await queryOne('SELECT * FROM cash_state WHERE store_id=$1', [input.store_id]);
      if (!current?.is_open) return { erro: 'Caixa já está fechado!' };
      await queryRun('UPDATE cash_state SET is_open=false, closed_at=NOW() WHERE store_id=$1', [input.store_id]);
      return { sucesso: true, mensagem: 'Caixa fechado com sucesso' };
    }
    case 'registrar_movimento_caixa': {
      const id = uuidv4().split('-')[0] + Date.now().toString(36).slice(-4);
      await queryRun('INSERT INTO cash_movements (id, store_id, type, value, description, created_at) VALUES ($1,$2,$3,$4,$5,NOW())', [id, input.store_id, input.tipo, input.valor, input.descricao || '']);
      return { sucesso: true, mensagem: `${input.tipo === 'entrada' ? 'Suprimento' : 'Sangria'} de R$${input.valor} registrado` };
    }
    case 'consultar_vendas': {
      const data = input.data || new Date().toISOString().split('T')[0];
      const limit = input.limite || 20;
      const vendas = await queryAll('SELECT id, date, customer, seller, total, discount, status, payment, cupom, created_at FROM sales WHERE store_id=$1 AND date=$2 ORDER BY created_at DESC LIMIT $3', [input.store_id, data, limit]);
      return { data, total_vendas: vendas.length, valor_total: vendas.filter(v => v.status !== 'Cancelada').reduce((s, v) => s + parseFloat(v.total || 0), 0), vendas };
    }
    case 'consultar_venda_por_id': {
      let venda = await queryOne('SELECT * FROM sales WHERE id=$1', [input.busca]);
      if (!venda) venda = await queryOne('SELECT * FROM sales WHERE cupom=$1', [input.busca]);
      if (!venda) return { erro: 'Venda não encontrada' };
      try { venda.items = JSON.parse(venda.items); } catch { venda.items = []; }
      try { venda.payments = JSON.parse(venda.payments || '[]'); } catch { venda.payments = []; }
      return venda;
    }
    case 'cancelar_venda': {
      // Verifica permissão do usuário
      if (!['admin', 'gestor', 'gerente'].includes(user.role)) {
        return { erro: 'Sem permissão. Peça a um gerente ou admin para autorizar.' };
      }
      const venda = await queryOne('SELECT * FROM sales WHERE id=$1', [input.venda_id]);
      if (!venda) return { erro: 'Venda não encontrada' };
      if (venda.status === 'Cancelada') return { erro: 'Esta venda já foi cancelada' };
      // Cancela e devolve estoque
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE sales SET status=$1, canceled_by=$2, canceled_at=$3 WHERE id=$4', ['Cancelada', user.name, new Date().toISOString(), input.venda_id]);
        const items = JSON.parse(venda.items || '[]');
        const store = await queryOne('SELECT stock_id FROM stores WHERE id=$1', [venda.store_id]);
        const stockId = store?.stock_id || venda.store_id;
        for (const item of items) {
          await client.query('UPDATE stock SET quantity = quantity + $1 WHERE stock_id=$2 AND product_id=$3', [item.qty, stockId, item.id]);
          await client.query('INSERT INTO stock_movements (id, stock_id, product_id, type, quantity, reason, user_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())', [uuidv4().split('-')[0], stockId, item.id, 'devolucao_cancelamento', item.qty, input.motivo || 'Cancelamento via Black IA', user.name]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return { sucesso: true, mensagem: `Venda ${input.venda_id} cancelada. ${JSON.parse(venda.items || '[]').length} item(ns) devolvidos ao estoque.` };
    }
    case 'consultar_estoque': {
      const produtos = await queryAll("SELECT id, name, sku, price FROM products WHERE active=true AND (LOWER(name) LIKE $1 OR LOWER(sku) LIKE $1) LIMIT 5", ['%' + input.busca.toLowerCase() + '%']);
      if (produtos.length === 0) return { erro: 'Nenhum produto encontrado' };
      const resultado = [];
      for (const p of produtos) {
        const estoques = input.stock_id
          ? await queryAll('SELECT stock_id, quantity FROM stock WHERE product_id=$1 AND stock_id=$2', [p.id, input.stock_id])
          : await queryAll('SELECT stock_id, quantity FROM stock WHERE product_id=$1', [p.id]);
        resultado.push({ produto: p.name, sku: p.sku, preco: p.price, estoques: estoques.map(e => ({ loja: e.stock_id, quantidade: e.quantity })) });
      }
      return resultado;
    }
    case 'buscar_cliente': {
      const clientes = await queryAll("SELECT id, name, phone, email, cpf, whatsapp, points, total_spent, visits FROM customers WHERE LOWER(name) LIKE $1 OR phone LIKE $1 OR cpf LIKE $1 LIMIT 5", ['%' + input.busca.toLowerCase() + '%']);
      return clientes.length > 0 ? clientes : { erro: 'Nenhum cliente encontrado' };
    }
    case 'notificar_denilson': {
      // Salva alerta especial no log
      await queryRun('INSERT INTO agent_logs (id, conversation_id, user_id, user_name, store_id, role, content, tool_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())', [uuidv4().split('-')[0], 'alerts', user.id, user.name, user.store_id, 'alert', JSON.stringify({ resumo: input.resumo, urgencia: input.urgencia, solicitante: user.name }), 'notificar_denilson']);
      return { sucesso: true, mensagem: `Alerta enviado para o Denilson (urgência: ${input.urgencia}). Ele será notificado assim que possível.` };
    }
    default:
      return { erro: 'Ferramenta desconhecida' };
  }
}

// ─── System prompt do agente ───
function buildSystemPrompt(user) {
  return `Você é a Black IA, assistente de suporte inteligente da D'Black Store.
Você ajuda os funcionários a resolver problemas com caixa, vendas e estoque.

SOBRE VOCÊ:
- Seu nome é Black IA
- Você é amigável, direto e eficiente
- Sempre fale em português brasileiro
- Use as ferramentas disponíveis para consultar dados reais — NUNCA invente

USUÁRIO ATUAL:
- Nome: ${user.name}
- Cargo: ${user.role}
- Loja: ${user.store_id}
- Data/hora: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

LOJAS:
- loja1 = D'Black Divino-MG
- loja2 = D'Black São João-MG
- loja3 = D'Black Matriz
- loja4 = D'Black E-commerce
- Loja3 e loja4 compartilham estoque "shared_matriz"

REGRAS IMPORTANTES:
1. Para QUALQUER ação que modifica dados (abrir/fechar caixa, sangria, cancelar venda), SEMPRE explique o que vai fazer e peça confirmação ANTES de usar a ferramenta
2. Se o usuário confirmar (sim, confirma, pode fazer, etc.), aí sim execute a ação
3. Se o usuário for "vendedor", ele NÃO pode cancelar vendas — oriente a chamar um gerente
4. Se não conseguir resolver um problema, use a ferramenta notificar_denilson
5. Seja breve nas respostas — os funcionários estão atendendo clientes
6. Quando mostrar valores, use formato brasileiro (R$ 1.234,56)

PROBLEMAS COMUNS QUE VOCÊ RESOLVE:
- Caixa não abre / não fecha → consulte o estado e oriente
- Diferença no caixa → consulte movimentações e identifique o problema
- Precisa cancelar venda → verifique a venda e cancele (se tiver permissão)
- Dúvida sobre estoque → consulte o estoque do produto
- Cliente quer trocar produto → oriente o passo a passo no sistema`;
}

// ─── Endpoint principal do chat ───
app.post('/api/agent/chat', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'Agente não configurado (ANTHROPIC_API_KEY ausente)' });
  if (!checkAgentLimit(req.user.id)) return res.status(429).json({ error: 'Muitas mensagens. Aguarde 1 minuto.' });

  try {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });

    // Pega ou cria conversa
    let convId = conversationId;
    if (!convId) {
      convId = uuidv4().split('-')[0] + Date.now().toString(36).slice(-4);
      await queryRun('INSERT INTO agent_conversations (id, user_id, user_name, store_id) VALUES ($1,$2,$3,$4)', [convId, req.user.id, req.user.name, req.user.store_id]);
    } else {
      await queryRun('UPDATE agent_conversations SET last_message_at=NOW() WHERE id=$1', [convId]);
    }

    // Loga mensagem do usuário
    await queryRun('INSERT INTO agent_logs (id, conversation_id, user_id, user_name, store_id, role, content) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv4().split('-')[0] + Date.now().toString(36).slice(-4), convId, req.user.id, req.user.name, req.user.store_id, 'user', message]);

    // Carrega histórico da conversa (últimas 20 mensagens)
    const history = await queryAll("SELECT role, content, tool_name, tool_input, tool_output FROM agent_logs WHERE conversation_id=$1 AND role IN ('user','assistant','tool_call','tool_result') ORDER BY created_at ASC", [convId]);

    // Monta mensagens para a API Claude
    const messages = [];
    for (const h of history) {
      if (h.role === 'user') {
        messages.push({ role: 'user', content: h.content });
      } else if (h.role === 'assistant') {
        messages.push({ role: 'assistant', content: h.content });
      }
    }
    // Garante que a última mensagem do usuário está incluída
    if (messages.length === 0 || messages[messages.length - 1].content !== message) {
      messages.push({ role: 'user', content: message });
    }

    // Chama Claude com loop de ferramentas (máx 5 iterações)
    let finalResponse = '';
    let currentMessages = [...messages];
    for (let i = 0; i < 5; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(req.user),
        tools: AGENT_TOOLS,
        messages: currentMessages,
      });

      // Verifica se tem tool_use
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');

      if (toolUseBlocks.length === 0) {
        // Sem ferramentas — resposta final
        finalResponse = textBlocks.map(b => b.text).join('\n');
        break;
      }

      // Executa cada ferramenta
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        // Loga a chamada da ferramenta
        await queryRun('INSERT INTO agent_logs (id, conversation_id, user_id, user_name, store_id, role, tool_name, tool_input) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv4().split('-')[0] + Date.now().toString(36).slice(-4), convId, req.user.id, req.user.name, req.user.store_id, 'tool_call', toolBlock.name, JSON.stringify(toolBlock.input)]);

        // Executa
        let result;
        try {
          result = await executeTool(toolBlock.name, toolBlock.input, req.user);
        } catch (err) {
          result = { erro: err.message };
        }

        // Loga o resultado
        await queryRun('INSERT INTO agent_logs (id, conversation_id, user_id, user_name, store_id, role, tool_name, tool_output) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv4().split('-')[0] + Date.now().toString(36).slice(-4), convId, req.user.id, req.user.name, req.user.store_id, 'tool_result', toolBlock.name, JSON.stringify(result)]);

        toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: JSON.stringify(result) });
      }

      // Adiciona a resposta do assistente e os resultados das ferramentas
      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });
    }

    // Loga resposta final do assistente
    if (finalResponse) {
      await queryRun('INSERT INTO agent_logs (id, conversation_id, user_id, user_name, store_id, role, content) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv4().split('-')[0] + Date.now().toString(36).slice(-4), convId, req.user.id, req.user.name, req.user.store_id, 'assistant', finalResponse]);
    }

    res.json({ conversationId: convId, message: finalResponse });
  } catch (e) {
    console.error('[Black IA] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao processar mensagem: ' + e.message });
  }
});

// ─── Histórico de conversas (admin) ───
app.get('/api/agent/conversations', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const convs = await queryAll('SELECT * FROM agent_conversations ORDER BY last_message_at DESC LIMIT 50');
    res.json(convs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/conversations/:id/logs', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const logs = await queryAll('SELECT * FROM agent_logs WHERE conversation_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Alertas pendentes (admin) ───
app.get('/api/agent/alerts', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const alerts = await queryAll("SELECT * FROM agent_logs WHERE tool_name='notificar_denilson' ORDER BY created_at DESC LIMIT 20");
    res.json(alerts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch(e) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: e.message, time: new Date().toISOString() });
  }
});

// Inicia o servidor imediatamente e tenta conectar ao banco
app.listen(PORT, () => {
  console.log(`D'BLACK ERP rodando na porta ${PORT}`);
});

initDB().then(() => {
  console.log('✅ Banco de dados conectado!');
}).catch(err => {
  console.error('❌ Falha ao inicializar banco:', err.message);
  // Não encerra o servidor — continua respondendo às requisições
});
