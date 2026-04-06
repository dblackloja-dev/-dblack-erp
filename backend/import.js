require('dotenv').config();
const { pool } = require('./database');
const XLSX = require('xlsx');
const path = require('path');

const FILE = path.join(process.env.USERPROFILE || 'C:/Users/win', 'Downloads', 'ok pro.xlsx');

async function main() {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  console.log('Total de produtos na planilha:', rows.length);

  const stockIds = ['loja1', 'loja2', 'shared_matriz'];
  let ok = 0, skip = 0;

  for (const row of rows) {
    const nome = String(row['Nome'] || '').trim();
    const sku  = String(row['SKU']  || '').trim();
    if (!nome || !sku) { skip++; continue; }

    const cat    = String(row['Categoria'] || 'Outros').trim();
    const preco  = parseFloat(String(row['Preco_Venda'] || '0').replace(',', '.')) || 0;
    const custo  = parseFloat(String(row['Preco_Custo'] || '0').replace(',', '.')) || 0;
    const margem = custo > 0 ? ((preco - custo) / custo * 100) : 0;
    const ean    = row['EAN'] ? String(Math.round(Number(row['EAN']))) : '';
    const foto   = String(row['URL_Imagem'] || '').trim();
    const pid    = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    try {
      await pool.query(
        `INSERT INTO products (id,name,sku,ean,ref,category,brand,supplier,size,color,price,cost,margin,min_stock,img,photo,variations,active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (sku) DO NOTHING`,
        [pid, nome, sku, ean, '', cat, "D'Black", '', '', '', preco, custo, margem, 5, '👕', foto, '[]', true]
      );
      for (const sid of stockIds) {
        await pool.query(
          `INSERT INTO stock (stock_id, product_id, quantity) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
          [sid, pid]
        );
      }
      ok++;
      if (ok % 100 === 0) process.stdout.write(`\r  ${ok} importados...`);
    } catch (e) {
      process.stdout.write(`\n  Erro em ${sku}: ${e.message}\n`);
      skip++;
    }
  }

  await pool.end();
  console.log(`\n✅ Concluído! ${ok} importados, ${skip} ignorados.`);
}

main().catch(e => { console.error('Erro fatal:', e.message); process.exit(1); });
