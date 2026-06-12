import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

// ─── Service Worker: registra e auto-reload quando há versão nova ───
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Registrado');

      // Detecta quando um novo SW está pronto e força reload
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            console.log('[SW] Nova versão ativada — recarregando...');
            window.location.reload();
          }
        });
      });

      // Checa atualizações a cada 2 minutos
      setInterval(() => reg.update(), 2 * 60 * 1000);
    } catch (err) {
      console.warn('[SW] Falha ao registrar:', err);
    }
  });

  // Se o SW controlador mudar (outro tab ativou novo SW), reload também
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    console.log('[SW] Controller mudou — recarregando...');
    window.location.reload();
  });
}
