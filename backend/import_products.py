import openpyxl
import psycopg2
import random
import string
import sys

# Conexão com o banco
CONN_STR = "postgresql://neondb_owner:npg_Yno8tbS3Gurq@ep-lingering-lab-amkqs4gw.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require"

def gen_id():
    import time
    chars = string.ascii_lowercase + string.digits
    return hex(int(time.time() * 1000))[2:] + ''.join(random.choices(chars, k=4))

def main():
    print("📦 Conectando ao banco...")
    conn = psycopg2.connect(CONN_STR)
    cur = conn.cursor()

    print("📖 Lendo planilha...")
    wb = openpyxl.load_workbook(r'C:/Users/win/Downloads/ok pro.xlsx')
    ws = wb.active

    stock_ids = ['loja1', 'loja2', 'shared_matriz']

    ok = 0
    skip = 0

    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        nome, categoria, preco_venda, preco_custo, sku, ean, url_img = row

        if not nome or not sku:
            skip += 1
            continue

        nome = str(nome).strip()
        sku = str(sku).strip()
        categoria = str(categoria).strip() if categoria else 'Outros'
        preco = float(str(preco_venda).replace(',', '.')) if preco_venda else 0
        custo = float(str(preco_custo).replace(',', '.')) if preco_custo else 0
        margem = ((preco - custo) / custo * 100) if custo > 0 else 0
        ean_str = str(int(ean)) if ean and str(ean) != 'None' else ''
        foto = str(url_img).strip() if url_img and str(url_img) != 'None' else ''
        pid = gen_id()

        try:
            cur.execute("""
                INSERT INTO products (id, name, sku, ean, ref, category, brand, supplier, size, color, price, cost, margin, min_stock, img, photo, variations, active)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (sku) DO NOTHING
            """, (pid, nome, sku, ean_str, '', categoria, "D'Black", '', '', '', preco, custo, margem, 5, '👕', foto, '[]', True))

            # Estoque zerado em todas as lojas
            for sid in stock_ids:
                cur.execute("""
                    INSERT INTO stock (stock_id, product_id, quantity) VALUES (%s, %s, 0)
                    ON CONFLICT DO NOTHING
                """, (sid, pid))

            ok += 1
        except Exception as e:
            print(f"  ⚠ Linha {i} ({sku}): {e}")
            skip += 1

    conn.commit()
    cur.close()
    conn.close()
    print(f"\n✅ {ok} produtos importados, {skip} ignorados.")

main()
