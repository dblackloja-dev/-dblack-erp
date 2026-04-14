// ═══════════════════════════════════════════════════════
// ═══  D'Black ERP — Servidor Local para o Caixa     ═══
// ═══  Proxy reverso: frontend do Vercel + API Railway ═══
// ═══  Atualização automática — sem precisar copiar   ═══
// ═══════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const BACKEND = 'https://dblack-erp-backend-production.up.railway.app';
const FRONTEND = 'https://dblack-erp.vercel.app';
const DIST = path.join(__dirname, 'frontend', 'dist');

// Tipos de arquivo (fallback local)
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pem': 'text/plain',
};

// Proxy genérico HTTPS
function proxyTo(targetUrl, req, res) {
  const url = new URL(targetUrl + req.url);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.hostname },
  };

  const proxy = https.request(options, (proxyRes) => {
    // Remove headers que podem causar problema no proxy
    const headers = { ...proxyRes.headers };
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxy.on('error', () => null); // tratado pelo fallback
  proxy.on('error', (e) => {
    // Se Vercel falhou, tenta servir do dist local (fallback offline)
    if (targetUrl === FRONTEND) {
      serveLocal(req, res);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend offline: ' + e.message }));
    }
  });

  req.pipe(proxy);
}

// Serve arquivos locais (fallback se Vercel estiver fora)
function serveLocal(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Arquivo não encontrado');
  }
}

// Servidor
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // API e uploads → proxy para Railway
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/uploads/')) {
    return proxyTo(BACKEND, req, res);
  }

  // Frontend → proxy para Vercel (sempre atualizado!)
  // Se Vercel estiver fora, cai no fallback local automaticamente
  proxyTo(FRONTEND, req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║   D\'Black ERP — Modo Caixa Local         ║');
  console.log('  ║                                           ║');
  console.log(`  ║   Abra no navegador:                      ║`);
  console.log(`  ║   → http://localhost:${PORT}                  ║`);
  console.log('  ║                                           ║');
  console.log('  ║   QZ Tray: ✅ Compatível (HTTP local)     ║');
  console.log('  ║   Frontend: ✅ Sempre atualizado (Vercel) ║');
  console.log('  ║   API: ✅ Sincroniza com Railway          ║');
  console.log('  ║   Offline: ✅ Fallback para dist local    ║');
  console.log('  ║                                           ║');
  console.log('  ║   Para fechar: Ctrl+C                     ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});
