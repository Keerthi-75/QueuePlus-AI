(async function () {
  const storage = window.AIOTStorage;
  await storage.init();
  const $ = id => document.getElementById(id);
  const partner = storage.getCurrentPartner();
  if (!partner) {
    storage.toast("Please login first.");
    setTimeout(() => (window.location.href = "service-partner.html"), 900);
    return;
  }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
  function val(id) { return ($(id)?.value || "").trim(); }
  async function render() {
    const locations = await storage.listPartners();
    const active = storage.getCurrentPartner();
    $("locationCountBadge").textContent = `${locations.length} location${locations.length === 1 ? "" : "s"}`;
    $("activeLocationText").textContent = active ? `${active.organizationName} · ${active.serviceLocation}` : "None selected";
    const list = $("locationList");
    list.innerHTML = "";
    $("emptyLocations").style.display = locations.length ? "none" : "block";
    locations.forEach(item => {
      const card = document.createElement("article");
      const isActive = active && active.id === item.id;
      card.className = `location-card ${isActive ? "active" : ""}`;
      card.innerHTML = `<div class="row-actions" style="justify-content:space-between; align-items:flex-start;"><div><h3>${escapeHtml(item.organizationName)}</h3><p>${escapeHtml(item.organizationType)} · ${escapeHtml(item.serviceLocation)}</p></div><span class="status-pill ${isActive ? "online" : "info"}">${isActive ? "Active" : "Available"}</span></div><div class="button-row" style="margin-top:14px;"><button class="primary-btn" data-set-active="${item.id}" type="button">Use This Location</button><a class="outline-btn" href="setup-survey.html">Setup</a></div>`;
      list.appendChild(card);
    });
    list.querySelectorAll("[data-set-active]").forEach(btn => btn.addEventListener("click", async () => {
      await storage.setActivePartner(btn.dataset.setActive);
      storage.toast("Active location changed.");
      await render();
    }));
  }
  $("locationForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const organizationName = val("organizationName");
    const serviceLocation = val("serviceLocation");
    if (!organizationName || !serviceLocation) return storage.toast("Organization name and branch/location are required.");
    await storage.createLocation({
      organizationName,
      organizationType: val("organizationType") || "Service Counter",
      serviceLocation,
      contactNumber: val("contactNumber"),
      contactPerson: partner.contactPerson || "",
      email: partner.email,
      publicListing: true
    });
    event.target.reset();
    storage.toast("New location created and selected.");
    await render();
  });
  $("refreshLocationsButton")?.addEventListener("click", render);
  $("logoutBtn")?.addEventListener("click", async () => { await storage.logout(); window.location.href = "service-partner.html"; });
  await render();
})();
