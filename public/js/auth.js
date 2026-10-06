'use strict';

// Supabase auth management (client-side)
window.Auth = (() => {
  let user = null;
  let authEnabled = false;

  async function init() {
    try {
      const token = localStorage.getItem('sb_token');
      const res = await fetch('/api/auth/status', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      const data = await res.json();
      authEnabled = data.authEnabled;
      if (data.authenticated) {
        user = data.user;
        localStorage.setItem('sb_user', JSON.stringify(user));
      }
      return { user, authEnabled };
    } catch (e) {
      console.error('Auth init failed:', e);
      return { user: null, authEnabled: false };
    }
  }

  function getUser() {
    if (!user) {
      const stored = localStorage.getItem('sb_user');
      if (stored) user = JSON.parse(stored);
    }
    return user;
  }

  function setUser(u) {
    user = u;
    if (u) localStorage.setItem('sb_user', JSON.stringify(u));
    else localStorage.removeItem('sb_user');
  }

  function setToken(token) {
    if (token) localStorage.setItem('sb_token', token);
    else localStorage.removeItem('sb_token');
  }

  function getToken() {
    return localStorage.getItem('sb_token');
  }

  function logout() {
    user = null;
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
  }

  return { init, getUser, setUser, setToken, getToken, logout, isEnabled: () => authEnabled };
})();
