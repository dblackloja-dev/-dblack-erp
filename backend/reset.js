require('dotenv').config();
const { pool } = require('./database');

async function reset() {
  console.log('🗑️  Limpando banco de dados...');

  await pool.query(`
    TRUNCATE TABLE
      stock_movements, stock, sales, expenses, customers,
      cash_movements, cash_state, employees, payrolls, sellers,
      exchanges, promos, investments, products, categories
    RESTART IDENTITY CASCADE;
  `);

  // Remove todos os usuários exceto Denilson
  await pool.query(`DELETE FROM users WHERE LOWER(name) != 'denilson'`);

  // Garante que Denilson existe com senha correta
  const exists = await pool.query(`SELECT id FROM users WHERE LOWER(name) = 'denilson'`);
  if (exists.rows.length === 0) {
    await pool.query(`
      INSERT INTO users (id, name, email, password, role, store_id, active, avatar)
      VALUES ('u1', 'Denilson', 'denilson@dblack.com', 'admin123', 'admin', 'all', true, 'DN')
    `);
    console.log('✅ Usuário Denilson criado');
  } else {
    console.log('✅ Usuário Denilson mantido');
  }

  // Recria o caixa das 4 lojas
  await pool.query(`
    INSERT INTO cash_state (store_id, is_open, initial_value) VALUES
      ('loja1', false, 500),
      ('loja2', false, 500),
      ('loja3', false, 500),
      ('loja4', false, 500)
    ON CONFLICT DO NOTHING;
  `);

  // Categorias padrão
  const cats = ['Camisetas','Calças','Jaquetas','Acessórios','Calçados','Moletons','Bermudas','Vestidos','Conjuntos','Bolsas'];
  for (const c of cats) {
    await pool.query(`INSERT INTO categories (name) VALUES ($1) ON CONFLICT DO NOTHING`, [c]);
  }

  console.log('✅ Banco resetado! Apenas Denilson permanece.');
  await pool.end();
}

reset().catch(e => { console.error('Erro:', e.message); process.exit(1); });
