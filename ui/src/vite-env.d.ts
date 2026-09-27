/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional volatility proxy (ui/worker). Unset = browser calls Deribit directly. */
  readonly VITE_VOLATILITY_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
