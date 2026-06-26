(async function () {
  const storage = window.AIOTStorage;
  await storage.init();

  const $ = id => document.getElementById(id);
  const loginForm = $("loginForm");
  const registerForm = $("registerForm");
  const useDemoButton = $("useDemoButton");
  const exportDataButton = $("exportDataButton");
  const authModeBadge = $("authModeBadge");

  function value(id) {
    return ($(id)?.value || "").trim();
  }

  function setError(id, message) {
    const errorEl = document.querySelector(`[data-error-for="${id}"]`);
    if (errorEl) errorEl.textContent = message || "";
  }

  function clearErrors() {
    document.querySelectorAll(".field-error").forEach(el => (el.textContent = ""));
  }

  function setAuthMode(mode) {
    const normalized = mode === "register" ? "register" : "login";
    document.querySelectorAll("[data-auth-panel]").forEach(panel => {
      panel.hidden = panel.dataset.authPanel !== normalized;
    });
    document.querySelectorAll("[data-auth-tab]").forEach(button => {
      const active = button.dataset.authTab === normalized;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (authModeBadge) authModeBadge.textContent = normalized === "login" ? "Login selected" : "Workspace registration selected";
    clearErrors();
  }

  function goNext() {
    window.location.href = "setup-survey.html";
  }

  document.querySelectorAll("[data-auth-tab]").forEach(button => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authTab));
  });
  $("backToLoginButton")?.addEventListener("click", () => setAuthMode("login"));

  const initialMode = new URLSearchParams(window.location.search).get("mode") || window.location.hash.replace("#", "");
  setAuthMode(initialMode === "register" || initialMode === "signup" ? "register" : "login");

  loginForm?.addEventListener("submit", async event => {
    event.preventDefault();
    clearErrors();
    try {
      const email = value("loginEmail");
      const password = value("loginPassword");
      if (!email) setError("loginEmail", "Email is required.");
      if (!password) setError("loginPassword", "Password is required.");
      if (!email || !password) return;
      const partner = await storage.login(email, password);
      storage.toast(`Welcome back, ${partner.organizationName}.`);
      goNext();
    } catch (error) {
      storage.toast(storage.formatError ? storage.formatError(error, "Login failed.") : (error.message || "Login failed."));
    }
  });

  useDemoButton?.addEventListener("click", async () => {
    $("loginEmail").value = window.AIOT_CONFIG.demoAccount.email;
    $("loginPassword").value = window.AIOT_CONFIG.demoAccount.password;
    try {
      const partner = await storage.login(window.AIOT_CONFIG.demoAccount.email, window.AIOT_CONFIG.demoAccount.password);
      storage.toast(`Demo account loaded: ${partner.organizationName}.`);
      goNext();
    } catch (error) {
      storage.toast(storage.formatError ? storage.formatError(error, "Demo login failed.") : (error.message || "Demo login failed."));
    }
  });

  registerForm?.addEventListener("submit", async event => {
    event.preventDefault();
    clearErrors();

    const password = value("registerPassword");
    const confirm = value("confirmPassword");
    const required = [
      ["organizationName", "Organization name is required."],
      ["organizationType", "Organization type is required."],
      ["serviceLocation", "Service location is required."],
      ["contactPerson", "Contact person is required."],
      ["contactNumber", "Contact number is required."],
      ["registerEmail", "Email is required."],
      ["registerPassword", "Password is required."],
      ["confirmPassword", "Confirm your password."]
    ];

    let valid = true;
    required.forEach(([id, message]) => {
      if (!value(id)) {
        setError(id, message);
        valid = false;
      }
    });

    if (password && password.length < 8) {
      setError("registerPassword", "Use at least 8 characters.");
      valid = false;
    }
    if (password !== confirm) {
      setError("confirmPassword", "Passwords do not match.");
      valid = false;
    }
    if (!valid) return;

    try {
      const partner = await storage.registerPartner({
        organizationName: value("organizationName"),
        organizationType: value("organizationType"),
        serviceLocation: value("serviceLocation"),
        contactPerson: value("contactPerson"),
        contactNumber: value("contactNumber"),
        email: value("registerEmail"),
        password,
        publicListing: Boolean($("publicListing")?.checked)
      });
      if (partner.pendingEmailConfirmation) {
        storage.toast("Workspace account created. Check your email confirmation setting in Supabase, then login with this email.");
        $("loginEmail").value = partner.email;
        $("loginPassword").value = "";
        setAuthMode("login");
        return;
      }
      storage.toast(`Registered ${partner.organizationName}. Continue setup survey.`);
      goNext();
    } catch (error) {
      const message = storage.formatError ? storage.formatError(error, "Registration failed.") : (error.message || "Registration failed.");
      storage.toast(message);
      console.error("Workspace registration failed:", error);
    }
  });

  exportDataButton?.addEventListener("click", () => storage.downloadLocalData());
})();
