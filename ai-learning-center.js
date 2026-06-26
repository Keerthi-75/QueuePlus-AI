(async function () {
  const storage = window.AIOTStorage;
  await storage.init();

  const $ = id => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const partner = storage.getCurrentPartner();
  const feedbackKey = "aiot_prediction_feedback_v1";

  $("logoutBtn")?.addEventListener("click", async () => { await storage.logout(); window.location.href = "service-partner.html"; });

  if (!partner) {
    storage.toast("Please login first.");
    setTimeout(() => (window.location.href = "service-partner.html"), 700);
    return;
  }

  function readFeedback() {
    try { return JSON.parse(localStorage.getItem(feedbackKey) || "{}"); }
    catch { return {}; }
  }

  function writeFeedback(all) {
    localStorage.setItem(feedbackKey, JSON.stringify(all));
  }

  function hourLabel(hour) {
    if (hour === null || hour === undefined || hour === "") return "--";
    const h = Number(hour);
    if (!Number.isFinite(h)) return "--";
    const suffix = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 || 12;
    return `${hour12}:00 ${suffix}`;
  }

  async function render() {
    const history = await storage.listQueueHistory(partner.id, 120).catch(() => []);
    const stats = storage.deriveHistoryStats(history);
    setText("learningSummary", `${partner.organizationName} · ${partner.serviceLocation}. History improves best-visit guidance.`);
    setText("sampleCount", stats.samples);
    setText("todayAvgWait", stats.todayAverageWait || 0);
    setText("bestHourText", stats.bestHourText || "--");
    setText("peakHourText", stats.peakHourText || "--");
    setText("sampleText", stats.samples ? `${stats.samples} snapshots available.` : "Start live publishing to collect history.");
    setText("learningBadge", stats.samples >= 20 ? "Learning" : stats.samples ? "Collecting" : "No data");

    const list = $("historyList");
    const empty = $("emptyHistory");
    list.innerHTML = "";
    const recent = history.slice(-8).reverse();
    empty.style.display = recent.length ? "none" : "block";
    recent.forEach(item => {
      const row = document.createElement("div");
      row.className = "flow-step";
      const date = new Date(item.createdAt || Date.now()).toLocaleString();
      row.innerHTML = `<div class="flow-index">${item.finalPeopleCount || 0}</div><div><strong>${item.estimatedWaitTime || 0} min · ${item.crowdLevel || "--"}</strong><p>${date} · ${item.confidence || "Low"} confidence</p></div><span class="status-pill info">${item.status || "Open"}</span>`;
      list.appendChild(row);
    });

    const allFeedback = readFeedback();
    const rows = allFeedback[partner.id] || [];
    if (!rows.length) {
      setText("accuracyScore", "--");
      setText("avgError", "--");
      setText("accuracyText", "Add feedback to calculate.");
      setText("accuracyBadge", "No feedback");
      return;
    }
    const avgError = rows.reduce((sum, item) => sum + Math.abs(Number(item.actual) - Number(item.predicted)), 0) / rows.length;
    const avgActual = rows.reduce((sum, item) => sum + Math.max(1, Number(item.actual)), 0) / rows.length;
    const accuracy = Math.round(Math.max(0, 100 - (avgError / avgActual) * 100));
    setText("accuracyScore", `${accuracy}%`);
    setText("avgError", `${Math.round(avgError)}m`);
    setText("accuracyText", `${rows.length} feedback samples.`);
    setText("accuracyBadge", accuracy >= 80 ? "Good" : accuracy >= 60 ? "Review" : "Low");
  }

  function saveFeedback() {
    const predicted = Number($("predictedWaitInput").value);
    const actual = Number($("actualWaitInput").value);
    if (!Number.isFinite(predicted) || !Number.isFinite(actual) || predicted < 0 || actual < 0) {
      storage.toast("Enter valid predicted and actual wait minutes.");
      return;
    }
    const all = readFeedback();
    all[partner.id] = all[partner.id] || [];
    all[partner.id].push({ predicted, actual, createdAt: new Date().toISOString() });
    all[partner.id] = all[partner.id].slice(-80);
    writeFeedback(all);
    $("predictedWaitInput").value = "";
    $("actualWaitInput").value = "";
    storage.toast("Prediction feedback saved.");
    render();
  }

  function clearFeedback() {
    const all = readFeedback();
    all[partner.id] = [];
    writeFeedback(all);
    storage.toast("Feedback cleared.");
    render();
  }

  $("saveFeedbackButton")?.addEventListener("click", saveFeedback);
  $("clearFeedbackButton")?.addEventListener("click", clearFeedback);
  $("refreshLearningButton")?.addEventListener("click", render);
  render();
})();
