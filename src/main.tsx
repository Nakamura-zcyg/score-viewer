import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './styles.css';

registerSW({
  immediate: true,
  // 初回のキャッシュ完了。以後はネットなしで起動できる
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('sw-offline-ready'));
  },
});

// 空き容量が逼迫しても IndexedDB の楽譜を追い出されないよう、永続ストレージを要求する。
// Chrome はホーム画面に追加済み・利用実績のあるサイトには自動で許可する。失敗しても動作に影響なし
navigator.storage?.persist?.().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
