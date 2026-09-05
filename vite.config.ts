import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages では BASE_PATH=/<repo>/ を渡す。ローカル開発時は '/'。
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Score Viewer',
        short_name: 'Score',
        description: 'ピアノ演奏用 PDF 楽譜ビューア',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  build: {
    // Android 7 の Chrome 119 を下限として安全側に倒す
    target: 'chrome100',
  },
});
