const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Conecta ao PostgreSQL via variável de ambiente (Neon, Supabase, Railway, etc.)
const connString = process.env.NEON_URL || process.env.DB_URL || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: connString,
  ssl: connString && !connString.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

// Helpers para facilitar as queries
const queryAll = async (text, params = []) => (await pool.query(text, params)).rows;
const queryOne = async (text, params = []) => ((await pool.query(text, params)).rows)[0] || null;
const queryRun = async (text, params = []) => pool.query(text, params);

// ═══════════════════════════════════
// ═══  CREATE TABLES              ═══
// ═══════════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#FFD740',
      stock_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      pin TEXT,
      password TEXT,
      role TEXT NOT NULL DEFAULT 'vendedor',
      store_id TEXT DEFAULT 'all',
      active BOOLEAN DEFAULT true,
      avatar TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      ean TEXT,
      ref TEXT,
      category TEXT DEFAULT 'Camisetas',
      brand TEXT DEFAULT 'D''Black',
      supplier TEXT,
      size TEXT,
      color TEXT,
      price NUMERIC NOT NULL DEFAULT 0,
      cost NUMERIC NOT NULL DEFAULT 0,
      margin NUMERIC DEFAULT 0,
      min_stock INTEGER DEFAULT 10,
      img TEXT DEFAULT '👕',
      photo TEXT,
      variations TEXT DEFAULT '[]',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock (
      id SERIAL PRIMARY KEY,
      stock_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 0,
      UNIQUE(stock_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      stock_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT,
      from_store TEXT,
      to_store TEXT,
      user_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      cpf TEXT,
      whatsapp TEXT,
      birthdate TEXT,
      city TEXT,
      notes TEXT,
      tags TEXT DEFAULT '["Novo"]',
      points INTEGER DEFAULT 0,
      total_spent NUMERIC DEFAULT 0,
      visits INTEGER DEFAULT 0,
      last_visit TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      date TEXT NOT NULL,
      customer TEXT DEFAULT 'Avulso',
      customer_id TEXT,
      customer_whatsapp TEXT,
      seller TEXT,
      seller_id TEXT,
      items TEXT NOT NULL,
      subtotal NUMERIC DEFAULT 0,
      discount NUMERIC DEFAULT 0,
      discount_label TEXT,
      total NUMERIC NOT NULL,
      payment TEXT,
      payments TEXT,
      status TEXT DEFAULT 'Concluída',
      cupom TEXT,
      canceled_by TEXT,
      canceled_at TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      date TEXT NOT NULL,
      category TEXT,
      description TEXT,
      value NUMERIC NOT NULL,
      recurring BOOLEAN DEFAULT false,
      expense_type TEXT DEFAULT 'operacional',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_state (
      id SERIAL PRIMARY KEY,
      store_id TEXT NOT NULL UNIQUE,
      is_open BOOLEAN DEFAULT false,
      initial_value NUMERIC DEFAULT 500,
      opened_at TIMESTAMP,
      closed_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value NUMERIC NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cpf TEXT,
      role TEXT DEFAULT 'Vendedor',
      store_id TEXT,
      salary NUMERIC DEFAULT 0,
      pix TEXT,
      admission TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payrolls (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      emp_id TEXT NOT NULL,
      emp_name TEXT,
      emp_cpf TEXT,
      emp_role TEXT,
      emp_pix TEXT,
      store_id TEXT,
      store_name TEXT,
      base_salary NUMERIC DEFAULT 0,
      meta_bonus NUMERIC DEFAULT 0,
      awards NUMERIC DEFAULT 0,
      overtime NUMERIC DEFAULT 0,
      store_discount NUMERIC DEFAULT 0,
      advances NUMERIC DEFAULT 0,
      other_deductions NUMERIC DEFAULT 0,
      total_earnings NUMERIC DEFAULT 0,
      total_deductions NUMERIC DEFAULT 0,
      net_pay NUMERIC DEFAULT 0,
      paid BOOLEAN DEFAULT false,
      paid_date TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sellers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      commission NUMERIC DEFAULT 10,
      sales_count INTEGER DEFAULT 0,
      total_sold NUMERIC DEFAULT 0,
      avatar TEXT,
      store_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      date TEXT NOT NULL,
      customer TEXT,
      type TEXT DEFAULT 'Troca',
      reason TEXT,
      items TEXT,
      new_items TEXT,
      difference NUMERIC DEFAULT 0,
      cupom_original TEXT,
      status TEXT DEFAULT 'Concluída',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'percent',
      value NUMERIC DEFAULT 0,
      min_purchase NUMERIC DEFAULT 0,
      valid_until TEXT,
      active BOOLEAN DEFAULT true,
      usage_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS investments (
      id TEXT PRIMARY KEY,
      week TEXT,
      date TEXT NOT NULL,
      value NUMERIC NOT NULL,
      supplier TEXT,
      categories TEXT DEFAULT '[]',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_withdrawals (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      value NUMERIC NOT NULL,
      description TEXT,
      responsible TEXT,
      destination TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrações: adicionar colunas novas se não existirem
  await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_type TEXT DEFAULT 'operacional'`).catch(()=>{});
  await pool.query(`ALTER TABLE promos ADD COLUMN IF NOT EXISTS store_id TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE investments ADD COLUMN IF NOT EXISTS store_id TEXT`).catch(()=>{});

  // ─── ÍNDICES para performance em multi-loja ───
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_stock_movements_stock ON stock_movements(stock_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses(store_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_customers_cpf ON customers(cpf)',
    'CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)',
    'CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id)',
    'CREATE INDEX IF NOT EXISTS idx_payrolls_month ON payrolls(month)',
    'CREATE INDEX IF NOT EXISTS idx_payrolls_emp ON payrolls(emp_id)',
    'CREATE INDEX IF NOT EXISTS idx_cash_movements_store ON cash_movements(store_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_exchanges_store ON exchanges(store_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_withdrawals_store ON cash_withdrawals(store_id)',
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id)',
  ];
  for (const idx of indexes) {
    await pool.query(idx).catch(() => {});
  }

  // Seed categorias de despesas padrão
  const defExpCats = ['Aluguel','Energia','Água','Internet','Funcionários','Marketing','Manutenção','Material','Impostos','Transporte','Alimentação','Fornecedor','Outros'];
  for (const c of defExpCats) {
    await pool.query('INSERT INTO expense_categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
  }

  await seedIfEmpty();
  console.log('✅ Banco de dados inicializado!');
}

// ═══════════════════════════════════
// ═══  SEED DATA                  ═══
// ═══════════════════════════════════
async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM stores');
  if (parseInt(rows[0].c) > 0) return;

  console.log('🌱 Populando banco de dados...');

  await pool.query(`INSERT INTO stores VALUES
    ('loja1', 'D''Black Divino-MG', '#FFD740', 'loja1'),
    ('loja2', 'D''Black São João-MG', '#40C4FF', 'loja2'),
    ('loja3', 'D''Black Matriz', '#E040FB', 'shared_matriz'),
    ('loja4', 'D''Black E-commerce', '#00E676', 'shared_matriz')
  `);

  // Senhas com hash bcrypt para segurança
  const seedUsers = [
    ['u1', 'Denilson', 'denilson@dblack.com', 'admin123', 'admin', 'all', 'DN'],
    ['u2', 'Ana Beatriz', 'ana@dblack.com', 'ana123', 'gerente', 'loja1', 'AB'],
    ['u3', 'Carlos Silva', 'carlos@dblack.com', 'carlos123', 'vendedor', 'loja1', 'CS'],
    ['u4', 'Diego Ramos', 'diego@dblack.com', 'diego123', 'vendedor', 'loja2', 'DR'],
    ['u5', 'Fernanda Lima', 'fer@dblack.com', 'fer123', 'gerente', 'loja2', 'FL'],
    ['u6', 'Gabriel Costa', 'gab@dblack.com', 'gabriel123', 'gestor', 'all', 'GC'],
  ];
  for (const [id, name, email, pass, role, store, avatar] of seedUsers) {
    const hash = await bcrypt.hash(pass, 10);
    await pool.query(
      'INSERT INTO users (id, name, email, password, role, store_id, active, avatar) VALUES ($1,$2,$3,$4,$5,$6,true,$7)',
      [id, name, email, hash, role, store, avatar]
    );
  }

  const products = [
    ['p1','Camiseta Oversized Premium','CAM-001','7891234560011','REF-001','Camisetas',"D'Black",'SP Têxtil','M','Preto',149.90,45,232.0,10,'👕','["P","M","G","GG"]'],
    ['p2','Calça Cargo Streetwear','CAL-002','7891234560022','REF-002','Calças',"D'Black",'SP Têxtil','42','Verde Militar',279.90,95,194.6,8,'👖','["38","40","42","44","46"]'],
    ['p3','Jaqueta Corta-Vento','JAQ-003','7891234560033','REF-003','Jaquetas',"D'Black",'SP Têxtil','G','Preto',389.90,140,178.5,5,'🧥','["P","M","G","GG"]'],
    ['p4',"Boné Aba Reta D'Black",'BON-004','7891234560044','REF-004','Acessórios',"D'Black",'Acessórios Premium','Único','Preto/Dourado',89.90,22,308.6,15,'🧢','[]'],
    ['p5','Corrente Aço Cirúrgico','ACE-005','7891234560055','REF-005','Acessórios',"D'Black",'Acessórios Premium','60cm','Prata',129.90,35,271.1,10,'⛓️','["45cm","60cm"]'],
    ['p6','Tênis Urban Runner','TEN-006','7891234560066','REF-006','Calçados',"D'Black",'CalçaBR','42','Preto/Branco',459.90,180,155.5,6,'👟','["38","39","40","41","42","43","44"]'],
    ['p7',"Moletom Canguru D'Black",'MOL-007','7891234560077','REF-007','Moletons',"D'Black",'SP Têxtil','GG','Cinza Escuro',249.90,85,194.0,8,'🧶','["P","M","G","GG"]'],
    ['p8','Bermuda Jogger','BER-008','7891234560088','REF-008','Bermudas',"D'Black",'SP Têxtil','M','Preto',159.90,50,219.8,10,'🩳','["P","M","G","GG"]'],
    ['p9','Óculos de Sol Polarizado','OCU-009','7891234560099','REF-009','Acessórios',"D'Black",'Acessórios Premium','Único','Preto Fosco',199.90,60,233.2,8,'🕶️','[]'],
    ['p10','Relógio Digital Sport','REL-010','7891234560100','REF-010','Acessórios',"D'Black",'Acessórios Premium','Único','Preto/Dourado',349.90,120,191.6,5,'⌚','[]'],
  ];
  for (const p of products) {
    await pool.query(
      `INSERT INTO products (id,name,sku,ean,ref,category,brand,supplier,size,color,price,cost,margin,min_stock,img,variations,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
      p
    );
  }

  const stockData = [
    ['loja1','p1',38],['loja1','p2',22],['loja1','p3',5],['loja1','p4',45],['loja1','p5',30],
    ['loja1','p6',12],['loja1','p7',18],['loja1','p8',25],['loja1','p9',20],['loja1','p10',8],
    ['loja2','p1',25],['loja2','p2',15],['loja2','p3',8],['loja2','p4',30],['loja2','p5',20],
    ['loja2','p6',10],['loja2','p7',12],['loja2','p8',18],['loja2','p9',15],['loja2','p10',5],
    ['shared_matriz','p1',70],['shared_matriz','p2',46],['shared_matriz','p3',13],['shared_matriz','p4',85],['shared_matriz','p5',60],
    ['shared_matriz','p6',23],['shared_matriz','p7',35],['shared_matriz','p8',50],['shared_matriz','p9',34],['shared_matriz','p10',16],
  ];
  for (const [sid, pid, qty] of stockData) {
    await pool.query('INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1, $2, $3)', [sid, pid, qty]);
  }

  await pool.query(`INSERT INTO customers (id,name,phone,email,cpf,whatsapp,tags,points,total_spent,visits) VALUES
    ('c1','Maria Silva','(31) 99999-1111','maria@email.com','111.222.333-44','5531999991111','["VIP"]',250,4500,12),
    ('c2','João Santos','(31) 99999-2222','joao@email.com','222.333.444-55','5531999992222','["Frequente"]',180,3200,8),
    ('c3','Ana Costa','(31) 99999-3333','','','5531999993333','["Novo"]',50,890,3)
  `);

  for (const s of ['loja1','loja2','loja3','loja4']) {
    await pool.query('INSERT INTO cash_state (store_id, is_open, initial_value) VALUES ($1, false, 500)', [s]);
  }

  const cats = ['Camisetas','Calças','Jaquetas','Acessórios','Calçados','Moletons','Bermudas','Vestidos','Conjuntos','Bolsas'];
  for (const c of cats) {
    await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING', [c]);
  }

  await pool.query(`INSERT INTO employees (id,name,cpf,role,store_id,salary,pix,admission,active) VALUES
    ('emp1','Ana Beatriz','111.222.333-44','Gerente','loja1',3200,'ana@pix.com','2024-03-01',true),
    ('emp2','Carlos Silva','222.333.444-55','Vendedor','loja1',1800,'carlos@pix.com','2024-06-15',true),
    ('emp3','Diego Ramos','333.444.555-66','Vendedor','loja2',1800,'diego@pix.com','2025-01-10',true),
    ('emp4','Fernanda Lima','444.555.666-77','Gerente','loja2',3200,'fer@pix.com','2024-02-20',true)
  `);

  await pool.query(`INSERT INTO sellers (id,name,commission,sales_count,total_sold,avatar,store_id) VALUES
    ('u2','Ana Beatriz',10,15,6500,'AB','loja1'),
    ('u3','Carlos Silva',8,12,4800,'CS','loja1'),
    ('u4','Diego Ramos',8,10,3800,'DR','loja2'),
    ('u5','Fernanda Lima',10,18,7200,'FL','loja2')
  `);

  console.log('✅ Banco populado!');
}

module.exports = { queryAll, queryOne, queryRun, initDB, pool };
