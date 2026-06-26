(async function () {
  const storage = window.AIOTStorage;
  await storage.init();

  const $ = id => document.getElementById(id);
  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };

  const confidenceScore = { High: 3, Medium: 2, Low: 1 };
  const crowdScore = { Low: 1, Medium: 2, High: 3 };
  const state = {
    locations: [],
    filtered: [],
    selected: null,
    filters: {
      openOnly: false,
      freshOnly: false,
      fastOnly: false,
      confidenceOnly: false,
      lowCrowd: false
    }
  };

  function toast(message) {
    storage.toast(message);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    }[char]));
  }

  function classPill(id, status) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("online", "offline", "warning", "danger", "info", "success");
    if (status) el.classList.add(status);
  }

  function ageMinutes(iso) {
    if (!iso) return Infinity;
    const value = new Date(iso).getTime();
    if (!Number.isFinite(value)) return Infinity;
    return Math.max(0, Math.round((Date.now() - value) / 60000));
  }

  function ageLabel(iso) {
    const minutes = ageMinutes(iso);
    if (!Number.isFinite(minutes)) return "not updated";
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function isOpen(item) {
    return item.isOpen !== false && item.status !== "Closed";
  }

  function waitMinutes(item) {
    const value = Number(item.estimatedWaitTime ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  function peopleCount(item) {
    const value = Number(item.finalPeopleCount ?? item.queueLength ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  function freshnessScore(item) {
    const age = ageMinutes(item.lastUpdated || item.updatedAt);
    if (age <= 5) return 3;
    if (age <= 15) return 2;
    if (age <= 60) return 1;
    return 0;
  }

  function statusClass(item) {
    if (!isOpen(item)) return "offline";
    if (ageMinutes(item.lastUpdated || item.updatedAt) > 15) return "warning";
    if ((item.crowdLevel || "").toLowerCase() === "high" || item.status === "Very Busy") return "warning";
    return "online";
  }

  function trustLabel(item) {
    const confidence = item.confidence || "Low";
    const freshness = freshnessScore(item);
    if (confidence === "High" && freshness >= 2) return "High";
    if ((confidence === "High" || confidence === "Medium") && freshness >= 1) return "Medium";
    return "Low";
  }

  function sourceExplanation(item) {
    if (!item) return "Public queue information will appear here after selecting a location.";
    const parts = [];
    const confidence = trustLabel(item);
    const age = ageMinutes(item.lastUpdated || item.updatedAt);

    if (confidence === "High") parts.push("This result is reliable and recently updated.");
    else if (confidence === "Medium") parts.push("This result is usable, but may still change soon.");
    else parts.push("Use this as a rough guide because the live data quality is limited.");

    if (age > 15) parts.push("The last update is older than usual, so refresh before travelling.");
    if (!isOpen(item)) parts.push("This location is currently marked closed.");
    if (waitMinutes(item) <= 10 && isOpen(item)) parts.push("This looks like a good time to visit.");
    if ((item.crowdLevel || "").toLowerCase() === "high") parts.push("The queue is currently busy.");

    return parts.join(" ");
  }

  function bestScore(item) {
    const openWeight = isOpen(item) ? 0 : 10000;
    const waitWeight = waitMinutes(item) * 9;
    const crowdWeight = (crowdScore[item.crowdLevel] || 2) * 20;
    const freshnessWeight = Math.max(0, 3 - freshnessScore(item)) * 25;
    const confidenceWeight = Math.max(0, 3 - (confidenceScore[item.confidence] || 1)) * 18;
    return openWeight + waitWeight + crowdWeight + freshnessWeight + confidenceWeight;
  }

  async function load() {
    try {
      state.locations = await storage.listPublicQueueStatuses();
      setText("sourceBadge", `${state.locations.length} locations`);
      classPill("sourceBadge", state.locations.length ? "online" : "warning");
      updateConnectionDot(state.locations.length ? "online" : "warning");
      applyFilters();
    } catch (error) {
      console.error(error);
      state.locations = [];
      setText("sourceBadge", "Unable to load");
      classPill("sourceBadge", "danger");
      updateConnectionDot("offline");
      applyFilters();
      toast("Public queue data could not be loaded.");
    }
  }

  function updateConnectionDot(status) {
    const dot = $("connectionDot");
    if (!dot) return;
    dot.classList.remove("warning", "offline");
    if (status === "warning") dot.classList.add("warning");
    if (status === "offline") dot.classList.add("offline");
  }

  function matchesSearch(item, query) {
    if (!query) return true;
    const haystack = [
      item.organizationName,
      item.organizationType,
      item.serviceLocation,
      item.status,
      item.crowdLevel,
      item.bestVisitAdvice,
      item.recommendation
    ].join(" ").toLowerCase();
    return haystack.includes(query.toLowerCase().trim());
  }

  function applyFilters() {
    const query = $("searchInput")?.value || "";
    const type = $("typeInput")?.value || "";
    let items = state.locations.filter(item => item.isPublic !== false);

    items = items.filter(item => matchesSearch(item, query));
    if (type) items = items.filter(item => item.organizationType === type);
    if (state.filters.openOnly) items = items.filter(isOpen);
    if (state.filters.freshOnly) items = items.filter(item => ageMinutes(item.lastUpdated || item.updatedAt) <= 10);
    if (state.filters.fastOnly) items = items.filter(item => waitMinutes(item) <= 10);
    if (state.filters.confidenceOnly) items = items.filter(item => trustLabel(item) !== "Low");
    if (state.filters.lowCrowd) items = items.filter(item => item.crowdLevel === "Low");

    const sort = $("sortSelect")?.value || "best";
    items.sort((a, b) => {
      if (sort === "recent") return new Date(b.lastUpdated || b.updatedAt || 0) - new Date(a.lastUpdated || a.updatedAt || 0);
      if (sort === "name") return String(a.organizationName || "").localeCompare(String(b.organizationName || ""));
      if (sort === "confidence") return (confidenceScore[b.confidence] || 0) - (confidenceScore[a.confidence] || 0);
      if (sort === "wait") return waitMinutes(a) - waitMinutes(b);
      return bestScore(a) - bestScore(b);
    });

    state.filtered = items;
    chooseSelectedLocation();
    renderSummary();
    renderList();
    renderDetail(state.selected);
  }

  function chooseSelectedLocation() {
    const requestedLocation = new URLSearchParams(window.location.search).get("location");
    if (requestedLocation && state.filtered.some(item => String(item.partnerId) === requestedLocation || String(item.id) === requestedLocation)) {
      state.selected = state.filtered.find(item => String(item.partnerId) === requestedLocation || String(item.id) === requestedLocation);
      return;
    }
    if (!state.selected || !state.filtered.some(item => item.partnerId === state.selected.partnerId)) {
      state.selected = state.filtered[0] || null;
    }
  }

  function renderSummary() {
    const openItems = state.filtered.filter(isOpen);
    const waits = state.filtered.map(waitMinutes).filter(Number.isFinite);
    const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    const best = openItems.slice().sort((a, b) => bestScore(a) - bestScore(b))[0];

    setText("visibleLocationsCount", state.filtered.length);
    setText("openLocationsCount", openItems.length);
    setText("averageWaitTime", avg);
    setText("bestLocationName", best ? best.organizationName || "Service Location" : "--");
    setText("bestLocationWait", best ? `${waitMinutes(best)} min · ${best.crowdLevel || "Low"} crowd` : "No open location found");
    setText("resultSubtitle", state.filtered.length ? `${state.filtered.length} location${state.filtered.length === 1 ? "" : "s"} match your search.` : "No locations match the current filters.");
  }

  function renderList() {
    const grid = $("locationGrid");
    const empty = $("emptyState");
    if (!grid || !empty) return;

    grid.innerHTML = "";
    empty.style.display = state.filtered.length ? "none" : "block";

    const bestPartnerId = state.filtered.slice().sort((a, b) => bestScore(a) - bestScore(b))[0]?.partnerId;

    state.filtered.forEach(item => {
      const card = document.createElement("article");
      const selected = state.selected?.partnerId === item.partnerId;
      const isBest = item.partnerId === bestPartnerId && isOpen(item);
      card.className = `location-card finder-result-card ${selected ? "active" : ""}`;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `View ${item.organizationName || "service location"}`);
      card.innerHTML = `
        <div class="finder-result-top">
          <div class="finder-result-title">
            <h3>${escapeHtml(item.organizationName || "Service Location")}</h3>
            <p>${escapeHtml(item.organizationType || "Service")} · ${escapeHtml(item.serviceLocation || "Location not set")}</p>
          </div>
          <div class="finder-card-pills">
            ${isBest ? `<span class="status-pill info">Best</span>` : ""}
            <span class="status-pill ${statusClass(item)}">${escapeHtml(item.status || (isOpen(item) ? "Open" : "Closed"))}</span>
          </div>
        </div>
        <div class="finder-card-main">
          <div class="finder-wait-chip"><span>Wait</span><strong>${waitMinutes(item)}m</strong></div>
          <div><span>People</span><strong>${peopleCount(item)}</strong></div>
          <div><span>Crowd</span><strong>${escapeHtml(item.crowdLevel || "Low")}</strong></div>
        </div>
        <div class="finder-card-foot">
          <span>${trustLabel(item)} reliability</span>
          <span>Updated ${ageLabel(item.lastUpdated || item.updatedAt)}</span>
        </div>
      `;

      const selectCard = () => {
        state.selected = item;
        renderList();
        renderDetail(item);
      };
      card.addEventListener("click", selectCard);
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectCard();
        }
      });
      grid.appendChild(card);
    });
  }

  function renderDetail(item) {
    if (!item) {
      setText("detailName", "Select a location");
      setText("detailAddress", "Choose a result from the list.");
      setText("detailStatusPill", "--");
      classPill("detailStatusPill", "");
      setText("detailWait", "--");
      setText("detailCrowdLevel", "--");
      setText("detailPeopleCount", "--");
      setText("detailBestTime", "--");
      setText("detailConfidence", "--");
      setText("detailFreshness", "--");
      setText("detailSchedule", "--");
      setText("detailRecommendation", "Select a location to view advice.");
      setText("detailSourceNote", "Public queue information will appear here after selecting a location.");
      setText("detailAlertText", "No active alert.");
      clearQr();
      return;
    }

    const status = item.status || (isOpen(item) ? "Open" : "Closed");
    const h = item.historyStats || {};
    const bestTime = item.bestVisitAdvice || h.learnedBestVisitAdvice || h.bestHourText || "No best time yet";
    const schedule = item.scheduleStatus || (isOpen(item) ? "Open now" : "Closed");
    const alerts = Array.isArray(item.alerts) ? item.alerts : [];

    setText("detailName", item.organizationName || "Service Location");
    setText("detailAddress", `${item.organizationType || "Service"} · ${item.serviceLocation || "Location not set"}`);
    setText("detailStatusPill", status);
    classPill("detailStatusPill", statusClass(item));
    setText("detailWait", waitMinutes(item));
    setText("detailCrowdLevel", item.crowdLevel || "Low");
    setText("detailPeopleCount", peopleCount(item));
    setText("detailBestTime", bestTime);
    setText("detailConfidence", trustLabel(item));
    setText("detailFreshness", ageLabel(item.lastUpdated || item.updatedAt));
    setText("detailSchedule", schedule);
    setText("detailRecommendation", item.recommendation || item.bestVisitAdvice || recommendationFromStatus(item));
    setText("detailSourceNote", sourceExplanation(item));
    setText("detailAlertText", alerts[0] || item.alertSummary || "No active alert.");
    renderQr(item);
  }

  function recommendationFromStatus(item) {
    if (!isOpen(item)) return "This location is closed now. Check the schedule before visiting.";
    if (waitMinutes(item) <= 5) return "Very low wait. This is a good time to visit.";
    if (waitMinutes(item) <= 10) return "Short wait. Visiting now should be manageable.";
    if ((item.crowdLevel || "").toLowerCase() === "high") return "Busy now. Visit later if possible.";
    return "Queue is active. Check again before travelling.";
  }

  function directUrl(item) {
    const url = new URL(window.location.href);
    url.searchParams.set("location", item?.partnerId || item?.id || "");
    return url.toString();
  }

  function renderQr(item) {
    const canvas = $("qrCanvas");
    if (!canvas || !item) return;
    if (window.QRCode?.toCanvas) {
      window.QRCode.toCanvas(canvas, directUrl(item), { width: 132, margin: 1 }).catch(() => clearQr());
    } else {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111827";
      ctx.font = "20px sans-serif";
      ctx.fillText("QR", 50, 72);
    }
  }

  function clearQr() {
    const canvas = $("qrCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function resetFilters() {
    state.filters.openOnly = false;
    state.filters.freshOnly = false;
    state.filters.fastOnly = false;
    state.filters.confidenceOnly = false;
    state.filters.lowCrowd = false;
    if ($("searchInput")) $("searchInput").value = "";
    if ($("typeInput")) $("typeInput").value = "";
    if ($("sortSelect")) $("sortSelect").value = "best";
    updateToggleStyles();
    applyFilters();
  }

  function setToggle(id, key) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", () => {
      if (key === "all") {
        state.filters.openOnly = false;
        state.filters.freshOnly = false;
        state.filters.fastOnly = false;
        state.filters.confidenceOnly = false;
        state.filters.lowCrowd = false;
      } else {
        state.filters[key] = !state.filters[key];
      }
      updateToggleStyles();
      applyFilters();
    });
  }

  function updateToggleStyles() {
    $("allToggle")?.classList.toggle("active", !state.filters.openOnly && !state.filters.freshOnly && !state.filters.fastOnly && !state.filters.confidenceOnly && !state.filters.lowCrowd);
    $("openOnlyToggle")?.classList.toggle("active", state.filters.openOnly);
    $("freshOnlyToggle")?.classList.toggle("active", state.filters.freshOnly);
    $("fastOnlyToggle")?.classList.toggle("active", state.filters.fastOnly);
    $("confidenceOnlyToggle")?.classList.toggle("active", state.filters.confidenceOnly);
    $("lowCrowdToggle")?.classList.toggle("active", state.filters.lowCrowd);
  }

  function bind() {
    ["searchInput", "typeInput", "sortSelect"].forEach(id => {
      $(id)?.addEventListener("input", applyFilters);
      $(id)?.addEventListener("change", applyFilters);
    });

    $("refreshButton")?.addEventListener("click", () => load().then(() => toast("Public queue results refreshed.")));
    $("clearButton")?.addEventListener("click", resetFilters);

    setToggle("allToggle", "all");
    setToggle("openOnlyToggle", "openOnly");
    setToggle("freshOnlyToggle", "freshOnly");
    setToggle("fastOnlyToggle", "fastOnly");
    setToggle("confidenceOnlyToggle", "confidenceOnly");
    setToggle("lowCrowdToggle", "lowCrowd");

    $("copySummaryButton")?.addEventListener("click", () => {
      if (!state.selected) return toast("Select a service location first.");
      const item = state.selected;
      const summary = [
        item.organizationName || "Service Location",
        `Status: ${item.status || (isOpen(item) ? "Open" : "Closed")}`,
        `Wait: ${waitMinutes(item)} min`,
        `People: ${peopleCount(item)}`,
        `Crowd: ${item.crowdLevel || "Low"}`,
        `Updated: ${ageLabel(item.lastUpdated || item.updatedAt)}`,
        `Advice: ${item.recommendation || item.bestVisitAdvice || recommendationFromStatus(item)}`
      ].join("\n");
      navigator.clipboard?.writeText(summary);
      toast("Queue summary copied.");
    });

    $("copyLinkButton")?.addEventListener("click", () => {
      if (!state.selected) return toast("Select a service location first.");
      navigator.clipboard?.writeText(directUrl(state.selected));
      toast("Direct queue link copied.");
    });
  }

  bind();
  await load();
})();
