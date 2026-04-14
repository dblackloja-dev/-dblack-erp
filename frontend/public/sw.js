// ═══════════════════════════════════════════════════
// ═══  D'Black ERP — Service Worker (Offline)     ═══
// ═══════════════════════════════════════════════════
const CACHE_NAME = 'dblack-erp-v2'; // v2: fix QZ Tray

// Arquivos essenciais para o app funcionar offline
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
];

// ─── INSTALL: cacheia os arquivos essenciais ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pré-cacheando arquivos essenciais');
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // Ativa imediatamente sem esperar abas antigas fecharem
  self.skipWaiting();
});

// ─── ACTIVATE: limpa caches antigos ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Removendo cache antigo:', name);
            return caches.delete(name);
          })
      )
    )
  );
  // Assume controle de todas as abas abertas
  self.clients.claim();
});

// ─── FETCH: estratégia de cache ───
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // QZ Tray: NUNCA interceptar — deixar passar direto
  if (url.hostname === 'localhost' && url.port && url.port !== location.port) return;
  if (url.pathname === '/qz-tray.js') return;
  if (url.pathname.startsWith('/api/qz-')) return;

  // Requisições de API (POST/PUT/DELETE) — não cachear, deixar passar
  if (url.pathname.startsWith('/api/')) {
    // GET de API: tenta rede primeiro, fallback para cache
    if (event.request.method === 'GET') {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            // Cacheia a resposta da API para uso offline
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
            return response;
          })
          .catch(() => {
            // Sem internet: retorna do cache
            return caches.match(event.request);
          })
      );
    }
    // POST/PUT/DELETE: deixa o api.js gerenciar a fila offline
    return;
  }

  // Google Fonts e outros recursos externos
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // Arquivos estáticos (HTML, JS, CSS, imagens): cache first, fallback rede
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Retorna do cache imediatamente se disponível
      const fetchPromise = fetch(event.request)
        .then((response) => {
          // Atualiza o cache com a versão nova (stale-while-revalidate)
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => {
          // Sem internet e sem cache: retorna o index.html (SPA fallback)
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('', { status: 408 });
        });

      return cached || fetchPromise;
    })
  );
});

// ─── MESSAGE: permite forçar atualização do cache ───
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[SW] Cache limpo');
    });
  }
});
