import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

// ─── Service Worker: limpa antigos e registra novo ───
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    // Primeiro: remove qualquer SW antigo que possa estar causando problemas
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) {
      await reg.unregister();
      console.log('[SW] SW antigo removido');
    }
    // Limpa caches antigos
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      await caches.delete(name);
      console.log('[SW] Cache removido:', name);
    }
    // Agora registra o SW novo (limpo)
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Novo SW registrado');
      setInterval(() => reg.update(), 5 * 60 * 1000);
    } catch (err) {
      console.warn('[SW] Falha ao registrar:', err);
    }
  });
}
