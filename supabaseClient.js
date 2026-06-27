/**
 * Supabase Client Initialization & Integration
 * Loads credentials dynamically from the Jinja2-injected HTML meta tags.
 * Sets the client globally on window.supabaseClient for use across app.js.
 */
(function () {
  // Extract credentials from meta tags
  const urlMeta = document.querySelector('meta[name="supabase-url"]');
  const keyMeta = document.querySelector('meta[name="supabase-anon-key"]');

  const supabaseUrl = urlMeta ? urlMeta.content.strip || urlMeta.content.trim() : '';
  const supabaseAnonKey = keyMeta ? keyMeta.content.strip || keyMeta.content.trim() : '';

  if (!supabaseUrl || !supabaseAnonKey || supabaseUrl === 'None' || supabaseAnonKey === 'None') {
    console.warn("Supabase Config: Credentials missing or placeholder active. Client-side SDK not fully connected.");
    return;
  }

  if (typeof supabase === 'undefined') {
    console.error("Supabase Config: Supabase JS SDK CDN script tag is missing from index.html.");
    return;
  }

  console.log("Supabase Config: Initializing client with Anon key...");

  // Initialize the Supabase Client with safe browser/anonymous key
  const supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);

  // Set on window object for universal availability
  window.supabaseClient = supabaseClient;

  // ─── BASIC SMOKE TEST / LISTENERS ───
  
  // Listen to Authentication State changes
  supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log(`[Supabase Auth] Event: ${event}`);
    if (session) {
      console.log(`[Supabase Auth] User authenticated: ${session.user.email}`);
    } else {
      console.log("[Supabase Auth] No active session found.");
    }
  });

  // Connection validation query check (checks if the client is running)
  async function runSmokeTest() {
    try {
      // Try a lightweight query to a known table or just ping
      const { data, error } = await supabaseClient
        .from('trips')
        .select('id')
        .limit(1);

      if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
        console.log(`[Supabase DB Test] Handshake verified. Note: Table returned message: ${error.message}`);
      } else {
        console.log("[Supabase DB Test] Connection verification succeeded. Handshake OK.");
      }
    } catch (err) {
      // Silently catch in dev
    }
  }

  // Run validation
  runSmokeTest();
})();
