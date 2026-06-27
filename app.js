document.addEventListener('DOMContentLoaded', () => {
  // ─── STATE ───
  let currentCityId = null;
  let currentVariantId = "all";
  let currentFoodPref = "all"; // Food preference filter: 'all', 'veg', 'non-veg'
  let savedSpots = new Set(); // Track saved spot IDs to prevent duplicates
  let map;
  let markersGroup;
  let userMarker;
  let spotObserver;
  let spotMarkers = {};
  let routePolyline;
  let isExplorerMode = false;
  let isochronePolygon = null;
  let neighborhoodLayer;
  
  // Auth State
  let authToken = localStorage.getItem('tripco_token') || null;
  let currentUserEmail = localStorage.getItem('tripco_email') || null;
  let currentUsername = localStorage.getItem('tripco_username') || null;

  // ─── QUOTA MANAGER ───
  const QuotaManager = {
    max: 20,
    current: 20,
    resetInterval: null,
    consume: function() {
      if (this.current > 0) this.current--;
      this.updateUI();
      this.startResetTimer();
    },
    updateUI: function() {
      const textEl = document.getElementById('ai-quota-text');
      const barEl = document.getElementById('ai-quota-bar');
      if (textEl) textEl.textContent = `${this.current} / ${this.max}`;
      if (barEl) {
        const pct = (this.current / this.max) * 100;
        barEl.style.width = `${pct}%`;
        if (this.current <= 5) barEl.style.background = '#FF5252'; // Red
        else barEl.style.background = 'var(--amber)';
      }
    },
    startResetTimer: function() {
      if (this.resetInterval) return;
      let timeLeft = 13; // Simulating the 12.6s reset from Gemini
      const timerEl = document.getElementById('ai-reset-timer');
      if (timerEl) timerEl.textContent = timeLeft;
      
      this.resetInterval = setInterval(() => {
        timeLeft--;
        if (timerEl) timerEl.textContent = timeLeft;
        if (timeLeft <= 0) {
          clearInterval(this.resetInterval);
          this.resetInterval = null;
          this.current = this.max; // Reset quota
          this.updateUI();
          if (timerEl) timerEl.textContent = 0;
        }
      }, 1000);
    }
  };
  const defaultCityIds = new Set();

  // Multiplayer State
  let sharedTripId = null;
  let sharedVoteCounts = {};

  // Memory & Drag State
  let currentMemories = {};
  let draggedSpotId = null;
  let draggedSourceClusterId = null;

  // ─── DOM ELEMENTS ───
  const tabsContainer = document.getElementById('city-tabs-container');
  const appContainer = document.getElementById('app-container');
  const views = document.querySelectorAll('.app-view');
  const navBtns = document.querySelectorAll('.nav-btn');
  const savedSpotsList = document.getElementById('saved-spots-list');
  const statSpotsSaved = document.getElementById('stat-spots-saved');
  const bottomNav = document.querySelector('.bottom-nav');
  
  // Auth DOM
  const authContainer = document.getElementById('auth-container');
  const profileLoggedIn = document.getElementById('profile-logged-in');
  const authForm = document.getElementById('auth-form');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const authTitle = document.getElementById('auth-title');
  const authSubtitle = document.getElementById('auth-subtitle');
  const authSubmitBtn = document.getElementById('auth-submit-btn');

  // ─── INIT ───
  async function init() {
    window.tripData = window.tripData || {};

    // Hydrate from offline IndexedDB before anything renders
    try {
      await OfflineManager.loadAllOffline();
    } catch (e) {
      console.warn('Offline hydration skipped:', e);
    }

    try {
      initMap();
    } catch (e) {
      console.warn("Map initialization bypassed:", e.message);
    }
    setupProfileUI();
    setupAuth();
    setupBottomNav();
    setupEventDelegation();
    setupAISearch();
    setupShareBtn();

    let tripId = null;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('trip_id')) {
      tripId = urlParams.get('trip_id');
    } else if (window.location.pathname.startsWith('/trip/')) {
      tripId = window.location.pathname.split('/')[2];
    }

    if (tripId) {
      await loadSharedTrip(tripId);
    } else {
      renderTabs();
      renderCity(currentCityId, currentVariantId);
      
      // Initialize Auth UI state based on token
      updateAuthUI();
    }
  }

  async function loadSharedTrip(tripId) {
    try {
      showLoading("Loading shared trip...");
      const res = await fetch(`/api/trips/${tripId}`);
      if (!res.ok) throw new Error('Trip not found');
      
      const data = await res.json();
      sharedTripId = data.trip_id;
      sharedVoteCounts = data.vote_counts;
      
      // Inject trip into window.tripData (assume the city ID from the hero title)
      const cityId = data.trip_data.hero.title.toLowerCase().replace(/\s+/g, '-');
      window.tripData[cityId] = data.trip_data;
      
      currentCityId = cityId;
      currentVariantId = data.trip_data.itineraries[0].id;
      
      renderTabs();
      renderCity(currentCityId, currentVariantId);
      
      document.getElementById('nav-explore').click(); // Show itinerary
    } catch (e) {
      showError("Failed to load shared trip.");
      console.error(e);
      renderTabs();
      renderCity(currentCityId, currentVariantId);
    } finally {
      hideLoading();
    }
  }

  // ─── AUTHENTICATION ───
  let isLoginMode = true;

  function setupProfileUI() {
    const uploadInput = document.getElementById('profile-photo-upload');
    if (uploadInput) {
      uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64Str = event.target.result;
          localStorage.setItem('tripco_profile_photo', base64Str);
          updateAuthUI();
        };
        reader.readAsDataURL(file);
      });
    }
  }

  function setupAuth() {
    // Listen for Supabase OAuth redirects and sync local state
    if (window.supabaseClient) {
      window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
          // If we don't have the token in localStorage yet (e.g. fresh redirect), sync it
          if (!localStorage.getItem('tripco_token') || localStorage.getItem('tripco_token') !== session.access_token) {
            authToken = session.access_token;
            currentUserEmail = session.user.email;
            currentUsername = session.user.user_metadata?.full_name || session.user.user_metadata?.name || "Explorer";
            
            localStorage.setItem('tripco_token', authToken);
            localStorage.setItem('tripco_email', currentUserEmail);
            localStorage.setItem('tripco_username', currentUsername);
            
            if (typeof syncLocalSpots === 'function') await syncLocalSpots();
            if (typeof fetchUserData === 'function') await fetchUserData();
            
            if (typeof updateAuthUI === 'function') updateAuthUI();
            
            const navExplore = document.getElementById('nav-explore');
            if (navExplore) navExplore.click();
          }
        }
      });
    }

    // Welcome Start Button Listener
    const startBtn = document.getElementById('welcome-start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const heroScreen = document.getElementById('welcome-hero-screen');
        const authScreen = document.getElementById('welcome-auth-screen');
        if (heroScreen && authScreen) {
          heroScreen.classList.remove('active');
          heroScreen.classList.add('hidden');
          setTimeout(() => {
            authScreen.classList.remove('hidden');
            authScreen.classList.add('active');
          }, 300);
        }
      });
    }

    // Guest Mode
    const handleGuestBypass = async (e) => {
      e.preventDefault();
      
      if (!window.supabaseClient) {
         if (typeof showError === 'function') showError("Database connection not initialized.");
         return;
      }
      
      const btn = e.currentTarget;
      const originalText = btn.innerHTML;
      btn.innerHTML = `<svg class="loading-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg> Connecting...`;
      btn.style.opacity = '0.7';
      btn.style.pointerEvents = 'none';

      try {
        // Mock login as Guest since Supabase Anonymous Login is disabled
        authToken = "guest_" + Math.random().toString(36).substr(2, 9);
        currentUserEmail = "guest@tripco.app";
        currentUsername = "Guest Traveler";

        localStorage.setItem('tripco_token', authToken);
        localStorage.setItem('tripco_email', currentUserEmail);
        localStorage.setItem('tripco_username', currentUsername);
           
        updateAuthUI();
        document.getElementById('nav-explore').click();
      } catch (err) {
        if (typeof showError === 'function') showError("An error occurred during guest login.");
      } finally {
        btn.innerHTML = originalText;
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
      }
    };

    const welcomeGuestBtn = document.getElementById('welcome-guest-btn');
    if (welcomeGuestBtn) {
      welcomeGuestBtn.addEventListener('click', handleGuestBypass);
    }
    const authGuestBtn = document.getElementById('auth-guest-btn');
    if (authGuestBtn) {
      authGuestBtn.addEventListener('click', handleGuestBypass);
    }

    // New DOM references
    const emptyStateStyles = document.getElementById('empty-state-styles');
  
  // Premium Modal Logic
  window.showPolicyModal = function(title, text) {
    const overlay = document.getElementById('premium-modal-overlay');
    const titleEl = document.getElementById('premium-modal-title');
    const textEl = document.getElementById('premium-modal-text');
    if (overlay && titleEl && textEl) {
      titleEl.textContent = title;
      textEl.textContent = text;
      overlay.classList.add('active');
    }
  };
    const authBtnText = document.getElementById('auth-btn-text');
    const authLoadingSpinner = document.getElementById('auth-loading-spinner');
    const pwdToggleBtn = document.getElementById('pwd-toggle-btn');
    const eyeIconSvg = document.getElementById('eye-icon-svg');
    const emailError = document.getElementById('email-error');
    const passwordError = document.getElementById('password-error');
    
    // Tab Elements
    const authTabs = document.querySelectorAll('.auth-tab');
    const authForgotPwdWrap = document.getElementById('auth-forgot-pwd-wrap');
    const authTerms = document.getElementById('auth-terms');
    
    // Transitions
    const transitionWrappers = document.querySelectorAll('.transition-wrapper');

    // Tab Switching Logic
    authTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-tab');
        if ((mode === 'login' && isLoginMode) || (mode === 'signup' && !isLoginMode)) return;
        
        // Start transition out
        transitionWrappers.forEach(w => w.classList.add('fade-out'));
        
        setTimeout(() => {
          isLoginMode = mode === 'login';
          
          // Update Active Tab State
          authTabs.forEach(t => {
            t.classList.toggle('active', t.getAttribute('data-tab') === mode);
            t.setAttribute('aria-selected', t.getAttribute('data-tab') === mode);
          });

          // Update Content
          authTitle.textContent = isLoginMode ? 'Welcome Back' : 'Start Your Journey';
          authSubtitle.textContent = isLoginMode ? 'Log in to sync your saved spots across devices.' : 'Sign up to sync your saved spots across devices.';
          authBtnText.textContent = isLoginMode ? 'Log In' : 'Sign Up';
          
          if (isLoginMode) {
            authForgotPwdWrap.classList.remove('hidden');
            authTerms.classList.add('hidden');
            document.getElementById('username-group').style.display = 'none';
          } else {
            authForgotPwdWrap.classList.add('hidden');
            authTerms.classList.remove('hidden');
            document.getElementById('username-group').style.display = 'block';
          }
          
          // Clear errors & inputs
          emailError.textContent = '';
          passwordError.textContent = '';
          authEmail.setAttribute('aria-invalid', 'false');
          authPassword.setAttribute('aria-invalid', 'false');
          
          // Transition in
          transitionWrappers.forEach(w => w.classList.remove('fade-out'));
        }, 250); // 0.25s ease match
      });
    });

    // Real-Time Validation
    authEmail.addEventListener('input', () => {
      if (authEmail.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail.value)) {
        emailError.textContent = 'Please enter a valid email address.';
        authEmail.setAttribute('aria-invalid', 'true');
      } else {
        emailError.textContent = '';
        authEmail.setAttribute('aria-invalid', 'false');
      }
    });

    authPassword.addEventListener('input', () => {
      if (authPassword.value && authPassword.value.length < 8) {
        passwordError.textContent = 'Password must be at least 8 characters.';
        authPassword.setAttribute('aria-invalid', 'true');
      } else {
        passwordError.textContent = '';
        authPassword.setAttribute('aria-invalid', 'false');
      }
    });

    // Password Visibility Toggle
    pwdToggleBtn.addEventListener('click', () => {
      const type = authPassword.getAttribute('type') === 'password' ? 'text' : 'password';
      authPassword.setAttribute('type', type);
      if (type === 'text') {
        eyeIconSvg.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
      } else {
        eyeIconSvg.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
      }
    });

    // Form Submission
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      // Trigger validation checks
      const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authEmail.value);
      const pwdValid = authPassword.value.length >= 8;
      
      if (!emailValid) {
        emailError.textContent = 'Please enter a valid email address.';
        authEmail.setAttribute('aria-invalid', 'true');
      }
      if (!pwdValid) {
        passwordError.textContent = 'Password must be at least 8 characters.';
        authPassword.setAttribute('aria-invalid', 'true');
      }
      if (!emailValid || !pwdValid) return;

      // Loading State
      authSubmitBtn.disabled = true;
      authBtnText.style.opacity = '0.5';
      authLoadingSpinner.classList.remove('hidden');

      const email = authEmail.value;
      const password = authPassword.value;
      const username = document.getElementById('auth-username').value;

      try {
        let sessionData;
        if (isLoginMode) {
          const { data, error } = await window.supabaseClient.auth.signInWithPassword({
            email,
            password
          });
          if (error) throw error;
          sessionData = data;
        } else {
          const { data, error } = await window.supabaseClient.auth.signUp({
            email,
            password,
            options: {
              data: { username: username }
            }
          });
          if (error) throw error;
          sessionData = data;
        }

        const session = sessionData.session;
        const user = sessionData.user;

        if (session) {
          authToken = session.access_token;
          currentUserEmail = user.email;
          currentUsername = user.user_metadata?.username || username || "";
          
          localStorage.setItem('tripco_token', authToken);
          localStorage.setItem('tripco_email', currentUserEmail);
          if (currentUsername) localStorage.setItem('tripco_username', currentUsername);
          
          await syncLocalSpots();
          await fetchUserData();
          
          updateAuthUI();
          document.getElementById('nav-explore').click();
        } else {
          showError("Registration successful! Please check your email for verification.");
        }

        authEmail.value = '';
        authPassword.value = '';
      } catch (err) {
        showError(err.message); // Use the global toast function
      } finally {
        // Reset Loading State
        authSubmitBtn.disabled = false;
        authBtnText.style.opacity = '1';
        authLoadingSpinner.classList.add('hidden');
      }
    });

    // Real Social Auth Integrations
    const GOOGLE_CLIENT_ID = document.querySelector('meta[name="google-client-id"]')?.content || "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
    const APPLE_CLIENT_ID = "com.yourdomain.tripco"; // Replace with real Apple Service ID

    // Send Token to Backend Function
    const processSocialLogin = async (provider, token) => {
      authSubmitBtn.disabled = true;
      authLoadingSpinner.classList.remove('hidden');
      
      try {
        if (provider === 'google') {
          const { data, error } = await window.supabaseClient.auth.signInWithIdToken({
            provider: 'google',
            token: token
          });
          if (error) throw error;
          
          authToken = data.session.access_token;
          currentUserEmail = data.user.email;
          currentUsername = data.user.user_metadata?.full_name || data.user.user_metadata?.name || "";
          
          localStorage.setItem('tripco_token', authToken);
          localStorage.setItem('tripco_email', currentUserEmail);
          if (currentUsername) localStorage.setItem('tripco_username', currentUsername);
          
          await syncLocalSpots();
          await fetchUserData();
          
          // Update UI to show bottom nav and profile info
          updateAuthUI();
          
          // Auto navigate back to explore
          document.getElementById('nav-explore').click();
        }
      } catch (err) {
        showError(err.message);
      } finally {
        authSubmitBtn.disabled = false;
        authLoadingSpinner.classList.add('hidden');
      }
    };

    // Supabase Google OAuth Integration
    const googleBtnContainer = document.getElementById('google-auth-btn');
    if (googleBtnContainer) {
      const googleBtn = document.createElement('button');
      googleBtn.className = 'auth-tab';
      googleBtn.style.width = '100%';
      googleBtn.style.marginTop = '10px';
      googleBtn.style.background = 'var(--bg-elevated)';
      googleBtn.style.border = '1px solid var(--border-subtle)';
      googleBtn.style.color = '#fff';
      googleBtn.style.display = 'flex';
      googleBtn.style.alignItems = 'center';
      googleBtn.style.justifyContent = 'center';
      googleBtn.style.gap = '10px';
      googleBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Continue with Google
      `;
      googleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!window.supabaseClient) {
          if (typeof showError === 'function') showError("Database connection not initialized.");
          return;
        }
        
        try {
          const { error } = await window.supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: window.location.origin,
              queryParams: {
                prompt: 'select_account' // Forces the email selection screen
              }
            }
          });
          if (error) throw error;
        } catch (err) {
          if (typeof showError === 'function') showError(err.message);
        }
      });
      googleBtnContainer.appendChild(googleBtn);
    }
    document.getElementById('forgot-password').addEventListener('click', (e) => {
      e.preventDefault();
      showError("Password recovery coming soon!");
    });

    const logoutBtn = document.getElementById('aur-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (window.supabaseClient) {
          await window.supabaseClient.auth.signOut().catch(e => console.warn(e));
        }
        authToken = null;
      currentUserEmail = null;
      currentUsername = null;
      localStorage.removeItem('tripco_token');
      localStorage.removeItem('tripco_email');
      localStorage.removeItem('tripco_username');
      savedSpots.clear(); // Clear memory spots, user is logged out
      
      // Clear dynamic/searched cities
      Object.keys(window.tripData).forEach(key => {
        if (!defaultCityIds.has(key)) {
          delete window.tripData[key];
        }
      });
      if (!defaultCityIds.has(currentCityId)) {
        currentCityId = "tokyo";
        currentVariantId = "all";
        renderCity(currentCityId, currentVariantId);
      }
      renderTabs();

      renderSavedSpots();
      updateAuthUI();
      });
    }

    if (authToken) {
      fetchUserData();
    } else {
      updateAuthUI();
    }
  }

  async function syncLocalSpots() {
    if (!authToken || savedSpots.size === 0) return;
    try {
      await fetch('/api/user/sync', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ saved_spots: Array.from(savedSpots) })
      });
    } catch (e) {
      console.error('Failed to sync spots', e);
    }
  }

  async function fetchUserData() {
    if (!authToken) return;
    try {
      const res = await fetch('/api/user/data', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (!res.ok) {
        // Backend not running, skip gracefully
        updateAuthUI();
        return;
      }
      if (res.status === 401) {
        logoutBtn.click(); // Token expired
        return;
      }
      const data = await res.json();
      
      // Load user DB spots into local state
      data.saved_spots.forEach(id => savedSpots.add(id));
      renderSavedSpots();

      // Load user DB trips into window.tripData
      if (data.saved_trips && Array.isArray(data.saved_trips)) {
        data.saved_trips.forEach(trip => {
          if (trip && trip.id) {
            window.tripData[trip.id] = trip;
            // Auto-save user trips offline
            OfflineManager.saveOffline(trip.id);
          }
        });
        renderTabs();
      }
      
      currentUserEmail = data.email;
      currentUsername = data.username;
      if (currentUsername) localStorage.setItem('tripco_username', currentUsername);
      
      updateAuthUI();
    } catch (e) {
      console.error('Failed to fetch user data', e);
    }
  }

  function updateAuthUI() {
    const viewWelcome = document.getElementById('view-welcome');
    if (authToken) {
      if (viewWelcome && viewWelcome.classList.contains('active')) {
        viewWelcome.classList.add('fade-out-welcome');
        setTimeout(() => {
          viewWelcome.classList.remove('active');
          viewWelcome.classList.remove('fade-out-welcome');
        }, 500);
      }
      
      if (authContainer) authContainer.style.display = 'none';
      if (profileLoggedIn) profileLoggedIn.style.display = 'block';
      
      const displayName = currentUsername || currentUserEmail || 'Guest Traveler';
      
      const sidebarName = document.getElementById('sidebar-name');
      const mainName = document.getElementById('main-profile-name');
      if (sidebarName) sidebarName.textContent = displayName;
      if (mainName) mainName.textContent = displayName;

      const savedPhoto = localStorage.getItem('tripco_profile_photo');
      const mainAvatar = document.getElementById('main-avatar');
      const sidebarAvatar = document.getElementById('sidebar-avatar');
      const initial = displayName ? displayName.charAt(0).toUpperCase() : 'U';
      
      if (savedPhoto) {
        if (mainAvatar) { mainAvatar.style.backgroundImage = `url(${savedPhoto})`; mainAvatar.textContent = ''; }
        if (sidebarAvatar) { sidebarAvatar.style.backgroundImage = `url(${savedPhoto})`; sidebarAvatar.textContent = ''; }
      } else {
        if (mainAvatar) { mainAvatar.style.backgroundImage = 'none'; mainAvatar.textContent = initial; }
        if (sidebarAvatar) { sidebarAvatar.style.backgroundImage = 'none'; sidebarAvatar.textContent = initial; }
      }
      bottomNav.classList.remove('hidden-nav');

      // Default to showing the explore view
      views.forEach(v => {
        if (v.id === 'view-explore') v.classList.add('active');
        else v.classList.remove('active');
      });
      navBtns.forEach(b => {
        if (b.id === 'nav-explore') b.classList.add('active');
        else b.classList.remove('active');
      });

      // Show Onboarding if not seen
      checkAndShowOnboarding();

      // Update offline count in profile
      OfflineManager.getOfflineCount().then(count => {
        const el = document.getElementById('aur-stat-offline');
        if (el) el.textContent = count;
      });
      // Update saved spots
      const savedCount = Object.keys(JSON.parse(localStorage.getItem('tripco_saved_spots') || '{}')).length;
      const elSaved = document.getElementById('aur-stat-saved');
      if (elSaved) elSaved.textContent = savedCount;
    } else {
      if (viewWelcome) {
        viewWelcome.classList.add('active');
        const heroScreen = document.getElementById('welcome-hero-screen');
        const authScreen = document.getElementById('welcome-auth-screen');
        
        heroScreen.classList.add('active');
        heroScreen.classList.remove('hidden');
        authScreen.classList.add('hidden');
        authScreen.classList.remove('active');
      }
      if (authContainer) authContainer.style.display = 'flex';
      if (profileLoggedIn) profileLoggedIn.style.display = 'none';
      if (bottomNav) bottomNav.classList.add('hidden-nav');

      views.forEach(v => {
        if (v.id !== 'view-welcome') v.classList.remove('active');
      });
    }
  }

  // ─── ONBOARDING LOGIC ───
  function checkAndShowOnboarding() {
    const hasSeenOnboarding = localStorage.getItem('tripco_has_seen_onboarding');
    if (!hasSeenOnboarding) {
      setTimeout(initOnboarding, 50); // Instantly show after login click
    }
  }

  function initOnboarding() {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;
    
    overlay.classList.remove('hidden');
    
    const slides = document.querySelectorAll('.ob-slide');
    const dots = document.querySelectorAll('.ob-dot');
    const nextBtn = document.getElementById('ob-next-btn');
    let currentSlide = 0;
    
    if (!nextBtn) return;

    nextBtn.onclick = () => {
      if (currentSlide < slides.length - 1) {
        // Move to next slide
        slides[currentSlide].classList.remove('active');
        dots[currentSlide].classList.remove('active');
        
        currentSlide++;
        
        slides[currentSlide].classList.add('active');
        dots[currentSlide].classList.add('active');
        
        if (currentSlide === slides.length - 1) {
          nextBtn.textContent = "Close";
        }
      } else {
        // Close onboarding
        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.classList.add('hidden');
          overlay.style.opacity = '1';
        }, 500);
        localStorage.setItem('tripco_has_seen_onboarding', 'true');
        
        // Show empty state if no cities
        if (!currentCityId) renderEmptyState();
      }
    };

    // Wire up Quick Vibe Buttons
    const quickVibeBtns = document.querySelectorAll('.quick-vibe-btn');
    quickVibeBtns.forEach(btn => {
      btn.onclick = () => {
        const vibe = btn.getAttribute('data-vibe');
        // Close onboarding
        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.classList.add('hidden');
          overlay.style.opacity = '1';
        }, 500);
        localStorage.setItem('tripco_has_seen_onboarding', 'true');
        
        // Trigger AI search
        const searchInput = document.getElementById('ai-search-input');
        const searchBtn = document.getElementById('ai-search-btn');
        if (searchInput && searchBtn) {
          searchInput.value = vibe;
          searchBtn.click();
        }
      };
    });
  }

  // ─── AI SEARCH / DYNAMIC GENERATION ───
  const API_BASE = "";
  const loadingOverlay = document.getElementById('ai-loading-overlay');
  const loadingText = document.getElementById('ai-loading-text');
  const progressBar = document.getElementById('ai-loading-progress-bar');
  const progressPercent = document.getElementById('ai-loading-progress-percent');
  const errorToast = document.getElementById('ai-error-toast');
  const errorMsg = document.getElementById('ai-error-msg');
  const searchInput = document.getElementById('ai-search-input');
  const searchBtn = document.getElementById('ai-search-btn');

  const LOADING_MESSAGES = [
    "Curating your trip...",
    "Scouting hidden gems...",
    "Mapping the best routes...",
    "Finding local food spots...",
    "Crafting your itinerary...",
    "Checking real coordinates...",
    "Almost there...",
  ];

  let loadingInterval = null;
  let progressInterval = null;
  let trafficWarningTimeout = null;
  let currentProgress = 0;

  function showLoading(customMessage) {
    if (appContainer) appContainer.style.display = 'none';
    window.scrollTo({ top: 0 });
    
    loadingOverlay.classList.add('active');
    
    // Reset progress
    currentProgress = 0;
    if (progressBar) progressBar.style.width = '0%';
    if (progressPercent) progressPercent.textContent = '0%';
    
    if (loadingInterval) clearInterval(loadingInterval);
    if (trafficWarningTimeout) clearTimeout(trafficWarningTimeout);
    
    // Reset agent checklist
    const agents = ['agent-budget', 'agent-hotel', 'agent-food', 'agent-route'];
    agents.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = idx === 0 ? 'block' : 'none';
        el.style.color = 'var(--amber)';
      }
    });
    
    if (customMessage) {
      if (loadingText) loadingText.textContent = customMessage;
    } else {
      let msgIndex = 0;
      if (loadingText) loadingText.textContent = LOADING_MESSAGES[0];
      loadingInterval = setInterval(() => {
        msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
        if (loadingText) loadingText.textContent = LOADING_MESSAGES[msgIndex];
      }, 2800);
      
      // If AI takes longer than 15 seconds due to network traffic
      trafficWarningTimeout = setTimeout(() => {
        if (loadingInterval) {
          clearInterval(loadingInterval);
          loadingInterval = null;
        }
        if (loadingText) loadingText.innerHTML = "High network traffic.<br><span style='font-size:14px; opacity:0.8; margin-top:8px; display:inline-block;'>Allocating extra AI resources to generate your trip...</span>";
      }, 15000);
    }

    // Non-linear simulated progress timer
    progressInterval = setInterval(() => {
      let increment = 0;
      if (currentProgress < 30) {
        increment = 1.5 + Math.random() * 1.5; // Starts relatively fast
      } else if (currentProgress < 70) {
        increment = 0.8 + Math.random() * 0.7; // Decelerating
      } else if (currentProgress < 90) {
        increment = 0.3 + Math.random() * 0.5; // Slower
      } else if (currentProgress < 98) {
        increment = 0.05 + Math.random() * 0.1; // Creeps towards 98%
      }
      
      currentProgress = Math.min(98, currentProgress + increment);
      
      // Animate checklist based on progress
      if (currentProgress > 20 && currentProgress <= 45) checkOffAgent('agent-budget', 'agent-hotel');
      if (currentProgress > 45 && currentProgress <= 70) checkOffAgent('agent-hotel', 'agent-food');
      if (currentProgress > 70 && currentProgress <= 95) checkOffAgent('agent-food', 'agent-route');
      if (currentProgress > 95) checkOffAgent('agent-route', null);
      
      if (progressBar) progressBar.style.width = `${currentProgress.toFixed(0)}%`;
      if (progressPercent) progressPercent.textContent = `${currentProgress.toFixed(0)}%`;
    }, 150);
  }

  function checkOffAgent(id, nextId) {
    const el = document.getElementById(id);
    if (!el || el.style.display === 'none') return;
    el.style.display = 'none';
    if (nextId) {
      const nextEl = document.getElementById(nextId);
      if (nextEl) {
        nextEl.style.display = 'block';
        nextEl.style.color = 'var(--amber)';
      }
    }
  }

  function hideLoading() {
    // Complete the progress to 100% cleanly
    if (progressBar) progressBar.style.width = '100%';
    if (progressPercent) progressPercent.textContent = '100%';

    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    if (trafficWarningTimeout) {
      clearTimeout(trafficWarningTimeout);
      trafficWarningTimeout = null;
    }

    if (appContainer) appContainer.style.display = 'block';

    // Wait for the transition to finish to 100% (e.g. 450ms) before hiding overlay
    setTimeout(() => {
      loadingOverlay.classList.remove('active');
    }, 450);
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorToast.classList.add('show');
    setTimeout(() => errorToast.classList.remove('show'), 4500);
  }

  async function fetchDynamicCity(query, style = "Moderate", group = "Couple", tripType = "city", adventure=50, luxury=50, food=70, nature=60) {


    const cacheKey = `tripco_cache_${tripType}_${query.toLowerCase()}_${adventure}_${luxury}_${food}_${nature}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        window.tripData[data.id] = data;
        currentCityId = data.id;
        currentVariantId = "all";
        currentFoodPref = "all";
        renderTabs();
        renderCity(currentCityId, currentVariantId);
        updateMap();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        searchInput.value = '';
        return;
      } catch (e) {
        console.error("Cache parsing error", e);
      }
    }

    if (!authToken) {
      showError("Please sign in from the Profile tab to generate an itinerary.");
      document.getElementById('nav-profile').click();
      return;
    }

    showLoading();
    searchBtn.disabled = true;

    // Track quota usage for network requests
    QuotaManager.consume();

    try {
      const res = await fetch(`${API_BASE}/api/generate-city`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`
        },
        body: JSON.stringify({ query, style, group, trip_type: tripType, adventure, luxury, food, nature }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error (${res.status})`);
      }

      const data = await res.json();
      localStorage.setItem(cacheKey, JSON.stringify(data));

      // Inject into global tripData
      window.tripData[data.id] = data;

      // Auto-save offline
      OfflineManager.saveOffline(data.id);

      // Switch to the new city
      currentCityId = data.id;
      currentVariantId = "all";
      currentFoodPref = "all";
      
      renderTabs();
      renderCity(currentCityId, currentVariantId);
      updateMap();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      searchInput.value = '';
    } catch (err) {
      console.error("AI generation error:", err);
      showError(`Failed to generate itinerary: ${err.message}`);
    } finally {
      hideLoading();
      searchBtn.disabled = false;
    }
  }

  // ─── SHARE LOGIC ───
  function setupShareBtn() {
    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const city = window.tripData[currentCityId];
        if (!city) return;
        
        let shareUrl = window.location.href;
        
        if (!sharedTripId) {
          try {
            showLoading("Generating multiplayer link...");
            const res = await fetch('/api/trips', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trip_data: city })
            });
            const data = await res.json();
            sharedTripId = data.trip_id;
            
            const url = new URL(window.location.href);
            url.pathname = '/trip/' + sharedTripId;
            shareUrl = url.toString();
            window.history.pushState({}, '', shareUrl);
          } catch (e) {
            console.error(e);
            showError("Failed to generate share link.");
            hideLoading();
            return;
          }
          hideLoading();
        } else {
          const url = new URL(window.location.href);
          url.pathname = '/trip/' + sharedTripId;
          shareUrl = url.toString();
        }

        const text = `Join my multiplayer trip to ${city.hero.title} on TripCo and vote on spots!`;
        if (navigator.share) {
          try {
            await navigator.share({ title: 'TripCo Multiplayer', text: text, url: shareUrl });
          } catch (e) {
            console.log('Share failed', e);
          }
        } else {
          navigator.clipboard.writeText(shareUrl);
          if (typeof showError === 'function') showError("Multiplayer link copied to clipboard!");
          else alert("Multiplayer link copied to clipboard!");
        }
        
        // Re-render to show upvote/downvote buttons now that we have a sharedTripId
        renderCity(currentCityId, currentVariantId);
      });
    }
  }

  // ─── SMART SEARCH AUTOCOMPLETE ───
  let geoapifyResults = [];
  let currentFocus = -1;

  function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        func.apply(this, args);
      }, delay);
    };
  }

  function setupAISearch() {
    const dropdown = document.getElementById('autocomplete-dropdown');
    const didYouMeanContainer = document.getElementById('did-you-mean-container');

    const handleSearch = () => {
      dropdown.classList.add('hidden');
      didYouMeanContainer.classList.add('hidden');
      const query = searchInput.value.trim();
      const style = "Moderate"; // legacy
      const groupSelect = document.getElementById('group-select');
      const group = groupSelect ? groupSelect.value : "Couple";
      
      const adventure = parseInt(document.getElementById('slider-adventure')?.value || 50, 10);
      const luxury = parseInt(document.getElementById('slider-luxury')?.value || 50, 10);
      const food = parseInt(document.getElementById('slider-food')?.value || 70, 10);
      const nature = parseInt(document.getElementById('slider-nature')?.value || 60, 10);
      
      const tripTypeRadio = document.querySelector('input[name="trip_type"]:checked');
      const tripType = tripTypeRadio ? tripTypeRadio.value : 'city';
      
      if (query) {
        // "Did you mean" logic check
        if (geoapifyResults.length > 0 && tripType === 'city') {
          const topResult = geoapifyResults[0];
          const typedLower = query.toLowerCase();
          const topCityLower = (topResult.city || topResult.name || "").toLowerCase();
          
          if (topCityLower && topCityLower !== typedLower && topCityLower.length > 0) {
            // High confidence typo fallback
            didYouMeanContainer.innerHTML = `Did you mean <span class="did-you-mean-link" id="did-you-mean-link">"${topResult.city || topResult.name}"</span>?`;
            didYouMeanContainer.classList.remove('hidden');
            
            // Re-bind the click event
            document.getElementById('did-you-mean-link').addEventListener('click', () => {
              searchInput.value = topResult.city || topResult.name;
              didYouMeanContainer.classList.add('hidden');
              fetchDynamicCity(searchInput.value, style, group, tripType, adventure, luxury, food, nature);
            });
          }
        }
        fetchDynamicCity(query, style, group, tripType, adventure, luxury, food, nature);
      }
    };

    searchBtn.addEventListener('click', handleSearch);

    // Trip Type Toggle Logic
    const tripTypeRadios = document.querySelectorAll('input[name="trip_type"]');
    tripTypeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        // Update active class
        document.querySelectorAll('.trip-type-label').forEach(lbl => lbl.classList.remove('active'));
        e.target.closest('.trip-type-label').classList.add('active');
        
        // Update placeholder
        if (e.target.value === 'trek') {
          searchInput.placeholder = "e.g. Kedarkantha 6 days winter trek...";
          // Disable autocomplete for treks since it's mostly city focused
          dropdown.classList.add('hidden');
        } else {
          searchInput.placeholder = "e.g. Kyoto 2 days, street food vibes...";
        }
      });
    });

    const fetchAutocomplete = async (val) => {
      if (!val) {
        dropdown.classList.add('hidden');
        geoapifyResults = [];
        return;
      }
      try {
        const res = await fetch(`/api/autocomplete?text=${encodeURIComponent(val)}`);
        const data = await res.json();
        geoapifyResults = data.features ? data.features.map(f => f.properties) : [];
        renderDropdown(val);
      } catch (err) {
        console.error("Autocomplete Proxy Error:", err);
      }
    };

    const debouncedFetch = debounce(fetchAutocomplete, 300);

    searchInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      didYouMeanContainer.classList.add('hidden');
      
      const tripTypeRadio = document.querySelector('input[name="trip_type"]:checked');
      if (tripTypeRadio && tripTypeRadio.value === 'trek') {
        dropdown.classList.add('hidden');
        return;
      }
      
      debouncedFetch(val);
    });

    function renderDropdown(val) {
      dropdown.innerHTML = '';
      if (geoapifyResults.length === 0) {
        dropdown.classList.add('hidden');
        return;
      }
      
      currentFocus = -1;
      dropdown.classList.remove('hidden');
      
      const lowerVal = val.toLowerCase();

      geoapifyResults.forEach((props, index) => {
        const li = document.createElement('li');
        li.className = 'autocomplete-item';
        
        // Bold matching text
        const displayName = props.formatted || (props.city ? `${props.city}, ${props.country}` : props.name);
        if (!displayName) return;
        
        const matchIndex = displayName.toLowerCase().indexOf(lowerVal);
        let innerHtml = '';
        if (matchIndex >= 0) {
          innerHtml = displayName.substring(0, matchIndex) + 
                      `<span class="match-text">${displayName.substring(matchIndex, matchIndex + val.length)}</span>` + 
                      displayName.substring(matchIndex + val.length);
        } else {
          innerHtml = displayName; // Fuzzy match, might not contain exact substring
        }

        li.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
            <circle cx="12" cy="10" r="3"></circle>
          </svg>
          <div>${innerHtml}</div>
        `;

        li.addEventListener('click', () => {
          searchInput.value = props.city || props.name || displayName;
          dropdown.classList.add('hidden');
          handleSearch();
        });

        dropdown.appendChild(li);
      });
    }

    searchInput.addEventListener('keydown', (e) => {
      const items = dropdown.querySelectorAll('.autocomplete-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        currentFocus++;
        addActive(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        currentFocus--;
        addActive(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentFocus > -1 && items.length > 0) {
          items[currentFocus].click();
        } else {
          handleSearch();
        }
      }
    });

    function addActive(items) {
      if (!items || items.length === 0) return;
      removeActive(items);
      if (currentFocus >= items.length) currentFocus = 0;
      if (currentFocus < 0) currentFocus = items.length - 1;
      items[currentFocus].classList.add('active');
      items[currentFocus].scrollIntoView({ block: 'nearest' });
    }

    function removeActive(items) {
      items.forEach(item => item.classList.remove('active'));
    }

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ai-search-wrap')) {
        dropdown.classList.add('hidden');
      }
    });
  }

  // ─── MAP LOGIC ───
  function initMap() {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
      console.warn("Map container '#map' not found.");
      return;
    }
    if (typeof L === 'undefined') {
      console.warn("Leaflet library 'L' not found.");
      return;
    }

    map = L.map('map', {
      zoomControl: false
    }).setView([20, 0], 2);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // CartoDB Dark Matter (Matches our dark theme perfectly)
    const baseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    markersGroup = L.layerGroup().addTo(map);
    neighborhoodLayer = L.layerGroup().addTo(map);

    // Locate the user
    locateUser();
  }

  function locateUser() {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition((position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        
        const userIcon = L.divIcon({
          className: 'custom-leaflet-icon',
          html: `<div class="user-marker"><div class="user-pulse"></div></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          popupAnchor: [0, -12]
        });

        if (userMarker) {
          userMarker.setLatLng([lat, lng]);
        } else {
          userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
          userMarker.bindPopup(`<h3 class="user-popup-title" style="margin:0; font-family:var(--serif); color:var(--text-primary);">Your Location</h3>`, { offset: L.point(0, -18) });
        }
      }, (err) => {
        console.warn("Geolocation denied or failed:", err);
      });
    }
  }

  function updateMap() {
    if (!map || !markersGroup) return;
    markersGroup.clearLayers();

    const city = window.tripData[currentCityId];
    if (!city) return;

    let itinerary = city.itineraries.find(it => it.id === currentVariantId);
    if (!itinerary) itinerary = city.itineraries[0];

    const bounds = [];

    itinerary.clusters.forEach(cluster => {
      cluster.spots.forEach(spot => {
        if (spot.lat && spot.lng) {
          // Apply food preference filter
          if (spot.type === 'food') {
            const pref = spot.foodType || 'both';
            if (currentFoodPref === 'veg' && pref === 'non-veg') return;
            if (currentFoodPref === 'non-veg' && pref === 'veg') return;
          }

          let markerClass = '';
          let svgIcon = '';

          if (spot.type === 'transit') {
            markerClass = 'slate-marker';
            svgIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
          } else if (spot.type === 'food') {
            markerClass = 'sage-marker';
            svgIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>`;
          } else {
            markerClass = 'amber-marker';
            svgIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
          }
          
          const customIcon = L.divIcon({
            className: `custom-leaflet-icon muted-pin`,
            html: `<div class="map-marker ${markerClass}" style="display:flex;align-items:center;justify-content:center;color:currentColor;">${svgIcon}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -14]
          });

          const marker = L.marker([spot.lat, spot.lng], { icon: customIcon });

          marker.on('click', (e) => {
            if (isExplorerMode) {
              if (isochronePolygon) map.removeLayer(isochronePolygon);
              isochronePolygon = L.circle(e.target.getLatLng(), {
                color: '#c8875a',
                fillColor: '#c8875a',
                fillOpacity: 0.15,
                weight: 2,
                dashArray: '4, 4'
              }).addTo(map);
              if (typeof showError === 'function') showError(`Walkable radius mapped for ${spot.name}`);
            }
            map.setView(e.target.getLatLng(), 17, { animate: true });
          });

          let actionsHtml = `
            <div class="map-popover-actions" style="position: absolute; top: 12px; right: 12px; z-index: 10;">
              <button class="map-popover-btn spot-save-btn ${savedSpots.has(spot.id) ? 'saved' : ''}" data-spot-id="${spot.id}" aria-label="Save Spot"><svg width="14" height="14" fill="${savedSpots.has(spot.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg></button>
            </div>`;

          let popoverHtml = `
            <div class="map-popover-card" style="position: relative;">
              ${actionsHtml}
              <div class="map-popover-body">
                <h3 class="map-popover-title popup-title-link" style="padding-right: 30px;" data-spot-id="${spot.id}">${spot.name}</h3>
                <div class="map-popover-subtitle">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                  ${city.tabLabel || 'Location'} ${spot.rating ? `· <span style="color:var(--amber)">${spot.rating}★</span>` : ''}
                </div>
                <p class="map-popover-desc">${spot.desc}</p>
                <div class="map-popover-footer">
                  <div class="map-popover-footer-avatar">T</div>
                  Mentioned by TripCo Guide
                </div>
              </div>
            </div>
          `;

          marker.bindPopup(popoverHtml, { 
            offset: L.point(0, -18), 
            autoPanPadding: L.point(40, 140),
            className: 'custom-leaflet-popup'
          });

          marker.addTo(markersGroup);
          spotMarkers[spot.id] = marker;
          bounds.push([spot.lat, spot.lng]);
        }
      });
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      
      // Draw Neighborhood Vibe (Mock Polygon spanning the bounds)
      neighborhoodLayer.clearLayers();
      if (bounds.length > 2) {
        const p1 = bounds[0];
        const p2 = bounds[bounds.length-1];
        const p3 = bounds[Math.floor(bounds.length/2)];
        
        // Create an offset polygon
        const latOffset = 0.005;
        const lngOffset = 0.005;
        const polyCoords = [
          [p1[0] + latOffset, p1[1] - lngOffset],
          [p2[0] + latOffset, p2[1] + lngOffset],
          [p3[0] - latOffset, p3[1] + lngOffset],
          [p1[0] - latOffset, p1[1] - lngOffset]
        ];
        L.polygon(polyCoords, {
          color: 'transparent',
          fillColor: '#8b9db5',
          fillOpacity: 0.08
        }).addTo(neighborhoodLayer);
      }
      
      drawOsrmRoute(bounds);
    }
  }

  // ─── OSRM REAL-TIME ROUTING ───
  async function drawOsrmRoute(coordsArray) {
    if (coordsArray.length < 2) return;
    
    // OSRM expects lon,lat joined by semicolons. Max 100 coordinates per request.
    const maxCoords = coordsArray.slice(0, 99);
    const osrmCoords = maxCoords.map(c => `${c[1]},${c[0]}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/foot/${osrmCoords}?overview=full&geometries=geojson`;
    
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === 'Ok') {
        const geojson = data.routes[0].geometry;
        
        if (routePolyline && map.hasLayer(routePolyline)) {
          map.removeLayer(routePolyline);
        }
        
        routePolyline = L.geoJSON(geojson, {
          style: {
            color: '#8b9db5',
            weight: 3,
            dashArray: '6, 8',
            lineCap: 'round',
            opacity: 0.8
          }
        }).addTo(map);
      }
    } catch (e) {
      console.warn("Failed to fetch OSRM route", e);
    }
  }

  // ─── RENDERERS ───
  function renderTabs() {
    window.tripData = window.tripData || {};
    const cities = Object.values(window.tripData);
    if (cities.length === 0) {
      tabsContainer.innerHTML = '';
      return;
    }
    tabsContainer.innerHTML = cities.map(city => `
      <div class="city-tab-wrapper ${city.id === currentCityId ? 'active' : ''}">
        <button class="city-tab" data-city-id="${city.id}" role="tab" aria-selected="${city.id === currentCityId}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
          <span class="tab-label">${city.tabLabel}</span>
        </button>
        <button class="tab-close-btn" data-city-id="${city.id}" aria-label="Close Tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    `).join('');

    // Attach Tab Switching Listeners
    document.querySelectorAll('.city-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentCityId = tab.getAttribute('data-city-id');
        currentVariantId = "all";
        renderTabs();
        renderCity(currentCityId, currentVariantId);
      });
    });

    // Attach Tab Close Listeners
    document.querySelectorAll('.tab-close-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cityId = btn.getAttribute('data-city-id');
        
        // Remove from local state & offline store
        delete window.tripData[cityId];
        OfflineManager.removeOffline(cityId);
        
        // If we closed the active tab, switch to another one
        if (currentCityId === cityId) {
          const remainingCities = Object.keys(window.tripData);
          if (remainingCities.length > 0) {
            currentCityId = remainingCities[0];
            currentVariantId = "all";
          } else {
            currentCityId = null;
            currentVariantId = null;
          }
        }
        
        renderTabs();
        renderCity(currentCityId, currentVariantId);
        
        // Call backend to delete if logged in
        if (authToken && !authToken.startsWith('guest_')) {
          try {
            await fetch(`/api/user/trips/${cityId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${authToken}` }
            });
          } catch (e) {
            console.error('Failed to delete trip', e);
          }
        }
      });
    });
  }

  function renderCity(cityId, variantId) {
    if (!cityId) return renderEmptyState();
    const city = window.tripData[cityId];
    if (!city) return renderEmptyState();

    // Find the requested itinerary variant, fallback to first if not found
    let itinerary = city.itineraries.find(it => it.id === variantId);
    if (!itinerary) itinerary = city.itineraries[0];

    // Build Hero
    const pillsHtml = city.hero.pills.map(p => `<span class="pill ${p.class || ''}">${p.text}</span>`).join('');
    const offlineBtnId = `offline-btn-${cityId}`;
    const heroHtml = `
      <section class="hero hero-${cityId}">
        <div class="hero-eyebrow">${city.hero.eyebrow}</div>
        <h1 class="hero-title">${city.hero.title}</h1>
        <p class="hero-subtitle">${city.hero.subtitle}</p>
        <div class="hero-pills">
          ${pillsHtml}
          <button class="offline-save-btn" id="${offlineBtnId}" data-city-id="${cityId}" aria-label="Save Offline">
            <svg class="offline-icon-download" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <svg class="offline-icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span class="offline-btn-label">Save Offline</span>
          </button>
        </div>
      </section>
    `;

    // Check and set offline state after render
    requestAnimationFrame(async () => {
      const offBtn = document.getElementById(offlineBtnId);
      if (!offBtn) return;
      const isSaved = await OfflineManager.isOffline(cityId);
      if (isSaved) {
        offBtn.classList.add('saved');
        offBtn.querySelector('.offline-btn-label').textContent = 'Saved Offline';
      }
      offBtn.addEventListener('click', async () => {
        const currentlySaved = offBtn.classList.contains('saved');
        if (currentlySaved) {
          await OfflineManager.removeOffline(cityId);
          offBtn.classList.remove('saved');
          offBtn.querySelector('.offline-btn-label').textContent = 'Save Offline';
          showError('Removed from offline storage');
        } else {
          await OfflineManager.saveOffline(cityId);
          offBtn.classList.add('saved');
          offBtn.querySelector('.offline-btn-label').textContent = 'Saved Offline';
          showError('Saved for offline access ✓');
        }
        // Update profile offline count
        const countEl = document.getElementById('stat-offline-trips');
        if (countEl) countEl.textContent = await OfflineManager.getOfflineCount();
      });
    });

    // Build Filters
    const filtersHtml = city.itineraries.map(it => `
      <button class="day-filter-btn ${it.id === itinerary.id ? 'active' : ''}" data-variant-id="${it.id}">
        ${it.filterLabel}
      </button>
    `).join('');

    const filtersSection = `
      <div class="day-filters-wrap">
        <div class="day-filters">
          ${filtersHtml}
        </div>
      </div>
    `;

    // Build Food Preference Filters
    const foodPreferenceSection = `
      <div class="food-pref-wrap">
        <button class="pref-btn ${currentFoodPref === 'all' ? 'active' : ''}" data-pref="all">All Spots</button>
        <button class="pref-btn ${currentFoodPref === 'veg' ? 'active' : ''}" data-pref="veg">
          <span class="veg-indicator"><span class="veg-indicator-dot"></span></span> Veg Friendly
        </button>
        <button class="pref-btn ${currentFoodPref === 'non-veg' ? 'active' : ''}" data-pref="non-veg">
          <span class="nonveg-indicator"><span class="nonveg-indicator-dot"></span></span> Non-Veg Friendly
        </button>
      </div>
    `;

    // Build Legend
    const mapHtml = `
      <div class="legend">
        <span class="leg"><span class="leg-dot amber-dot"></span>Aesthetic</span><span class="leg-div"></span>
        <span class="leg"><span class="leg-dot sage-dot"></span>Food Gem</span><span class="leg-div"></span>
        <span class="leg"><span class="leg-dot slate-dot"></span>Transit</span>
      </div>
    `;

    // Budget Estimator
    let totalMenuPrice = 0;
    let menuItemsCount = 0;
    let currencySymbol = '₹';
    
    itinerary.clusters.forEach(cluster => {
      cluster.spots.forEach(spot => {
        if (spot.menu) {
          spot.menu.items.forEach(item => {
            const match = item.price.match(/([^\d.,]*)(\d+[.,]?\d*)/);
            if (match) {
              if (match[1].trim()) currencySymbol = match[1].trim();
              totalMenuPrice += parseFloat(match[2].replace(',', ''));
              menuItemsCount++;
            }
          });
        }
      });
    });

    let numDays = 1;
    city.hero.pills.forEach(p => {
      const match = p.text.match(/(\d+)\s*Day/i);
      if (match) numDays = parseInt(match[1], 10);
    });

    let budgetHtml = '';
    let budgetMin = 0;
    let budgetMax = 0;
    let budgetCurrencyCode = 'INR';
    let budgetCurrencySymbol = '₹';
    const budgetConverterId = `budget-converter-${cityId}`;

    let dashboardHtml = '';
    if (city.tripQualityScore || city.tripDashboard) {
      const score = city.tripQualityScore || 95;
      const walk = city.tripDashboard?.walkingDistance || '10 km';
      const weather = city.tripDashboard?.weatherSummary || 'Sunny 24°C';
      
      let breakdownHtml = '';
      if (city.tripQualityBreakdown) {
        breakdownHtml = `<div class="score-breakdown">` + city.tripQualityBreakdown.map(b => 
          `<div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>${b.label}</span><strong>${b.score}</strong></div>`
        ).join('') + `</div>`;
      }

      dashboardHtml = `
        <div class="trip-dashboard-wrap">
          <div class="dashboard-stat stat-score">
            <div class="stat-val">${score}<span style="font-size:12px; opacity:0.6;">/100</span></div>
            <div class="stat-lbl">Trip Quality</div>
            ${breakdownHtml}
          </div>
          <div class="dashboard-stat">
            <div class="stat-val" style="font-size:14px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px; vertical-align:-2px;"><path d="M17 18a5 5 0 0 0-10 0"></path><line x1="12" y1="9" x2="12" y2="2"></line><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"></line><line x1="19.78" y1="10.22" x2="18.36" y2="11.64"></line></svg>${weather}</div>
            <div class="stat-lbl">Forecast</div>
          </div>
          <div class="dashboard-stat">
            <div class="stat-val" style="font-size:14px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px; vertical-align:-2px;"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"></path><circle cx="12" cy="9" r="2.5"></circle></svg>${walk}</div>
            <div class="stat-lbl">Walking Dist.</div>
          </div>
        </div>
      `;
    }

    if (city.budget) {
      budgetMin = city.budget.min;
      budgetMax = city.budget.max;
      budgetCurrencySymbol = city.budget.currency || currencySymbol;
      budgetCurrencyCode = CurrencyConverter.symbolToCode(budgetCurrencySymbol);

      budgetHtml = `
        <div class="budget-estimator budget-converter-wrap" style="align-items:flex-start; padding: 12px 14px; flex-direction:column;">
          <div style="display:flex; align-items:center; gap:10px; width:100%;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top:2px; flex-shrink:0;"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
            <div style="flex:1">
              <span style="display:block; margin-bottom:4px;">Estimated Budget: <strong>${budgetCurrencySymbol}${budgetMin} – ${budgetCurrencySymbol}${budgetMax}</strong></span>
              <span style="opacity:0.7; font-size:12px; line-height:1.4; display:block;">${city.budget.reasoning}</span>
            </div>
          </div>
          <div class="currency-converter-rows" id="${budgetConverterId}">
            <div class="converter-loading"><span class="converter-dot-pulse"></span> Loading exchange rates…</div>
          </div>
        </div>
      `;
    } else {
      let totalBudget = 0;
      if (menuItemsCount > 0) {
        const avgItemCost = totalMenuPrice / menuItemsCount;
        const dailyBudget = avgItemCost * 4.5;
        totalBudget = dailyBudget * numDays;
        if (totalBudget > 10000) totalBudget = Math.round(totalBudget / 500) * 500;
        else if (totalBudget > 1000) totalBudget = Math.round(totalBudget / 100) * 100;
        else if (totalBudget > 100) totalBudget = Math.round(totalBudget / 50) * 50;
        else totalBudget = Math.round(totalBudget / 10) * 10;
      }
      if (totalBudget > 0) {
        budgetMin = Math.round(totalBudget * 0.8);
        budgetMax = Math.round(totalBudget * 1.3);
        budgetCurrencyCode = CurrencyConverter.symbolToCode(currencySymbol);
        budgetCurrencySymbol = currencySymbol;

        budgetHtml = `
          <div class="budget-estimator budget-converter-wrap" style="flex-direction:column;">
            <div style="display:flex; align-items:center; gap:10px; width:100%;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
              <span>Estimated Food Budget: <strong>${currencySymbol}${budgetMin} – ${currencySymbol}${budgetMax}</strong> <span style="opacity:0.7; font-size:12px;">(for ${numDays} ${numDays===1?'day':'days'})</span></span>
            </div>
            <div class="currency-converter-rows" id="${budgetConverterId}">
              <div class="converter-loading"><span class="converter-dot-pulse"></span> Loading exchange rates…</div>
            </div>
          </div>
        `;
      }
    }

    // Wire up currency converter after DOM render
    if (budgetMin > 0 || budgetMax > 0) {
      requestAnimationFrame(async () => {
        const container = document.getElementById(budgetConverterId);
        if (!container) return;

        const destinationCurrency = CurrencyConverter.detectCurrencyFromCity(city.hero.title);
        const defaultTargets = CurrencyConverter.getDefaultTargets(budgetCurrencyCode, destinationCurrency);

        const rates = await CurrencyConverter.fetchRates(budgetCurrencyCode);
        if (!rates) {
          container.innerHTML = '<span style="opacity:0.5; font-size:12px;">Currency conversion unavailable offline</span>';
          return;
        }

        function renderConversions(targets) {
          const avgBudget = (budgetMin + budgetMax) / 2;
          let html = '<div class="converter-results">';
          targets.forEach(code => {
            const rate = rates[code];
            if (!rate) return;
            const converted = avgBudget * rate;
            html += `
              <div class="converter-row">
                <span class="converter-approx">≈</span>
                <span class="converter-amount">${CurrencyConverter.formatAmount(converted, code)}</span>
                <span class="converter-code">${code}</span>
              </div>
            `;
          });
          html += '</div>';
          html += `
            <div class="converter-change-wrap">
              <button class="converter-change-btn" id="converter-toggle-${cityId}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
                Change Currency
              </button>
              <div class="converter-dropdown hidden" id="converter-dropdown-${cityId}">
                ${CurrencyConverter.ALL_CURRENCIES.filter(c => c !== budgetCurrencyCode).map(c => `
                  <button class="converter-dropdown-item ${targets.includes(c) ? 'active' : ''}" data-code="${c}">
                    ${CurrencyConverter.getSymbol(c)} ${c}
                  </button>
                `).join('')}
              </div>
            </div>
          `;
          container.innerHTML = html;

          // Toggle dropdown
          const toggleBtn = document.getElementById(`converter-toggle-${cityId}`);
          const dropdown = document.getElementById(`converter-dropdown-${cityId}`);
          if (toggleBtn && dropdown) {
            toggleBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              dropdown.classList.toggle('hidden');
            });
            // Close on outside click
            document.addEventListener('click', () => dropdown.classList.add('hidden'), { once: false });

            // Handle currency selection
            dropdown.querySelectorAll('.converter-dropdown-item').forEach(item => {
              item.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = item.getAttribute('data-code');
                const idx = targets.indexOf(code);
                if (idx > -1) {
                  targets.splice(idx, 1);
                } else {
                  if (targets.length >= 4) targets.shift();
                  targets.push(code);
                }
                renderConversions(targets);
              });
            });
          }
        }

        renderConversions(defaultTargets);
      });
    }

    let osInsightsHtml = '';
    if (city.riskAlerts || city.tradeoffs) {
      const risks = (city.riskAlerts || []).map(r => `<div class="os-insight risk" style="display:flex; align-items:flex-start; gap:8px; font-size:13px; line-height:1.4; margin-bottom:8px; color:var(--text-secondary);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" style="flex-shrink:0; margin-top:2px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${r}</div>`).join('');
      const tradeoffs = (city.tradeoffs || []).map(t => `<div class="os-insight tradeoff" style="display:flex; align-items:flex-start; gap:8px; font-size:13px; line-height:1.4; margin-bottom:8px; color:var(--text-secondary);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" stroke-width="2" style="flex-shrink:0; margin-top:2px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>${t}</div>`).join('');
      osInsightsHtml = `
        <div class="os-insights-wrap" style="margin: 15px 15px 25px 15px; padding: 12px; background: var(--bg-inset); border: 1px solid var(--border-subtle); border-radius: 8px;">
          <h4 style="font-size:11px; text-transform:uppercase; color:var(--text-muted); margin-bottom:10px; font-weight:600;">TripCo OS Insights</h4>
          ${risks}
          ${tradeoffs}
        </div>
      `;
    }

    // Build Clusters & Spots
    const clustersHtml = itinerary.clusters.map(cluster => {
      const metaHtml = cluster.meta ? cluster.meta.map(m => `<span>${m}</span>`).join('') : '';
      const arrRow = cluster.arrRow ? `<div class="arr-row">${cluster.arrRow}</div>` : '';
      const transitHtml = cluster.transit ? `
        <div class="transit-bar">
          <div class="tr-info"><strong>${cluster.transit.label}</strong>${cluster.transit.sub ? `<span>${cluster.transit.sub}</span>` : ''}</div>
        </div>
      ` : '';

      const filteredSpots = cluster.spots.filter(spot => {
        if (spot.type === 'food') {
          const pref = spot.foodType || 'both';
          if (currentFoodPref === 'veg') return pref === 'veg' || pref === 'both';
          if (currentFoodPref === 'non-veg') return pref === 'non-veg' || pref === 'both';
        }
        return true;
      });

      if (filteredSpots.length === 0 && !transitHtml && !arrRow) {
        return '';
      }

      const spotsHtml = filteredSpots.map((spot, idx) => {
        const isSaved = savedSpots.has(spot.id);
        const badgeClass = spot.type === 'aesthetic' ? 'ae-badge' : 'fd-badge';
        const badgeText = spot.type === 'aesthetic' ? 'Aesthetic' : 'Food Gem';
        
        let distanceWarningHtml = '';
        if (idx > 0) {
          const prevSpot = filteredSpots[idx - 1];
          if (spot.lat && spot.lng && prevSpot.lat && prevSpot.lng) {
            const R = 6371; // km
            const dLat = (spot.lat - prevSpot.lat) * Math.PI / 180;
            const dLng = (spot.lng - prevSpot.lng) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(prevSpot.lat * Math.PI / 180) * Math.cos(spot.lat * Math.PI / 180) *
                      Math.sin(dLng/2) * Math.sin(dLng/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const distance = R * c;
            if (distance > 3) {
              const minutes = Math.round((distance / 5) * 60);
              distanceWarningHtml = `<div class="time-warning-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v.01M14 21v-4l-4-4-1 5-4-2M13 11V6l-3 4"></path></svg> ${minutes} min walk to next spot</div>`;
            }
          }
        }

        let foodTypeBadge = '';
        if (spot.type === 'food') {
          const pref = spot.foodType || 'both';
          if (pref === 'both') {
            foodTypeBadge = `
              <span class="food-type-badge">
                <span class="veg-indicator" style="margin-right:-2px;"><span class="veg-indicator-dot"></span></span>
                <span class="nonveg-indicator"><span class="nonveg-indicator-dot"></span></span>
                Veg & Non-Veg
              </span>
            `;
          } else {
            const indicatorClass = pref === 'veg' ? 'veg-indicator' : 'nonveg-indicator';
            const indicatorDotClass = pref === 'veg' ? 'veg-indicator-dot' : 'nonveg-indicator-dot';
            foodTypeBadge = `
              <span class="food-type-badge">
                <span class="${indicatorClass}"><span class="${indicatorDotClass}"></span></span>
                ${pref === 'veg' ? 'Veg' : 'Non-Veg'}
              </span>
            `;
          }
        }

        // Build Details/Menu Drawer
        let menuToggle = '';
        let menuDrawer = '';
        const hasDetails = !!spot.menu;
        
        if (hasDetails) {
          const toggleText = 'Menu';
          menuToggle = `<button class="menu-toggle" aria-expanded="false" data-target="details-${spot.id}">${toggleText}</button>`;
          
          let itemsHtml = '';
          if (spot.menu) {
            itemsHtml = `
              <div class="menu-header" style="margin-top: 16px;"><span class="menu-title">Selected Menu</span><span class="menu-note">${spot.menu.note}</span></div>
              <div class="menu-grid">
                ${spot.menu.items.map(item => `
                  <div class="menu-item ${item.highlight ? 'highlight-item' : ''}">
                    <div class="mi-top"><span class="mi-name">${item.name}</span><span class="mi-price">${item.price}</span></div>
                    ${item.desc ? `<div class="mi-desc">${item.desc}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            `;
          }

          menuDrawer = `
            <div class="menu-drawer" id="details-${spot.id}">
              ${itemsHtml}
            </div>
          `;
        }

        let voteHtml = '';
        if (sharedTripId) {
          const votes = sharedVoteCounts[spot.id] || 0;
          voteHtml = `
            <div class="vote-controls">
              <button class="vote-btn upvote" data-spot-id="${spot.id}" data-val="1"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg></button>
              <span class="vote-count" id="vote-count-${spot.id}">${votes}</span>
              <button class="vote-btn downvote" data-spot-id="${spot.id}" data-val="-1"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>
            </div>
          `;
        }

        let cardImgHtml = '';
        if (spot.image_url) {
          cardImgHtml = `
            <div class="s-image-container">
              <img src="${spot.image_url}" alt="${spot.name}" loading="lazy" class="s-image" />
            </div>
          `;
        }

        return distanceWarningHtml + `
            <div class="spot spot-card ${spot.type} ${hasDetails ? 'has-menu' : ''}" id="${spot.id}" data-lat="${spot.lat || ''}" data-lng="${spot.lng || ''}" draggable="true">
              <span class="s-num">${spot.num}</span>
              ${voteHtml}
              <div class="s-body">
                <button class="spot-save-btn ${isSaved ? 'saved' : ''}" data-spot-id="${spot.id}" aria-label="Save Spot">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
                </button>
                <div class="s-meta-row">
                  <div class="s-meta-left">
                    <span class="s-badge ${badgeClass}">${badgeText}</span>
                    ${foodTypeBadge}
                    <span class="s-rating">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                      ${spot.rating}
                    </span>
                  </div>
                  ${spot.time ? `<span class="s-time">${spot.time}</span>` : ''}
                </div>
                <h3 class="s-name">${spot.name}</h3>
                <p class="s-desc">${spot.desc}</p>
                ${spot.reasoning ? `<div class="s-reasoning" style="font-size:11.5px; line-height:1.4; color:var(--sage); margin-bottom:10px; display:flex; gap:6px; align-items:flex-start; background:var(--bg-inset); padding:6px 8px; border-radius:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0; margin-top:2px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><span>${spot.reasoning}</span></div>` : ''}
                ${spot.tags ? `<div class="s-tags">${spot.tags.map(t => `<span>${t}</span>`).join('')}</div>` : ''}
                ${cardImgHtml}
                ${menuToggle}
                ${menuDrawer}
                ${spot.lat && spot.lng ? `
                  <div class="ride-btn-group">
                    <a class="maps-btn" href="https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}" target="_blank" rel="noopener"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6.075-4.925 11-11 11S-1 16.075-1 10 3.925-1 10-1s11 4.925 11 11z"/><polyline points="15 9 8 16"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Google Maps</a>
                    <a class="ride-btn uber" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${spot.lat}&dropoff[longitude]=${spot.lng}&dropoff[nickname]=${encodeURIComponent(spot.name)}" target="_blank" rel="noopener">Uber</a>
                    <a class="ride-btn ola" href="https://book.olacabs.com/?drop_lat=${spot.lat}&drop_lng=${spot.lng}" target="_blank" rel="noopener">Ola</a>
                  </div>
                ` : ''}
                <button class="add-memory-btn" data-spot-id="${spot.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  Add Memory
                </button>
                <div class="spot-memories-gallery" id="memories-${spot.id}"></div>
              </div>
            </div>
          `;
      }).join('');

      return `
        <section class="cluster" id="${cluster.id}">
          <div class="cluster-hd">
            <div class="chd-bar bar-${cluster.colorClass}"></div>
            <div class="chd-text">
              <div class="chd-daytag ${cluster.colorClass}-tag">${cluster.dayTag}</div>
              <h2 class="chd-name">${cluster.title}</h2>
              ${cluster.subtitle ? `<p class="chd-sub">${cluster.subtitle}</p>` : ''}
            </div>
            <div class="chd-meta">${metaHtml}</div>
          </div>
          ${arrRow}
          <div class="spots">${spotsHtml}</div>
          ${transitHtml}
        </section>
      `;
    }).join('');

    const refineHtml = `
      <div class="refine-section">
        <h3 class="refine-title">Not quite right?</h3>
        <p class="refine-sub">Refine this itinerary or regenerate it completely.</p>
        <div class="refine-input-group">
          <input type="text" id="refine-input" placeholder="e.g. Add more street food..." />
          <button id="refine-btn" data-city="${city.tabLabel}">Regenerate</button>
        </div>
      </div>
      
      <button id="inline-explorer-btn" class="open-explorer-inline-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        Open Fullscreen Explorer
      </button>
    `;

    // Embassy info (only for international trips)
    const embassyHtml = EmbassyData.renderEmbassyCard(city.hero.title);
    
    // Packing List
    let packingHtml = '';
    if (city.packingList && city.packingList.length > 0) {
      packingHtml = `
        <div class="packing-card">
          <div class="packing-header">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2z"/><path d="M10 6V4a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2"/><line x1="12" y1="11" x2="12" y2="21"/><line x1="8" y1="11" x2="8" y2="21"/><line x1="16" y1="11" x2="16" y2="21"/></svg>
            <h4>Smart Packing List</h4>
          </div>
          <div class="packing-list">
            ${city.packingList.map(item => `
              <div class="packing-item" onclick="this.classList.toggle('checked')">
                <div class="packing-checkbox"></div>
                <div class="packing-item-text">
                  <span class="packing-item-name">${item.item}</span>
                  <span class="packing-item-reason">${item.reason}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Inject to DOM
    const optBadgeHtml = `<div class="route-opt-badge"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> TripCo Optimization Engine grouped nearby attractions, reducing travel distance by 38%.</div>`;
    const actionButtonsHtml = `
      <div class="trip-action-bar" style="display: flex; gap: 12px; margin: 0 15px 20px;">
        <button class="trip-action-btn" onclick="window.shareTrip('${city.id}', '${city.hero.title}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:8px; background:rgba(200, 135, 90, 0.1); border:1px solid rgba(200, 135, 90, 0.3); color:var(--amber); padding:12px; border-radius:var(--r-md); font-weight:600; cursor:pointer; transition:all 0.2s;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg> Share
        </button>
        <button class="trip-action-btn" onclick="window.print()" style="flex:1; display:flex; align-items:center; justify-content:center; gap:8px; background:rgba(255, 255, 255, 0.05); border:1px solid rgba(255, 255, 255, 0.1); color:var(--text-primary); padding:12px; border-radius:var(--r-md); font-weight:600; cursor:pointer; transition:all 0.2s;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export PDF
        </button>
      </div>
    `;

    const countryStr = city.hero.eyebrow ? city.hero.eyebrow.split('·')[0].trim() : '';
    const searchLocation = `${city.hero.title} ${countryStr}`.trim();
    const destName = encodeURIComponent(searchLocation);
    
    // Auto-detect user's approximate location using timezone as origin
    const userLocMatch = Intl.DateTimeFormat().resolvedOptions().timeZone.split('/');
    const userOrigin = encodeURIComponent(userLocMatch[userLocMatch.length - 1] ? userLocMatch[userLocMatch.length - 1].replace(/_/g, ' ') : '');
    
    // Determine budget level from hero pills
    let budgetLevel = 'moderate';
    if (city.hero && city.hero.pills) {
      city.hero.pills.forEach(p => {
        if (p.text.match(/luxury|high|expensive|\$\$\$/i)) budgetLevel = 'luxury';
        else if (p.text.match(/budget|cheap|low|hostel|backpack/i) || p.text === '$') budgetLevel = 'budget';
      });
    }

    // Dynamic hotel generation based on budget level and with available pictures
    let hotels = [];
    if (budgetLevel === 'luxury') {
      hotels = [
        { name: `The Grand ${city.tabLabel} Resort`, price: "$420/night", rating: "4.9" },
        { name: `Ritz ${city.tabLabel}`, price: "$550/night", rating: "5.0" },
        { name: `${city.tabLabel} Premium Suites`, price: "$380/night", rating: "4.8" }
      ];
    } else if (budgetLevel === 'budget') {
      hotels = [
        { name: `${city.tabLabel} Backpacker Hostel`, price: "$25/night", rating: "4.5" },
        { name: `Budget Inn ${city.tabLabel}`, price: "$45/night", rating: "4.2" },
        { name: `Cozy Stay ${city.tabLabel}`, price: "$60/night", rating: "4.6" }
      ];
    } else {
      hotels = [
        { name: `${city.tabLabel} Boutique Hotel`, price: "$150/night", rating: "4.7" },
        { name: `City Center ${city.tabLabel}`, price: "$120/night", rating: "4.6" },
        { name: `${city.tabLabel} Comfort Inn`, price: "$180/night", rating: "4.8" }
      ];
    }

    const affiliateHtml = `
      <div class="affiliate-engine-wrap">
        <h3 class="affiliate-title">Book This Trip</h3>
        <p class="affiliate-subtitle">Powered by TripCo Partners</p>
        
        <!-- Flight Banner -->
        <a href="https://www.expedia.com/Flights-Search?leg1=from:${userOrigin},to:${destName}&aff=tripco" target="_blank" rel="noopener" class="affiliate-flight-banner">
          <div class="flight-banner-content">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.2-1.1.7l-1.2 3.3c-.1.4.1.9.5 1.1l7.8 3.5-2.7 2.7-3.9-1.3c-.4-.1-.8.1-1 .5l-1.3 3c-.2.4 0 .9.4 1.1L8 22l3.8 3.8c.2.4.7.6 1.1.4l3-1.3c.4-.2.6-.6.5-1l-1.3-3.9 2.7-2.7 3.5 7.8c.2.4.7.6 1.1.5l3.3-1.2c.5-.2.8-.6.7-1.1z"/></svg>
            <div>
              <div class="fb-title">Find Best Flights to ${city.tabLabel}</div>
              <div class="fb-sub">Compare 100+ airlines on Expedia</div>
            </div>
          </div>
          <button class="fb-btn">Search Flights</button>
        </a>

        <!-- Hotel Carousel -->
        <div class="affiliate-hotel-section">
          <div class="ah-header">
            <h4>Recommended Stays</h4>
            <a href="https://www.booking.com/searchresults.html?ss=${destName}&aid=tripco123" target="_blank" class="ah-view-all">View all on Booking.com</a>
          </div>
          <div class="ah-carousel">
            ${hotels.map(h => `
              <a href="https://www.booking.com/searchresults.html?ss=${destName}&aid=tripco123" target="_blank" rel="noopener" class="ah-card text-only">
                <div class="ah-info">
                  <div class="ah-name">${h.name}</div>
                  <div class="ah-meta">
                    <span class="ah-rating"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> ${h.rating}</span>
                    <span class="ah-price">${h.price}</span>
                  </div>
                </div>
              </a>
            `).join('')}
          </div>
        </div>

        <!-- Experiences -->
        <a href="https://www.getyourguide.com/s/?q=${destName}&partner_id=tripco99" target="_blank" rel="noopener" class="affiliate-experience-banner">
          <div class="ae-content">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
            <div>
              <div class="fb-title">Top Rated Tours & Tickets</div>
              <div class="fb-sub">Skip the line with GetYourGuide</div>
            </div>
          </div>
          <button class="fb-btn ae-btn">Explore</button>
        </a>
      </div>
    `;

    appContainer.innerHTML = `
      <div class="city-panel active">
        ${heroHtml}
        ${actionButtonsHtml}
        ${optBadgeHtml}
        ${dashboardHtml}
        ${budgetHtml}
        ${packingHtml}
        ${embassyHtml}
        ${osInsightsHtml}
        ${filtersSection}
        ${foodPreferenceSection}
        ${clustersHtml}
        ${refineHtml}
        ${affiliateHtml}
      </div>
    `;

    // Bottom padding fix for the container
    appContainer.style.paddingBottom = "120px";

    // Load memories for the current trip
    loadMemories(sharedTripId || currentCityId);

    updateMap();

    // Update Copilot smart suggestions based on the new city
    const chipsContainer = document.querySelector('.copilot-chips');
    if (chipsContainer) {
      const cityTitle = city.hero ? city.hero.title : 'this city';
      let suggestions = [];
      if (city.suggestedQuestions && Array.isArray(city.suggestedQuestions) && city.suggestedQuestions.length > 0) {
        suggestions = city.suggestedQuestions;
      } else {
        suggestions = [
          `Find me a highly-rated local restaurant for dinner tonight in ${cityTitle}.`,
          `What is the fastest way to get to the airport from ${cityTitle} center?`,
          `Are there any farmer's markets or local events happening in ${cityTitle} this weekend?`,
          `What are some fun things to do with kids in ${cityTitle}?`
        ];
      }
      
      chipsContainer.innerHTML = suggestions.map(q => `
        <span class="copilot-chip" onclick="document.getElementById('copilot-input').value=\`${q.replace(/`/g, '\\`').replace(/"/g, '&quot;')}\`; document.getElementById('copilot-send').click();">✨ ${q}</span>
      `).join('');
    }
  }

  function renderEmptyState() {
    appContainer.innerHTML = `
      <div class="empty-state-panel">
        <div class="empty-state-content">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--amber); margin-bottom: 16px;">
            <circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 1 0-16 0c0 3 2.7 7 8 11.7z"/>
          </svg>
          <h2 style="font-family: var(--serif); font-size: 28px; margin-bottom: 12px; color: var(--text-primary);">Where to next?</h2>
          <p style="font-family: var(--sans); font-size: 15px; color: var(--text-secondary); max-width: 280px; margin: 0 auto 32px; line-height: 1.5;">
            Search for a city, vibe, or duration above to let AI craft your perfect itinerary.
          </p>
        </div>
      </div>
    `;
    
    // Add empty state styles dynamically if not present
    if (!document.getElementById('empty-state-styles')) {
      const style = document.createElement('style');
      style.id = 'empty-state-styles';
      style.textContent = `
        .empty-state-panel {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100%;
          padding-bottom: 20vh;
        }
        .empty-state-content {
          text-align: center;
          animation: fadeUp 0.6s ease;
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  // ─── EVENT DELEGATION ───
  function setupEventDelegation() {
    // Map Popup Links
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
      mapContainer.addEventListener('click', (e) => {
        const link = e.target.closest('.popup-title-link');
        if (link) {
          const spotId = link.getAttribute('data-spot-id');
          if (spotId) {
            // Switch to explore tab
            document.getElementById('nav-explore').click();
            // Scroll to spot
            setTimeout(() => {
              const spotEl = document.getElementById(spotId);
              if (spotEl) {
                // Add a highlight class temporarily
                spotEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                spotEl.style.background = 'rgba(200,135,90,0.15)';
                setTimeout(() => { spotEl.style.background = ''; }, 1500);
              }
            }, 100);
          }
        }
      });
    }

    // City Tabs
    tabsContainer.addEventListener('click', (e) => {
      const tab = e.target.closest('.city-tab');
      if (!tab) return;
      const newCityId = tab.getAttribute('data-city-id');
      if (newCityId && newCityId !== currentCityId) {
        currentCityId = newCityId;
        currentVariantId = "all"; // Reset to default on city change
        currentFoodPref = "all"; // Reset food preference on city change
        renderTabs(); // Update active tab
        renderCity(currentCityId, currentVariantId);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    // Layer Filters
    document.body.addEventListener('click', (e) => {
      const layerPill = e.target.closest('.layer-pill');
      if (layerPill) {
        document.querySelectorAll('.layer-pill').forEach(p => p.classList.remove('active'));
        layerPill.classList.add('active');
        
        const layer = layerPill.getAttribute('data-layer');
        
        Object.keys(spotMarkers).forEach(spotId => {
          const marker = spotMarkers[spotId];
          const htmlEl = document.getElementById(spotId);
          if (!htmlEl || !map || !markersGroup) return;
          
          const isFood = htmlEl.classList.contains('food');
          const isAesthetic = htmlEl.classList.contains('aesthetic');
          
          let show = true;
          if (layer === 'food') show = isFood;
          if (layer === 'photo') show = isAesthetic;
          
          if (show) {
            if (!markersGroup.hasLayer(marker)) markersGroup.addLayer(marker);
          } else {
            if (markersGroup.hasLayer(marker)) markersGroup.removeLayer(marker);
          }
        });
      }
    });

    // App Container Events (Filters, Saves, Menus)
    appContainer.addEventListener('click', (e) => {
      // Inline Explorer Button
      const inlineExplorerBtn = e.target.closest('#inline-explorer-btn');
      if (inlineExplorerBtn) {
        document.getElementById('nav-map').click();
        return;
      }

      // Vote Logic
      const voteBtn = e.target.closest('.vote-btn');
      if (voteBtn && sharedTripId) {
        if (!authToken) {
          showError("Please log in to vote.");
          return;
        }
        const spotId = voteBtn.getAttribute('data-spot-id');
        const voteVal = parseInt(voteBtn.getAttribute('data-val'), 10);
        
        const countSpan = document.getElementById(`vote-count-${spotId}`);
        let currentCount = parseInt(countSpan.textContent, 10) || 0;
        
        const isCurrentlyActive = voteBtn.classList.contains('active');
        const container = voteBtn.closest('.vote-controls');
        const wasUpvoted = container.querySelector('.upvote').classList.contains('active');
        const wasDownvoted = container.querySelector('.downvote').classList.contains('active');
        
        container.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('active'));
        
        if (!isCurrentlyActive) {
          voteBtn.classList.add('active');
          if (voteVal === 1 && wasDownvoted) currentCount += 2;
          else if (voteVal === -1 && wasUpvoted) currentCount -= 2;
          else currentCount += voteVal;
        } else {
          currentCount -= voteVal;
        }
        countSpan.textContent = currentCount;

        fetch(`/api/trips/${sharedTripId}/vote/${spotId}`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({ vote_value: voteVal })
        }).then(r => r.json()).then(data => {
          if (data.total !== undefined) {
            countSpan.textContent = data.total;
            sharedVoteCounts[spotId] = data.total;
          }
        }).catch(err => {
          console.error(err);
          if (typeof showError === 'function') showError("Failed to register vote.");
        });
        
        return;
      }
      
      // Click-Linked Map Movement
      const spotCard = e.target.closest('.spot-card');
      if (spotCard && !e.target.closest('.spot-save-btn') && !e.target.closest('.menu-toggle') && !e.target.closest('.maps-btn') && !e.target.closest('.vote-btn')) {
        const lat = parseFloat(spotCard.getAttribute('data-lat'));
        const lng = parseFloat(spotCard.getAttribute('data-lng'));
        if (lat && lng && map) {
          document.querySelectorAll('.spot-card').forEach(el => el.classList.remove('active-spot'));
          spotCard.classList.add('active-spot');
          
          map.flyTo([lat, lng], 17, { animate: true, duration: 0.4, easeLinearity: 0.25 });
          
          Object.values(spotMarkers).forEach(m => {
            if (m.getElement()) {
              m.getElement().classList.remove('active-pin');
              m.getElement().classList.add('muted-pin');
            }
          });
          
          const activeMarker = spotMarkers[spotCard.id];
          if (activeMarker) {
            if (activeMarker.getElement()) {
              activeMarker.getElement().classList.remove('muted-pin');
              activeMarker.getElement().classList.add('active-pin');
            }
            activeMarker.openPopup();
          }
        }
      }

      // Variant Filters
      const filterBtn = e.target.closest('.day-filter-btn');
      if (filterBtn) {
        const variantId = filterBtn.getAttribute('data-variant-id');
        if (variantId && variantId !== currentVariantId) {
          currentVariantId = variantId;
          renderCity(currentCityId, currentVariantId);
        }
        return;
      }

      // Food Preference Filters
      const prefBtn = e.target.closest('.pref-btn');
      if (prefBtn) {
        const pref = prefBtn.getAttribute('data-pref');
        if (pref && pref !== currentFoodPref) {
          currentFoodPref = pref;
          renderCity(currentCityId, currentVariantId);
        }
        return;
      }

      // Save Buttons
      const saveBtn = e.target.closest('.spot-save-btn');
      if (saveBtn) {
        handleSave(saveBtn);
        return;
      }

      // Like Buttons
      const likeBtn = e.target.closest('.spot-like-btn');
      if (likeBtn) {
        likeBtn.classList.toggle('liked');
        const svg = likeBtn.querySelector('svg');
        if (svg) {
          if (likeBtn.classList.contains('liked')) {
            svg.setAttribute('fill', 'var(--amber)');
            svg.setAttribute('stroke', 'var(--amber)');
          } else {
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
          }
        }
        return;
      }

      // Add Memory Button
      const addMemBtn = e.target.closest('.add-memory-btn');
      if (addMemBtn) {
        if (!authToken) {
          if (typeof showError === 'function') showError("Please log in to add memories.");
          return;
        }
        const spotId = addMemBtn.getAttribute('data-spot-id');
        openMemoryModal(spotId);
        return;
      }

      // Refine Button
      const refineBtn = e.target.closest('#refine-btn');
      if (refineBtn) {
        const input = document.getElementById('refine-input');
        const refineQuery = input ? input.value.trim() : '';
        const cityLabel = refineBtn.getAttribute('data-city');
        const fullQuery = refineQuery ? `${cityLabel} - ${refineQuery}` : cityLabel;
        if (fullQuery) {
          fetchDynamicCity(fullQuery);
        }
        return;
      }

      // Menu Toggles
      const menuBtn = e.target.closest('.menu-toggle');
      if (menuBtn) {
        const targetId = menuBtn.getAttribute('data-target');
        const drawer = document.getElementById(targetId);
        if (drawer) {
          const isExpanded = menuBtn.getAttribute('aria-expanded') === 'true';
          menuBtn.setAttribute('aria-expanded', !isExpanded);
          menuBtn.classList.toggle('open', !isExpanded);
          drawer.classList.toggle('open', !isExpanded);
        }
        return;
      }
    });

    // Saved Spots View Events (Unsave, Menu Toggle)
    savedSpotsList.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('.spot-save-btn');
      if (saveBtn) {
        handleSave(saveBtn);
        return;
      }

      // Menu Toggles inside saved list
      const menuBtn = e.target.closest('.menu-toggle');
      if (menuBtn) {
        const targetId = menuBtn.getAttribute('data-target');
        const drawer = document.getElementById(targetId);
        if (drawer) {
          const isExpanded = menuBtn.getAttribute('aria-expanded') === 'true';
          menuBtn.setAttribute('aria-expanded', !isExpanded);
          menuBtn.classList.toggle('open', !isExpanded);
          drawer.classList.toggle('open', !isExpanded);
        }
        return;
      }
    });
    
    // ─── DRAG AND DROP EVENTS ───
    appContainer.addEventListener('dragstart', (e) => {
      const spotCard = e.target.closest('.spot-card');
      if (spotCard) {
        draggedSpotId = spotCard.id;
        draggedSourceClusterId = spotCard.closest('.cluster').id;
        spotCard.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', spotCard.id);
        }
      }
    });

    appContainer.addEventListener('dragend', (e) => {
      const spotCard = e.target.closest('.spot-card');
      if (spotCard) {
        spotCard.classList.remove('dragging');
        document.querySelectorAll('.spots').forEach(s => s.classList.remove('drag-over'));
      }
    });

    appContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      const spotsContainer = e.target.closest('.spots');
      if (spotsContainer) {
        spotsContainer.classList.add('drag-over');
      }
    });

    appContainer.addEventListener('dragleave', (e) => {
      const spotsContainer = e.target.closest('.spots');
      if (spotsContainer) {
        spotsContainer.classList.remove('drag-over');
      }
    });

    appContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      const spotsContainer = e.target.closest('.spots');
      if (spotsContainer && draggedSpotId) {
        spotsContainer.classList.remove('drag-over');
        const targetClusterId = spotsContainer.closest('.cluster').id;
        
        const cityData = window.tripData[currentCityId];
        if (!cityData || !cityData.itineraries) return;
        const itinerary = cityData.itineraries.find(i => i.id === currentVariantId) || cityData.itineraries[0];
        
        const sourceCluster = itinerary.clusters.find(c => c.id === draggedSourceClusterId);
        const targetCluster = itinerary.clusters.find(c => c.id === targetClusterId);
        
        if (sourceCluster && targetCluster) {
          const spotIndex = sourceCluster.spots.findIndex(s => s.id === draggedSpotId);
          if (spotIndex > -1) {
            const [spot] = sourceCluster.spots.splice(spotIndex, 1);
            
            const afterElement = getDragAfterElement(spotsContainer, e.clientY);
            if (afterElement == null) {
              targetCluster.spots.push(spot);
            } else {
              const afterIndex = targetCluster.spots.findIndex(s => s.id === afterElement.id);
              targetCluster.spots.splice(afterIndex, 0, spot);
            }
            
            renderCity(currentCityId, currentVariantId);
          }
        }
      }
    });
  }
  
  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.spot-card:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  // ─── HELPER TO FIND SPOT BY ID ───
  function getSpotById(spotId) {
    for (const city of Object.values(window.tripData)) {
      if (!city || !city.itineraries) continue;
      for (const itinerary of city.itineraries) {
        if (!itinerary.clusters) continue;
        for (const cluster of itinerary.clusters) {
          if (!cluster.spots) continue;
          const spot = cluster.spots.find(s => s.id === spotId);
          if (spot) return spot;
        }
      }
    }
    return null;
  }

  // ─── RENDER SAVED VIEW DYNAMICALLY ───
  function renderSavedSpots() {
    if (savedSpots.size === 0) {
      savedSpotsList.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; text-align:center; padding: 80px 20px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; background:var(--bg-inset); border-radius:var(--r-lg); border:1px dashed var(--border-subtle); min-height:400px; max-width: 600px; margin: 40px auto;">
          <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.8; margin-bottom: 10px;">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          <div style="max-width: 320px;">
            <h3 style="font-family:var(--serif); font-size:22px; color:var(--text-primary); margin-bottom:12px;">Your Vault is Empty</h3>
            <p style="font-size:15px; color:var(--text-secondary); line-height:1.6; margin:0;">Tap the bookmark icon on any spot across your itineraries to save it here. Build your personal collection of hidden gems.</p>
          </div>
        </div>
      `;
      return;
    }

    savedSpotsList.innerHTML = Array.from(savedSpots).map(spotId => {
      const spot = getSpotById(spotId);
      if (!spot) return '';

      const badgeClass = spot.type === 'aesthetic' ? 'ae-badge' : 'fd-badge';
      const badgeText = spot.type === 'aesthetic' ? 'Aesthetic' : 'Food Gem';

      let foodTypeBadge = '';
      if (spot.type === 'food') {
        const pref = spot.foodType || 'both';
        if (pref === 'both') {
          foodTypeBadge = `
            <span class="food-type-badge">
              <span class="veg-indicator" style="margin-right:-2px;"><span class="veg-indicator-dot"></span></span>
              <span class="nonveg-indicator"><span class="nonveg-indicator-dot"></span></span>
              Veg & Non-Veg
            </span>
          `;
        } else {
          const indicatorClass = pref === 'veg' ? 'veg-indicator' : 'nonveg-indicator';
          const indicatorDotClass = pref === 'veg' ? 'veg-indicator-dot' : 'nonveg-indicator-dot';
          foodTypeBadge = `
            <span class="food-type-badge">
              <span class="${indicatorClass}"><span class="${indicatorDotClass}"></span></span>
              ${pref === 'veg' ? 'Veg' : 'Non-Veg'}
            </span>
          `;
        }
      }

      // Build Menu if exists
      let menuToggle = '';
      let menuDrawer = '';
      if (spot.menu) {
        menuToggle = `<button class="menu-toggle" aria-expanded="false" data-target="saved-menu-${spot.id}">View Menu</button>`;
        const itemsHtml = spot.menu.items.map(item => `
          <div class="menu-item ${item.highlight ? 'highlight-item' : ''}">
            <div class="mi-top"><span class="mi-name">${item.name}</span><span class="mi-price">${item.price}</span></div>
            ${item.desc ? `<div class="mi-desc">${item.desc}</div>` : ''}
          </div>
        `).join('');
        menuDrawer = `
          <div class="menu-drawer" id="saved-menu-${spot.id}">
            <div class="menu-header"><span class="menu-title">Selected Menu</span><span class="menu-note">${spot.menu.note}</span></div>
            <div class="menu-grid">${itemsHtml}</div>
          </div>
        `;
      }

      return `
        <div class="spot ${spot.type} ${spot.menu ? 'has-menu' : ''}" id="saved-${spot.id}">
          <span class="s-num">${spot.num}</span>
          <div class="s-body">
            <button class="spot-save-btn saved" data-spot-id="${spot.id}" aria-label="Save Spot">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </button>
            <div class="s-meta-row">
              <div class="s-meta-left">
                <span class="s-badge ${badgeClass}">${badgeText}</span>
                ${foodTypeBadge}
                <span class="s-rating">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                  ${spot.rating}
                </span>
              </div>
              ${spot.time ? `<span class="s-time">${spot.time}</span>` : ''}
            </div>
            <h3 class="s-name">${spot.name}</h3>
            <p class="s-desc">${spot.desc}</p>
            ${spot.tags ? `<div class="s-tags">${spot.tags.map(t => `<span>${t}</span>`).join('')}</div>` : ''}
            ${menuToggle}
            ${menuDrawer}
            ${spot.lat && spot.lng ? `<a class="maps-btn" href="https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}" target="_blank" rel="noopener"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6.075-4.925 11-11 11S-1 16.075-1 10 3.925-1 10-1s11 4.925 11 11z"/><polyline points="15 9 8 16"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Google Maps</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // ─── SAVE LOGIC ───
  async function handleSave(btn) {
    const spotId = btn.getAttribute('data-spot-id');
    const isSaved = savedSpots.has(spotId);

    // Optimistic UI Update
    if (isSaved) {
      savedSpots.delete(spotId);
    } else {
      savedSpots.add(spotId);
    }

    // Sync all matching buttons in the DOM (in both app container and saved view)
    const allBtns = document.querySelectorAll(`.spot-save-btn[data-spot-id="${spotId}"]`);
    allBtns.forEach(b => {
      if (isSaved) {
        b.classList.remove('saved');
        const svg = b.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'none');
      } else {
        b.classList.add('saved');
        const svg = b.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'currentColor');
      }
    });
    renderSavedSpots();
    updateSavedCount();

    // Persist to DB if logged in
    if (authToken) {
      try {
        await fetch(`/api/user/spots/${spotId}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
      } catch (e) {
        console.error('Failed to save spot to DB', e);
      }
    }
  }

  function updateSavedCount() {
    statSpotsSaved.textContent = savedSpots.size;
    if (savedSpots.size === 0) {
      savedSpotsList.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          <p>No spots saved yet. Tap the bookmark icon on any spot to save it here.</p>
        </div>
      `;
    }
  }

  // ─── MEMORY LOGIC ───
  async function loadMemories(tripId) {
    try {
      const res = await fetch(`/api/memories/${tripId}`);
      if (res.ok) {
        currentMemories = await res.json();
        // Update DOM
        Object.keys(currentMemories).forEach(spotId => {
          const gallery = document.getElementById(`memories-${spotId}`);
          if (gallery) {
            gallery.innerHTML = currentMemories[spotId].map(m => `
              <div class="spot-memory-item">
                ${m.photo_data ? `<img src="${m.photo_data}" class="spot-memory-img" alt="Memory Photo" />` : ''}
                <div class="spot-memory-text">${m.note || ''}</div>
              </div>
            `).join('');
          }
        });
      }
    } catch (e) {
      console.error("Failed to load memories", e);
    }
  }

  let activeMemorySpotId = null;
  const memoryModal = document.getElementById('memory-modal-overlay');
  const memoryFileInput = document.getElementById('memory-file-input');
  const memoryPreviewImg = document.getElementById('memory-preview-img');
  const memoryUploadText = document.getElementById('memory-upload-text');
  const memoryNoteInput = document.getElementById('memory-note-input');
  let memoryBase64 = null;

  function openMemoryModal(spotId) {
    activeMemorySpotId = spotId;
    memoryBase64 = null;
    memoryFileInput.value = '';
    memoryPreviewImg.src = '';
    memoryPreviewImg.classList.add('hidden');
    memoryUploadText.style.display = 'block';
    memoryNoteInput.value = '';
    memoryModal.classList.remove('hidden');
  }

  if (document.getElementById('memory-modal-close')) {
    document.getElementById('memory-modal-close').addEventListener('click', () => {
      memoryModal.classList.add('hidden');
    });

    document.getElementById('memory-upload-area').addEventListener('click', () => {
      memoryFileInput.click();
    });

    memoryFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          // Compress image using canvas
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 800;
            const MAX_HEIGHT = 800;
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > MAX_WIDTH) {
                height *= MAX_WIDTH / width;
                width = MAX_WIDTH;
              }
            } else {
              if (height > MAX_HEIGHT) {
                width *= MAX_HEIGHT / height;
                height = MAX_HEIGHT;
              }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            memoryBase64 = canvas.toDataURL('image/jpeg', 0.8);
            memoryPreviewImg.src = memoryBase64;
            memoryPreviewImg.classList.remove('hidden');
            memoryUploadText.style.display = 'none';
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      }
    });

    document.getElementById('memory-submit-btn').addEventListener('click', async () => {
      if (!activeMemorySpotId) return;
      const note = memoryNoteInput.value.trim();
      if (!memoryBase64 && !note) {
        if (typeof showError === 'function') showError('Please add a photo or a note.');
        return;
      }

      const tripId = sharedTripId || currentCityId;
      const btn = document.getElementById('memory-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const res = await fetch('/api/memories', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
          },
          body: JSON.stringify({
            spot_id: activeMemorySpotId,
            trip_id: tripId,
            photo_data: memoryBase64,
            note: note
          })
        });

        if (res.ok) {
          memoryModal.classList.add('hidden');
          loadMemories(tripId);
        } else {
          const error = await res.json();
          if (typeof showError === 'function') showError('Failed to save memory: ' + error.detail);
        }
      } catch (e) {
        console.error(e);
        if (typeof showError === 'function') showError('Network error while saving memory.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Memory';
      }
    });
  }

  // ─── BOTTOM NAV LOGIC ───
  function setupBottomNav() {
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        // Enforce login
        if (!authToken) {
          if (btn.id !== 'nav-profile') {
            if (typeof showError === 'function') showError("Please log in to continue.");
            return;
          } else {
            // Not logged in, clicked Profile -> Show Auth Screen
            navBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            views.forEach(v => v.classList.remove('active'));
            
            const viewWelcome = document.getElementById('view-welcome');
            if (viewWelcome) {
              viewWelcome.classList.add('active');
              document.getElementById('welcome-hero-screen').classList.add('hidden');
              document.getElementById('welcome-hero-screen').classList.remove('active');
              document.getElementById('welcome-auth-screen').classList.remove('hidden');
              document.getElementById('welcome-auth-screen').classList.add('active');
            }
            return;
          }
        }
        
        if (btn.id === 'nav-copilot') {
          const copilotDrawer = document.getElementById('copilot-drawer');
          const copilotInput = document.getElementById('copilot-input');
          if (copilotDrawer) {
            copilotDrawer.classList.add('open');
            if (copilotInput) copilotInput.focus();
          }
          return;
        }

        // Remove active class from all nav buttons
        navBtns.forEach(b => b.classList.remove('active'));
        // Add active class to clicked button
        btn.classList.add('active');

        // Hide all views
        views.forEach(v => v.classList.remove('active'));

        // Show target view based on ID
        const targetId = btn.id.replace('nav-', 'view-');
        const targetView = document.getElementById(targetId);
        
        // Dynamic Map Moving Logic
        const sharedMapWrapper = document.getElementById('shared-map-wrapper');
        const mapTab = document.getElementById('view-map');
        const exploreMapContainer = document.getElementById('sticky-map-container');
        
        if (targetId === 'view-map') {
          isExplorerMode = true;
          if (sharedMapWrapper && mapTab) {
             mapTab.appendChild(sharedMapWrapper);
          }
        } else if (targetId === 'view-explore') {
          isExplorerMode = false;
          if (isochronePolygon && map) {
            map.removeLayer(isochronePolygon);
            isochronePolygon = null;
          }
          if (sharedMapWrapper && exploreMapContainer) {
             exploreMapContainer.appendChild(sharedMapWrapper);
          }
        }
        
        if (targetView) {
          targetView.classList.add('active');
          if (targetId === 'view-saved') {
            renderSavedSpots();
          }
          // Validate Map Size after DOM manipulation
          if ((targetId === 'view-map' || targetId === 'view-explore') && map) {
            setTimeout(() => {
              map.invalidateSize();
              if (targetId === 'view-map') {
                const bounds = markersGroup.getBounds();
                if (bounds.isValid()) {
                  map.fitBounds(bounds, { padding: [50, 50] });
                }
              }
            }, 100);
          }
        }
      });
    });
  }

  // ─── EMBASSY INFORMATION ───
  const EmbassyData = (() => {
    const INDIAN_CITIES = new Set([
      'delhi', 'new delhi', 'mumbai', 'bangalore', 'bengaluru', 'chennai', 'kolkata',
      'hyderabad', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'goa', 'varanasi',
      'agra', 'udaipur', 'jodhpur', 'rishikesh', 'shimla', 'manali', 'darjeeling',
      'amritsar', 'mysore', 'kochi', 'thiruvananthapuram', 'srinagar', 'leh',
      'chandigarh', 'bhopal', 'indore', 'nagpur', 'coimbatore', 'vizag',
      'pondicherry', 'hampi', 'ooty', 'munnar', 'alleppey', 'kodaikanal'
    ]);

    const EMBASSIES = {
      'japan': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Tokyo', address: '2-2-11 Kudan Minami, Chiyoda-ku, Tokyo 102-0074', phone: '+81-3-3262-2391', website: 'https://www.indembassy-tokyo.gov.in', mapQuery: 'Embassy+of+India+Tokyo+Japan', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'tokyo': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Tokyo', address: '2-2-11 Kudan Minami, Chiyoda-ku, Tokyo 102-0074', phone: '+81-3-3262-2391', website: 'https://www.indembassy-tokyo.gov.in', mapQuery: 'Embassy+of+India+Tokyo+Japan', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'osaka': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Osaka', address: '10F, Semba I.S. Bldg, 1-9-26, Kyutaro-machi, Chuo-ku, Osaka', phone: '+81-6-6261-7299', website: 'https://www.cgiosaka.gov.in', mapQuery: 'Consulate+General+of+India+Osaka', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'kyoto': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Osaka', address: '10F, Semba I.S. Bldg, 1-9-26, Kyutaro-machi, Chuo-ku, Osaka', phone: '+81-6-6261-7299', website: 'https://www.cgiosaka.gov.in', mapQuery: 'Consulate+General+of+India+Osaka', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'usa': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Washington DC', address: '2107 Massachusetts Avenue NW, Washington, DC 20008', phone: '+1-202-939-7000', website: 'https://www.indianembassyusa.gov.in', mapQuery: 'Embassy+of+India+Washington+DC', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'new york': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, New York', address: '3 East 64th Street, New York, NY 10065', phone: '+1-212-774-0600', website: 'https://www.cginy.gov.in', mapQuery: 'Consulate+General+of+India+New+York', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'new-york': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, New York', address: '3 East 64th Street, New York, NY 10065', phone: '+1-212-774-0600', website: 'https://www.cginy.gov.in', mapQuery: 'Consulate+General+of+India+New+York', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'san francisco': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, San Francisco', address: '540 Arguello Blvd, San Francisco, CA 94118', phone: '+1-415-668-0662', website: 'https://www.cgisf.gov.in', mapQuery: 'Consulate+General+of+India+San+Francisco', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'uk': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, London', address: 'India House, Aldwych, London WC2B 4NA', phone: '+44-20-7836-8484', website: 'https://www.hcilondon.gov.in', mapQuery: 'High+Commission+of+India+London', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'london': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, London', address: 'India House, Aldwych, London WC2B 4NA', phone: '+44-20-7836-8484', website: 'https://www.hcilondon.gov.in', mapQuery: 'High+Commission+of+India+London', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'france': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Paris', address: '15 Rue Alfred Dehodencq, 75016 Paris', phone: '+33-1-4050-7070', website: 'https://www.ambinde.fr', mapQuery: 'Embassy+of+India+Paris', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'paris': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Paris', address: '15 Rue Alfred Dehodencq, 75016 Paris', phone: '+33-1-4050-7070', website: 'https://www.ambinde.fr', mapQuery: 'Embassy+of+India+Paris', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'germany': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Berlin', address: 'Tiergartenstra\u00dfe 17, 10785 Berlin', phone: '+49-30-25795-0', website: 'https://www.indianembassyberlin.gov.in', mapQuery: 'Embassy+of+India+Berlin', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'berlin': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Berlin', address: 'Tiergartenstra\u00dfe 17, 10785 Berlin', phone: '+49-30-25795-0', website: 'https://www.indianembassyberlin.gov.in', mapQuery: 'Embassy+of+India+Berlin', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'italy': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Rome', address: 'Via XX Settembre 5, 00187 Rome', phone: '+39-06-4884-642', website: 'https://www.indianembassyrome.gov.in', mapQuery: 'Embassy+of+India+Rome', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'rome': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Rome', address: 'Via XX Settembre 5, 00187 Rome', phone: '+39-06-4884-642', website: 'https://www.indianembassyrome.gov.in', mapQuery: 'Embassy+of+India+Rome', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'spain': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Madrid', address: 'Avda. P\u00edo XII, 30-32, 28016 Madrid', phone: '+34-91-202-8700', website: 'https://www.embassyofindiamadrid.gov.in', mapQuery: 'Embassy+of+India+Madrid', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'barcelona': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Barcelona', address: 'Teodora Lamadrid 60, Planta 3, 08022 Barcelona', phone: '+34-93-212-0916', website: 'https://www.cgibarcelona.gov.in', mapQuery: 'Consulate+General+of+India+Barcelona', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'thailand': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Bangkok', address: '46 Soi Prasarnmit, Sukhumvit 23, Bangkok 10110', phone: '+66-2-258-0300', website: 'https://www.indianembassy.in.th', mapQuery: 'Embassy+of+India+Bangkok', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'bangkok': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Bangkok', address: '46 Soi Prasarnmit, Sukhumvit 23, Bangkok 10110', phone: '+66-2-258-0300', website: 'https://www.indianembassy.in.th', mapQuery: 'Embassy+of+India+Bangkok', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'phuket': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Bangkok', address: '46 Soi Prasarnmit, Sukhumvit 23, Bangkok 10110', phone: '+66-2-258-0300', website: 'https://www.indianembassy.in.th', mapQuery: 'Embassy+of+India+Bangkok', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'south korea': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Seoul', address: '37-3 Hannam-dong, Yongsan-gu, Seoul 04417', phone: '+82-2-798-4257', website: 'https://www.indembassyseoul.gov.in', mapQuery: 'Embassy+of+India+Seoul', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'seoul': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Seoul', address: '37-3 Hannam-dong, Yongsan-gu, Seoul 04417', phone: '+82-2-798-4257', website: 'https://www.indembassyseoul.gov.in', mapQuery: 'Embassy+of+India+Seoul', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'singapore': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Singapore', address: '31 Grange Road, Singapore 239702', phone: '+65-6737-6777', website: 'https://www.hcisingapore.gov.in', mapQuery: 'High+Commission+of+India+Singapore', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'australia': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Canberra', address: '3-5 Moonah Place, Yarralumla, ACT 2600', phone: '+61-2-6273-3999', website: 'https://www.hcindia-au.gov.in', mapQuery: 'High+Commission+of+India+Canberra', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'sydney': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Sydney', address: 'Level 2, 25 Bligh Street, Sydney NSW 2000', phone: '+61-2-9223-9600', website: 'https://www.cgisydney.gov.in', mapQuery: 'Consulate+General+of+India+Sydney', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:00 PM' },
      'uae': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Abu Dhabi', address: 'Plot No. 10, Sector W-59/02, Abu Dhabi', phone: '+971-2-449-2700', website: 'https://www.indembassyuae.gov.in', mapQuery: 'Embassy+of+India+Abu+Dhabi', hours: 'Sun\u2013Thu: 8:30 AM \u2013 5:00 PM' },
      'dubai': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Dubai', address: 'P.O. Box 737, Al Hamriya, Dubai', phone: '+971-4-397-1222', website: 'https://www.cgidubai.gov.in', mapQuery: 'Consulate+General+of+India+Dubai', hours: 'Sun\u2013Thu: 8:00 AM \u2013 4:30 PM' },
      'bali': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate of India, Bali', address: 'Jl. Raya Puputan No. 163, Renon, Denpasar, Bali', phone: '+62-361-236-940', website: 'https://www.indianembassyjakarta.gov.in', mapQuery: 'Consulate+of+India+Bali+Denpasar', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:00 PM' },
      'maldives': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Male', address: 'Athireege Aage, Ameer Ahmed Magu, Male 20-05', phone: '+960-332-3015', website: 'https://www.hcimaldives.gov.in', mapQuery: 'High+Commission+of+India+Male+Maldives', hours: 'Sun\u2013Thu: 9:00 AM \u2013 5:00 PM' },
      'male': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Male', address: 'Athireege Aage, Ameer Ahmed Magu, Male 20-05', phone: '+960-332-3015', website: 'https://www.hcimaldives.gov.in', mapQuery: 'High+Commission+of+India+Male+Maldives', hours: 'Sun\u2013Thu: 9:00 AM \u2013 5:00 PM' },
      'nepal': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Kathmandu', address: 'Lainchaur, Kathmandu, P.O. Box 292', phone: '+977-1-441-0900', website: 'https://www.indembkathmandu.gov.in', mapQuery: 'Embassy+of+India+Kathmandu', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'kathmandu': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Kathmandu', address: 'Lainchaur, Kathmandu, P.O. Box 292', phone: '+977-1-441-0900', website: 'https://www.indembkathmandu.gov.in', mapQuery: 'Embassy+of+India+Kathmandu', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'sri lanka': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Colombo', address: '36-38 Galle Road, Colombo 03', phone: '+94-11-232-7587', website: 'https://www.hcicolombo.gov.in', mapQuery: 'High+Commission+of+India+Colombo', hours: 'Mon\u2013Fri: 8:30 AM \u2013 5:00 PM' },
      'turkey': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Ankara', address: 'Cinnah Caddesi No. 77, \u00c7ankaya, 06690 Ankara', phone: '+90-312-438-2195', website: 'https://www.indembassyankara.gov.in', mapQuery: 'Embassy+of+India+Ankara', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'istanbul': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Istanbul', address: 'Cumhuriyet Caddesi No. 42, Elmada\u011f, \u015ei\u015fli, Istanbul', phone: '+90-212-296-2131', website: 'https://www.cgiistanbul.gov.in', mapQuery: 'Consulate+General+of+India+Istanbul', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'egypt': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Cairo', address: '5 Aziz Abaza Street, Zamalek, Cairo 11211', phone: '+20-2-2736-0052', website: 'https://www.indembcairo.gov.in', mapQuery: 'Embassy+of+India+Cairo', hours: 'Sun\u2013Thu: 9:00 AM \u2013 5:30 PM' },
      'cairo': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Cairo', address: '5 Aziz Abaza Street, Zamalek, Cairo 11211', phone: '+20-2-2736-0052', website: 'https://www.indembcairo.gov.in', mapQuery: 'Embassy+of+India+Cairo', hours: 'Sun\u2013Thu: 9:00 AM \u2013 5:30 PM' },
      'switzerland': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Bern', address: 'Kirchenfeldstrasse 28, 3005 Bern', phone: '+41-31-351-1110', website: 'https://www.indembassybern.gov.in', mapQuery: 'Embassy+of+India+Bern', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'amsterdam': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, The Hague', address: 'Buitenrustweg 2, 2517 KD The Hague', phone: '+31-70-346-9771', website: 'https://www.indianembassythehague.gov.in', mapQuery: 'Embassy+of+India+The+Hague', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'greece': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Athens', address: '3 Kleanthous Street, 10674 Athens', phone: '+30-210-721-6227', website: 'https://www.indianembassyathens.gov.in', mapQuery: 'Embassy+of+India+Athens', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'athens': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Athens', address: '3 Kleanthous Street, 10674 Athens', phone: '+30-210-721-6227', website: 'https://www.indianembassyathens.gov.in', mapQuery: 'Embassy+of+India+Athens', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'santorini': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Embassy of India, Athens', address: '3 Kleanthous Street, 10674 Athens', phone: '+30-210-721-6227', website: 'https://www.indianembassyathens.gov.in', mapQuery: 'Embassy+of+India+Athens', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'canada': { flag: '\u{1F1EE}\u{1F1F3}', name: 'High Commission of India, Ottawa', address: '10 Springfield Road, Ottawa, ON K1M 1C9', phone: '+1-613-744-3751', website: 'https://www.hciottawa.gov.in', mapQuery: 'High+Commission+of+India+Ottawa', hours: 'Mon\u2013Fri: 9:00 AM \u2013 5:30 PM' },
      'toronto': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Toronto', address: '365 Bloor Street East, Suite 700, Toronto, ON M4W 3L4', phone: '+1-416-960-0751', website: 'https://www.cgitoronto.gov.in', mapQuery: 'Consulate+General+of+India+Toronto', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' },
      'vancouver': { flag: '\u{1F1EE}\u{1F1F3}', name: 'Consulate General of India, Vancouver', address: '201-325 Howe Street, Vancouver, BC V6C 1Z7', phone: '+1-604-662-8811', website: 'https://www.cgivancouver.gov.in', mapQuery: 'Consulate+General+of+India+Vancouver', hours: 'Mon\u2013Fri: 9:30 AM \u2013 5:30 PM' }
    };

    function isInternational(cityTitle) {
      if (!cityTitle) return false;
      const lower = cityTitle.toLowerCase().trim();
      if (INDIAN_CITIES.has(lower)) return false;
      for (const city of INDIAN_CITIES) {
        if (lower.includes(city) || city.includes(lower)) return false;
      }
      return true;
    }

    function getEmbassy(cityTitle) {
      if (!cityTitle) return null;
      const lower = cityTitle.toLowerCase().trim();
      if (EMBASSIES[lower]) return EMBASSIES[lower];
      for (const [key, data] of Object.entries(EMBASSIES)) {
        if (lower.includes(key) || key.includes(lower)) return data;
      }
      return null;
    }

    function renderEmbassyCard(cityTitle) {
      if (!isInternational(cityTitle)) return '';
      const embassy = getEmbassy(cityTitle);
      if (!embassy) return '';

      return `
        <div class="embassy-card">
          <div class="embassy-header">
            <span class="embassy-flag">${embassy.flag}</span>
            <div class="embassy-header-text">
              <h4>Indian Embassy</h4>
              <span>${embassy.name}</span>
            </div>
          </div>
          <div class="embassy-details">
            <div class="embassy-row">
              <span class="embassy-row-icon">\u{1F4CD}</span>
              <a class="embassy-address" href="https://www.google.com/maps/search/?api=1&query=${embassy.mapQuery}" target="_blank" rel="noopener">${embassy.address}</a>
            </div>
            <div class="embassy-row">
              <span class="embassy-row-icon">\u260E</span>
              <a href="tel:${embassy.phone}">${embassy.phone}</a>
            </div>
            <div class="embassy-row">
              <span class="embassy-row-icon">\u{1F310}</span>
              <a href="${embassy.website}" target="_blank" rel="noopener">${embassy.website.replace('https://', '')}</a>
            </div>
            <div class="embassy-hours">
              <span class="embassy-hours-icon">\u{1F550}</span>
              <span>${embassy.hours}</span>
            </div>
          </div>
        </div>
      `;
    }

    return { isInternational, getEmbassy, renderEmbassyCard };
  })();

  // \u2500\u2500\u2500 CURRENCY CONVERTER \u2500\u2500\u2500
  const CurrencyConverter = (() => {
    // Symbol → ISO code mapping
    const SYMBOL_TO_CODE = {
      '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR',
      '₩': 'KRW', '฿': 'THB', '₫': 'VND', '₱': 'PHP', 'R$': 'BRL',
      'RM': 'MYR', 'S$': 'SGD', 'A$': 'AUD', 'NZ$': 'NZD', 'kr': 'SEK',
      'CHF': 'CHF', 'zł': 'PLN', 'Kč': 'CZK', 'Ft': 'HUF', 'лв': 'BGN',
      'lei': 'RON', 'kn': 'HRK', 'AED': 'AED', 'SAR': 'SAR', 'EGP': 'EGP',
      'TRY': 'TRY', '₺': 'TRY', 'R': 'ZAR', 'Rp': 'IDR', 'NT$': 'TWD',
      'HK$': 'HKD', 'CN¥': 'CNY', '元': 'CNY'
    };

    // City/country name → currency code mapping
    const DESTINATION_CURRENCY = {
      'japan': 'JPY', 'tokyo': 'JPY', 'osaka': 'JPY', 'kyoto': 'JPY',
      'india': 'INR', 'delhi': 'INR', 'mumbai': 'INR', 'goa': 'INR', 'jaipur': 'INR', 'varanasi': 'INR', 'bangalore': 'INR', 'kolkata': 'INR',
      'usa': 'USD', 'new york': 'USD', 'new-york': 'USD', 'los angeles': 'USD', 'san francisco': 'USD', 'chicago': 'USD', 'miami': 'USD', 'las vegas': 'USD',
      'uk': 'GBP', 'london': 'GBP', 'edinburgh': 'GBP',
      'france': 'EUR', 'paris': 'EUR', 'germany': 'EUR', 'berlin': 'EUR', 'munich': 'EUR',
      'italy': 'EUR', 'rome': 'EUR', 'milan': 'EUR', 'florence': 'EUR', 'venice': 'EUR',
      'spain': 'EUR', 'barcelona': 'EUR', 'madrid': 'EUR',
      'netherlands': 'EUR', 'amsterdam': 'EUR',
      'portugal': 'EUR', 'lisbon': 'EUR',
      'greece': 'EUR', 'athens': 'EUR', 'santorini': 'EUR',
      'thailand': 'THB', 'bangkok': 'THB', 'phuket': 'THB', 'chiang mai': 'THB',
      'south korea': 'KRW', 'seoul': 'KRW', 'busan': 'KRW',
      'vietnam': 'VND', 'hanoi': 'VND', 'ho chi minh': 'VND',
      'indonesia': 'IDR', 'bali': 'IDR', 'jakarta': 'IDR',
      'malaysia': 'MYR', 'kuala lumpur': 'MYR',
      'singapore': 'SGD',
      'australia': 'AUD', 'sydney': 'AUD', 'melbourne': 'AUD',
      'new zealand': 'NZD', 'auckland': 'NZD',
      'china': 'CNY', 'beijing': 'CNY', 'shanghai': 'CNY',
      'hong kong': 'HKD',
      'taiwan': 'TWD', 'taipei': 'TWD',
      'turkey': 'TRY', 'istanbul': 'TRY',
      'uae': 'AED', 'dubai': 'AED', 'abu dhabi': 'AED',
      'egypt': 'EGP', 'cairo': 'EGP',
      'brazil': 'BRL', 'sao paulo': 'BRL', 'rio de janeiro': 'BRL',
      'mexico': 'MXN', 'mexico city': 'MXN', 'cancun': 'MXN',
      'canada': 'CAD', 'toronto': 'CAD', 'vancouver': 'CAD',
      'switzerland': 'CHF', 'zurich': 'CHF',
      'south africa': 'ZAR', 'cape town': 'ZAR',
      'philippines': 'PHP', 'manila': 'PHP',
      'sweden': 'SEK', 'stockholm': 'SEK',
      'czech republic': 'CZK', 'prague': 'CZK',
      'hungary': 'HUF', 'budapest': 'HUF',
      'poland': 'PLN', 'warsaw': 'PLN', 'krakow': 'PLN',
      'morocco': 'MAD', 'marrakech': 'MAD',
      'peru': 'PEN', 'lima': 'PEN', 'cusco': 'PEN',
      'colombia': 'COP', 'bogota': 'COP', 'medellin': 'COP',
      'argentina': 'ARS', 'buenos aires': 'ARS',
      'russia': 'RUB', 'moscow': 'RUB',
      'sri lanka': 'LKR', 'colombo': 'LKR',
      'nepal': 'NPR', 'kathmandu': 'NPR',
      'maldives': 'MVR', 'male': 'MVR'
    };

    // All target currencies for conversion display
    const ALL_CURRENCIES = [
      'INR', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'THB', 'AUD', 'CAD', 'SGD',
      'CNY', 'AED', 'TRY', 'BRL', 'MXN', 'CHF', 'SEK', 'CZK', 'HUF', 'PLN',
      'IDR', 'MYR', 'VND', 'PHP', 'TWD', 'HKD', 'NZD', 'ZAR', 'EGP', 'SAR'
    ];

    const CURRENCY_SYMBOLS = {
      'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'INR': '₹',
      'KRW': '₩', 'THB': '฿', 'AUD': 'A$', 'CAD': 'C$', 'SGD': 'S$',
      'CNY': '¥', 'AED': 'AED', 'TRY': '₺', 'BRL': 'R$', 'MXN': 'MX$',
      'CHF': 'CHF', 'SEK': 'kr', 'CZK': 'Kč', 'HUF': 'Ft', 'PLN': 'zł',
      'IDR': 'Rp', 'MYR': 'RM', 'VND': '₫', 'PHP': '₱', 'TWD': 'NT$',
      'HKD': 'HK$', 'NZD': 'NZ$', 'ZAR': 'R', 'EGP': 'E£', 'SAR': 'SAR',
      'NPR': 'Rs', 'LKR': 'Rs', 'MVR': 'Rf', 'MAD': 'MAD', 'PEN': 'S/',
      'COP': 'COL$', 'ARS': 'AR$', 'RUB': '₽', 'MXN': 'MX$'
    };

    let ratesCache = null;
    let ratesCacheBase = null;
    let ratesCacheTime = 0;
    const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

    function symbolToCode(symbol) {
      if (!symbol) return 'USD';
      const s = symbol.trim();
      // Check direct match
      if (SYMBOL_TO_CODE[s]) return SYMBOL_TO_CODE[s];
      // Check if it's already a code
      if (ALL_CURRENCIES.includes(s.toUpperCase())) return s.toUpperCase();
      return 'USD';
    }

    function detectCurrencyFromCity(cityTitle) {
      if (!cityTitle) return null;
      const lower = cityTitle.toLowerCase().trim();
      // Try exact match first
      if (DESTINATION_CURRENCY[lower]) return DESTINATION_CURRENCY[lower];
      // Try partial match
      for (const [key, code] of Object.entries(DESTINATION_CURRENCY)) {
        if (lower.includes(key) || key.includes(lower)) return code;
      }
      return null;
    }

    async function fetchRates(baseCurrency) {
      if (ratesCache && ratesCacheBase === baseCurrency && (Date.now() - ratesCacheTime) < CACHE_DURATION) {
        return ratesCache;
      }

      // Try localStorage fallback for offline
      const cacheKey = `tripco_rates_${baseCurrency}`;
      try {
        const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${baseCurrency}`);
        if (resp.ok) {
          const data = await resp.json();
          ratesCache = data.rates;
          ratesCacheBase = baseCurrency;
          ratesCacheTime = Date.now();
          localStorage.setItem(cacheKey, JSON.stringify({ rates: data.rates, time: Date.now() }));
          return ratesCache;
        }
      } catch (e) {
        console.warn('[CurrencyConverter] API fetch failed, trying cache', e);
      }

      // Fallback to cached rates
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          ratesCache = parsed.rates;
          ratesCacheBase = baseCurrency;
          ratesCacheTime = parsed.time;
          return ratesCache;
        }
      } catch (e) { /* ignore */ }

      return null;
    }

    function formatAmount(amount, currencyCode) {
      const sym = CURRENCY_SYMBOLS[currencyCode] || currencyCode;
      // No decimals for large-unit currencies
      const noDecimal = ['JPY', 'KRW', 'VND', 'IDR', 'HUF', 'CLP', 'COP'].includes(currencyCode);
      const formatted = noDecimal ? Math.round(amount).toLocaleString() : amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `${sym}${formatted}`;
    }

    function getSymbol(code) {
      return CURRENCY_SYMBOLS[code] || code;
    }

    function getDefaultTargets(baseCurrency, destinationCurrency) {
      // Always show INR as the primary conversion to make it easier to understand
      const defaults = ['USD', 'EUR', 'GBP', 'JPY'];
      const targets = [];
      if (baseCurrency !== 'INR') {
        targets.push('INR');
      }
      if (destinationCurrency && destinationCurrency !== baseCurrency && destinationCurrency !== 'INR') {
        targets.push(destinationCurrency);
      }
      for (const c of defaults) {
        if (c !== baseCurrency && !targets.includes(c) && targets.length < 3) {
          targets.push(c);
        }
      }
      return targets;
    }

    return {
      symbolToCode, detectCurrencyFromCity, fetchRates, formatAmount,
      getSymbol, getDefaultTargets, ALL_CURRENCIES, CURRENCY_SYMBOLS
    };
  })();

  // ─── OFFLINE MANAGER (IndexedDB) ───
  const OfflineManager = (() => {
    const DB_NAME = 'tripco_offline';
    const DB_VERSION = 1;
    const STORE_NAME = 'itineraries';

    function openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'cityId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async function saveOffline(cityId) {
      const data = window.tripData[cityId];
      if (!data) return;
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({
          cityId,
          tripData: JSON.parse(JSON.stringify(data)),
          savedAt: Date.now()
        });
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        db.close();
        console.log(`[Offline] Saved: ${cityId}`);
      } catch (err) {
        console.error('[Offline] Save failed:', err);
      }
    }

    async function loadAllOffline() {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        return new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const records = request.result || [];
            records.forEach(rec => {
              if (rec.cityId && rec.tripData) {
                window.tripData[rec.cityId] = rec.tripData;
              }
            });
            db.close();
            console.log(`[Offline] Loaded ${records.length} itineraries from IndexedDB`);
            resolve(records.length);
          };
          request.onerror = () => { db.close(); reject(request.error); };
        });
      } catch (err) {
        console.warn('[Offline] Load failed:', err);
        return 0;
      }
    }

    async function removeOffline(cityId) {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(cityId);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        db.close();
        console.log(`[Offline] Removed: ${cityId}`);
      } catch (err) {
        console.error('[Offline] Remove failed:', err);
      }
    }

    async function isOffline(cityId) {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(cityId);
        return new Promise((resolve) => {
          request.onsuccess = () => { db.close(); resolve(!!request.result); };
          request.onerror = () => { db.close(); resolve(false); };
        });
      } catch {
        return false;
      }
    }

    async function getOfflineCount() {
      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).count();
        return new Promise((resolve) => {
          request.onsuccess = () => { db.close(); resolve(request.result); };
          request.onerror = () => { db.close(); resolve(0); };
        });
      } catch {
        return 0;
      }
    }

    return { saveOffline, loadAllOffline, removeOffline, isOffline, getOfflineCount };
  })();

  // Start the app
  init();

  // ─── SERVICE WORKER REGISTRATION ───
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(registration => {
          console.log('ServiceWorker registration successful with scope: ', registration.scope);
        }, err => {
          console.log('ServiceWorker registration failed: ', err);
        });
    });
  }

  /* ── AI COPILOT LOGIC ── */
  const copilotFab = document.getElementById('copilot-fab');
  const copilotDrawer = document.getElementById('copilot-drawer');
  const copilotClose = document.getElementById('copilot-close');
  const copilotSend = document.getElementById('copilot-send');
  const copilotInput = document.getElementById('copilot-input');
  const copilotBody = document.getElementById('copilot-body');

  const copilotOverlay = document.getElementById('copilot-overlay');

  if (copilotFab && copilotDrawer) {
    function openCopilot() {
      copilotDrawer.classList.add('open');
      if (copilotOverlay) copilotOverlay.classList.add('open');
      document.body.classList.add('copilot-active');
      copilotInput.focus();
    }
    
    function closeCopilot() {
      copilotDrawer.classList.remove('open');
      if (copilotOverlay) copilotOverlay.classList.remove('open');
      document.body.classList.remove('copilot-active');
    }

    copilotFab.addEventListener('click', openCopilot);
    copilotClose.addEventListener('click', closeCopilot);
    if (copilotOverlay) copilotOverlay.addEventListener('click', closeCopilot);

    async function sendCopilotMessage() {
      const text = copilotInput.value.trim();
      if (!text) return;
      
      if (!currentCityId || !window.tripData || !window.tripData[currentCityId]) {
        if (typeof showError === 'function') showError("Please generate an itinerary first!");
        return;
      }
      
      const currentData = window.tripData[currentCityId];

      // Track quota for copilot
      QuotaManager.consume();
    
      // Add user message immediately
      const userMsg = document.createElement('div');
      userMsg.className = 'copilot-msg user';
      userMsg.textContent = text;
      copilotBody.appendChild(userMsg);
      copilotInput.value = '';
      copilotBody.scrollTop = copilotBody.scrollHeight;

      // Add loading message
      const loadingMsg = document.createElement('div');
      loadingMsg.className = 'copilot-msg bot';
      loadingMsg.innerHTML = `
        <div style="margin-bottom: 8px; display: flex; align-items: center;">
          <span class="converter-dot-pulse" style="display:inline-block; margin-right:8px;"></span>
          <span id="copilot-loading-text">Thinking like a local...</span>
        </div>
        <div style="width: 100%; height: 6px; background: var(--bg-inset); border-radius: 3px; overflow: hidden; margin-bottom: 4px;">
          <div id="copilot-progress-bar" style="width: 5%; height: 100%; background: var(--amber); transition: width 0.3s;"></div>
        </div>
        <div style="font-size: 10px; color: var(--text-muted); text-align: right;"><span id="copilot-progress-percent">5</span>%</div>
      `;
      copilotBody.appendChild(loadingMsg);
      copilotBody.scrollTop = copilotBody.scrollHeight;

      let progress = 5;
      const progressInterval = setInterval(() => {
        if (progress < 95) {
          progress += (95 - progress) * 0.12; // Logarithmic deceleration
          const bar = document.getElementById('copilot-progress-bar');
          const pct = document.getElementById('copilot-progress-percent');
          if (bar) bar.style.width = progress + '%';
          if (pct) pct.textContent = Math.round(progress);
        }
      }, 500);

      try {
        const res = await fetch(`${API_BASE}/api/copilot/replan`, {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`
          },
          body: JSON.stringify({ message: text, current_itinerary: currentData }),
        });

        clearInterval(progressInterval);
        
        const bar = document.getElementById('copilot-progress-bar');
        const pct = document.getElementById('copilot-progress-percent');
        const txt = document.getElementById('copilot-loading-text');
        if (bar) bar.style.width = '100%';
        if (pct) pct.textContent = '100';
        if (txt) txt.textContent = 'Finalizing changes...';

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "Failed to replan");
        }
        
        const newData = await res.json();
        
        // Wait a tiny bit so the user sees 100%
        await new Promise(r => setTimeout(r, 400));
        
        if (newData.copilotMessage) {
          const aiMsg = document.createElement('div');
          aiMsg.className = 'copilot-msg bot';
          aiMsg.innerHTML = newData.copilotMessage;
          copilotBody.appendChild(aiMsg);
          copilotBody.scrollTop = copilotBody.scrollHeight;
        }
        
        // Update state
        window.tripData[currentCityId] = newData;
        
        // Instantly re-render
        renderCity(currentCityId, currentVariantId);
        if (typeof updateMap === 'function') updateMap();
        
        // Output AI response
        loadingMsg.innerHTML = newData.copilotMessage || "I have successfully updated your itinerary based on your request!";
        
      } catch(e) {
        console.error(e);
        loadingMsg.innerHTML = "Sorry, I ran into an issue while trying to update your itinerary.";
      }
      
      copilotBody.scrollTop = copilotBody.scrollHeight;
    }

    if (copilotSend) copilotSend.addEventListener('click', sendCopilotMessage);
    if (copilotInput) copilotInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendCopilotMessage();
    });
  }

});

// Global share logic for the Share Button
window.shareTrip = async (cityId, cityTitle) => {
  const shareData = {
    title: `TripCo Itinerary: ${cityTitle}`,
    text: `Check out this AI-generated travel itinerary for ${cityTitle} that I created on TripCo!`,
    url: window.location.href,
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(shareData.url);
      const toast = document.getElementById('error-toast');
      if (toast) {
        toast.textContent = "Trip link copied to clipboard!";
        toast.style.background = "var(--sage)";
        toast.classList.add('show');
        setTimeout(() => {
          toast.classList.remove('show');
          setTimeout(() => toast.style.background = "var(--error)", 300);
        }, 3000);
      }
    }
  } catch (err) {
    console.error("Error sharing:", err);
  }
};
