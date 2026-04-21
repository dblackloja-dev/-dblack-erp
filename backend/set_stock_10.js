require('dotenv').config();
// database.js usa NEON_URL ou DB_URL — garante que DATABASE_URL funcione também
if (!process.env.NEON_URL && !process.env.DB_URL && process.env.DATABASE_URL) {
  process.env.NEON_URL = process.env.DATABASE_URL;
}
const { pool } = require('./database');

async function setStockTen() {
  console.log('📦 Ajustando estoque de todos os produtos para 10 unidades...\n');

  // Pega todos os produtos do banco
  const { rows: produtos } = await pool.query('SELECT id, name, sku FROM products ORDER BY name');

  if (produtos.length === 0) {
    console.log('⚠️  Nenhum produto encontrado no banco!');
    await pool.end();
    return;
  }

  // Pega os stock_ids distintos (loja1, loja2, shared_matriz)
  const { rows: estoques } = await pool.query('SELECT DISTINCT stock_id FROM stores');
  const stockIds = estoques.map(r => r.stock_id);

  console.log(`📋 Produtos encontrados: ${produtos.length}`);
  console.log(`🏪 Estoques: ${stockIds.join(', ')}\n`);

  let total = 0;

  for (const produto of produtos) {
    for (const stockId of stockIds) {
      await pool.query(`
        INSERT INTO stock (stock_id, product_id, quantity)
        VALUES ($1, $2, 10)
        ON CONFLICT (stock_id, product_id)
        DO UPDATE SET quantity = 10
      `, [stockId, produto.id]);
      total++;
    }
    console.log(`  ✅ ${produto.name} (${produto.sku}) → 10 unidades em cada estoque`);
  }

  console.log(`\n✅ Concluído! ${total} registros atualizados.`);
  console.log('💡 Recarregue o ERP no navegador para ver as mudanças.');

  await pool.end();
}

setStockTen().catch(e => {
  console.error('❌ Erro:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
