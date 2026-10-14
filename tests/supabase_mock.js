// Shared fake Supabase client for jsdom tests. Simulates just enough of supabase-js v2's
// surface (auth + postgrest + realtime) for research-tracker.html's sync code to run against a
// fully in-memory, deterministic backend instead of hitting the real network — the app now
// requires a logged-in Supabase session before it does anything, and a real bootApp() attempt
// against an unreachable/absent library takes a real 12s timeout (plus 15s reconnect loops)
// which blows past test timeouts. Injecting this via `win.supabase = { createClient: ... }`
// inside `beforeParse` skips the CDN load and the network entirely.
function makeMockSupabase(opts) {
  opts = opts || {};
  const items = opts.items || []; // [{id, kind, data, updated_at}]
  let session = opts.session === undefined
    // user_metadata carries the workspace an invited person was placed in — it is how the app
    // knows which lab to stamp a first-ever profile with, before any profile row exists.
    ? { user: { id: opts.userId || "test-user-1", email: opts.email || "test@example.com",
                user_metadata: opts.userMetadata || {} } }
    : opts.session;
  let authCallback = null;

  function nowIso() { return new Date().toISOString(); }

  const auth = {
    getSession: async () => ({ data: { session: session ? { user: session.user } : null }, error: null }),
    onAuthStateChange: (cb) => { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async ({ email, password }) => {
      if (opts.failLogin) return { data: null, error: { message: opts.failLogin } };
      session = { user: { id: opts.loginUserId || "test-user-1", email } };
      if (authCallback) authCallback("SIGNED_IN", { user: session.user });
      return { data: { session: { user: session.user } }, error: null };
    },
    signOut: async () => {
      session = null;
      if (authCallback) authCallback("SIGNED_OUT", null);
      return { error: null };
    },
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    updateUser: async () => ({ data: {}, error: null }),
    // Test helper (not part of the real supabase-js API): manually fire a recovery event.
    __triggerPasswordRecovery: () => { if (authCallback) authCallback("PASSWORD_RECOVERY", { user: session && session.user }); },
    __triggerSignedOut: () => { session = null; if (authCallback) authCallback("SIGNED_OUT", null); }
  };

  // Real RLS requires the `authenticated` role for every operation on `items` — mirror that here
  // so a signed-out mock (session: null, used by the offline-blocking tests) behaves like the
  // real backend rejecting the write, instead of silently succeeding and flipping syncOnline true.
  const authError = { message: "new row violates row-level security policy" };
  const inserted = [];
  let currentTable = "items";
  function fromTable(table) {
    currentTable = table || "items";
    return {
      select(cols) {
        return {
          neq(col, val) {
            if (!session) return Promise.resolve({ data: null, error: authError });
            return Promise.resolve({ data: items.filter(r => r[col] !== val), error: null });
          },
          // Single-row read, used by pushMeeting to merge a meeting's study links with whatever
          // the server already holds before writing over it.
          eq(col, val) {
            const hit = () => items.find(r => r[col] === val) || null;
            const result = () => session
              ? { data: hit() ? JSON.parse(JSON.stringify(hit())) : null, error: null }
              : { data: null, error: authError };
            return {
              maybeSingle: () => Promise.resolve(result()),
              single: () => Promise.resolve(result()),
              then: (res, rej) => Promise.resolve(session
                ? { data: items.filter(r => r[col] === val), error: null }
                : { data: null, error: authError }).then(res, rej)
            };
          }
        };
      },
      insert(rows) {
        if (!session) return Promise.resolve({ data: null, error: authError });
        const arr = Array.isArray(rows) ? rows : [rows];
        arr.forEach(row => inserted.push(Object.assign({ table: currentTable }, row)));
        return Promise.resolve({ data: arr, error: null });
      },
      upsert(rows) {
        if (!session) return Promise.resolve({ data: null, error: authError });
        const arr = Array.isArray(rows) ? rows : [rows];
        arr.forEach(row => {
          const withMeta = Object.assign({ updated_at: nowIso() }, row);
          const i = items.findIndex(r => r.id === withMeta.id);
          if (i >= 0) items[i] = withMeta; else items.push(withMeta);
        });
        return Promise.resolve({ data: arr, error: null });
      },
      delete() {
        return {
          eq(col, val) {
            if (!session) return Promise.resolve({ data: null, error: authError });
            const i = items.findIndex(r => r[col] === val);
            if (i >= 0) items.splice(i, 1);
            return Promise.resolve({ data: null, error: null });
          }
        };
      }
    };
  }

  const client = {
    auth,
    from: fromTable,
    channel() {
      return {
        on() { return this; },
        subscribe(cb) { if (cb) cb("SUBSCRIBED"); return this; }
      };
    },
    removeChannel() {},
    __items: items,
    __inserted: inserted,
    __setSession: (s) => { session = s; }
  };
  return client;
}
module.exports = { makeMockSupabase };
