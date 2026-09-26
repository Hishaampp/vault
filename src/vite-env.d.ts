/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend URL when the dashboard is hosted separately (e.g. Vercel + Railway). */
  readonly VITE_API_URL?: string;
}