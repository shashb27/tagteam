// Auth provider composition root. M1 ships the local bcrypt provider; Entra
// / Google providers will implement the same shape and swap in here.
//
// Call sites import { AuthProvider } from './auth/index.js' — never from
// ./local.js — so the provider can be swapped without touching handlers.

export { AuthProvider } from './local.js';
export {
  clientIp, isLoginLocked,
  COOKIE_NAME, COOKIE_MAX_AGE, sessionCookieValue, clearCookieValue,
  readCookies, validatePassword, validateEmail,
} from './local.js';
