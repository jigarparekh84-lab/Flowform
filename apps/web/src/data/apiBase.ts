/** API base URL (own module to avoid import cycles). */
export const DEFAULT_API_BASE =
  (typeof import.meta !== 'undefined' &&
    (import.meta as ImportMeta & { env?: { VITE_API_URL?: string } }).env
      ?.VITE_API_URL) ||
  'http://127.0.0.1:5182'
