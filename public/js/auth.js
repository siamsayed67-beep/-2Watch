'use strict';

/*
 * Supabase accounts. The server tells the page whether accounts are switched on
 * (/api/config). When they're off, every method resolves to "no user" and the app
 * falls back to joining with just a name.
 * Needs the supabase-js script (window.supabase) loaded before this file.
 */
window.Auth = (() => {
  let client = null;

  const ready = fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        if (!window.supabase?.createClient) throw new Error('Could not load the sign-in library.');
        client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      }
      return !!client;
    });

  async function getSession() {
    await ready;
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session;
  }

  async function signUp(email, password, username) {
    await ready;
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { username }, emailRedirectTo: location.origin },
    });
    if (error) throw error;
    // With "Confirm email" on in Supabase there's no session until the link is clicked.
    return { session: data.session, needsConfirmation: !data.session };
  }

  async function signIn(email, password) {
    await ready;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function signOut() {
    await ready;
    await client?.auth.signOut();
  }

  const displayName = (user) => user?.user_metadata?.username || user?.email?.split('@')[0] || 'Guest';

  return { ready, getSession, signUp, signIn, signOut, displayName };
})();
