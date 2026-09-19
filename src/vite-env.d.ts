/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

// vite.config.ts の define で埋め込むビルド情報
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
