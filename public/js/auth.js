'use strict';

// Authentication has been removed. Users join directly without accounts.
window.Auth = {
  ready: Promise.resolve(false),
  getSession: async () => null,
  signUp: async () => { throw new Error('Authentication is disabled.'); },
  signIn: async () => { throw new Error('Authentication is disabled.'); },
  signOut: async () => {},
  displayName: () => 'Guest',
};
