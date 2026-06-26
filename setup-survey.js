(async function () {
  const storage = window.AIOTStorage;
  await storage.init();
  const $ = id => document.getElementById(id);
  const partner = storage.getCurrentPartner();

  if (!partner) {
    storage.toast("Please login or register first.");
    setTimeout(() => (window.location.href = "service-partner.html"), 900);
    return;
  }

  $("partnerName").textContent = partner.organizationName;
  $("partnerLocation").textContent = `${partner.organizationType} · ${partner.serviceLocation}`;

  const survey = storage.getSurvey(partner.id);

  const fields = [
    "entranceCount", "exitCount", "queueLayout", "activeCounters", "dailyLearningSampleCount",
    "noWaitQueueLimit", "mediumCrowdLimit", "maxQueueCapacity", "cameraPosition", "esp32PinPlan", "deploymentNotes", "openingTime", "closingTime", "timezone"
  ];
  const checks = [
    "hasWifi", "hasPowerSupply", "hasGoodLighting", "usesWebcamAi", "usesEsp32",
    "noVideoStorage", "cameraPrivacyConfirmed", "usesUltrasonic", "isPublic", "isOpen", "scheduleEnabled", "closedSunday", "closedMonday", "closedTuesday", "closedWednesday", "closedThursday", "closedFriday", "closedSaturday"
  ];

  const stepMeta = [
    { title: "1. Queue Layout", subtitle: "Describe how people enter, wait and leave your service area.", badge: "Structure" },
    { title: "2. Device Capability", subtitle: "Select camera AI, ESP32 and privacy readiness options.", badge: "Devices" },
    { title: "3. Prediction Learning", subtitle: "Learn service time from the first 8 served visitors each day.", badge: "Learning" },
    { title: "4. Public Visibility", subtitle: "Control what visitors can see in the public finder.", badge: "Public model" }
  ];
  let activeStep = 0;

  function load() {
    fields.forEach(id => {
      if (!$(id)) return;
      if (survey[id] !== undefined) $(id).value = survey[id];
    });
    checks.forEach(id => {
      if (!$(id)) return;
      if (survey[id] !== undefined) $(id).checked = Boolean(survey[id]);
    });
    const closedDays = Array.isArray(survey.closedDays) ? survey.closedDays : ["Sunday"];
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].forEach(day => {
      const id = `closed${day}`;
      if ($(id)) $(id).checked = closedDays.includes(day);
    });
  }

  function setStep(index) {
    activeStep = Math.max(0, Math.min(stepMeta.length - 1, Number(index) || 0));
    document.querySelectorAll("[data-step-panel]").forEach(panel => {
      panel.hidden = Number(panel.dataset.stepPanel) !== activeStep;
    });
    document.querySelectorAll("[data-survey-step]").forEach(button => {
      const isActive = Number(button.dataset.surveyStep) === activeStep;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    const percent = Math.round(((activeStep + 1) / stepMeta.length) * 100);
    $("wizardProgressFill").style.width = `${percent}%`;
    $("wizardStepLabel").textContent = `Step ${activeStep + 1} of ${stepMeta.length}`;
    $("wizardPercent").textContent = `${percent}%`;
    $("activeSurveyTitle").textContent = stepMeta[activeStep].title;
    $("activeSurveySubtitle").textContent = stepMeta[activeStep].subtitle;
    $("activeSurveyBadge").textContent = stepMeta[activeStep].badge;
    $("prevSurveyStep").disabled = activeStep === 0;
    $("nextSurveyStep").hidden = activeStep === stepMeta.length - 1;
    $("submitSurveyButton").hidden = activeStep !== stepMeta.length - 1;
  }

  function number(id, fallback = 0) {
    const value = Number($(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function text(id) {
    return ($(id)?.value || "").trim();
  }

  function checked(id) {
    return Boolean($(id)?.checked);
  }

  function selectedClosedDays() {
    return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].filter(day => checked(`closed${day}`));
  }

  function setError(id, message) {
    const errorEl = document.querySelector(`[data-error-for="${id}"]`);
    if (errorEl) errorEl.textContent = message || "";
  }

  function clearErrors() {
    document.querySelectorAll(".field-error").forEach(el => (el.textContent = ""));
  }

  function validate() {
    clearErrors();
    let ok = true;
    const numericRules = [
      ["entranceCount", 1, 20],
      ["exitCount", 1, 20],
      ["activeCounters", 1, 50],
      ["dailyLearningSampleCount", 7, 8],
      ["noWaitQueueLimit", 1, 100],
      ["mediumCrowdLimit", 9, 200],
      ["maxQueueCapacity", 5, 500]
    ];
    numericRules.forEach(([id, min, max]) => {
      const value = number(id, NaN);
      if (!Number.isFinite(value) || value < min || value > max) {
        setError(id, `Enter a value from ${min} to ${max}.`);
        ok = false;
      }
    });
    if (number("noWaitQueueLimit") >= number("mediumCrowdLimit")) {
      setError("mediumCrowdLimit", "Busy limit must be higher than the no-wait limit.");
      ok = false;
    }
    if (checked("scheduleEnabled") && text("openingTime") && text("closingTime") && text("openingTime") === text("closingTime")) {
      setError("closingTime", "Closing time must be different from opening time.");
      ok = false;
      setStep(3);
    }
    if (!checked("usesWebcamAi") && !checked("usesEsp32")) {
      storage.toast("Enable at least webcam AI or ESP32.");
      ok = false;
      setStep(1);
    }
    return ok;
  }

  function collect() {
    const webcamEnabled = checked("usesWebcamAi");
    const esp32Enabled = checked("usesEsp32");
    const sourceMode = webcamEnabled && esp32Enabled ? "auto" : webcamEnabled ? "camera" : "esp32";
    return {
      entranceCount: number("entranceCount", 1),
      exitCount: number("exitCount", 1),
      queueLayout: text("queueLayout"),
      hasWifi: checked("hasWifi"),
      hasPowerSupply: checked("hasPowerSupply"),
      hasGoodLighting: checked("hasGoodLighting"),
      usesWebcamAi: webcamEnabled,
      usesEsp32: esp32Enabled,
      usesUltrasonic: esp32Enabled && checked("usesUltrasonic"),
      irEntryEnabled: esp32Enabled,
      irExitEnabled: esp32Enabled,
      sourceMode,
      noVideoStorage: checked("noVideoStorage"),
      cameraPrivacyConfirmed: checked("cameraPrivacyConfirmed"),
      cameraPosition: text("cameraPosition"),
      esp32PinPlan: text("esp32PinPlan"),
      activeCounters: number("activeCounters", 2),
      defaultServiceTime: 4,
      dailyLearningSampleCount: number("dailyLearningSampleCount", 8),
      noWaitQueueLimit: number("noWaitQueueLimit", 8),
      lowCrowdLimit: number("noWaitQueueLimit", 8),
      mediumCrowdLimit: number("mediumCrowdLimit", 15),
      maxQueueCapacity: number("maxQueueCapacity", 30),
      firstBenchmarkWeight: 40,
      recentAverageWeight: 60,
      isPublic: checked("isPublic"),
      isOpen: checked("isOpen"),
      scheduleEnabled: checked("scheduleEnabled"),
      openingTime: text("openingTime") || "08:30",
      closingTime: text("closingTime") || "16:30",
      closedDays: selectedClosedDays(),
      timezone: text("timezone") || "Asia/Colombo",
      deploymentNotes: text("deploymentNotes")
    };
  }

  load();
  setStep(0);

  document.querySelectorAll("[data-survey-step]").forEach(button => {
    button.addEventListener("click", () => setStep(button.dataset.surveyStep));
  });

  $("prevSurveyStep")?.addEventListener("click", () => setStep(activeStep - 1));
  $("nextSurveyStep")?.addEventListener("click", () => setStep(activeStep + 1));

  $("logoutBtn")?.addEventListener("click", async () => {
    await storage.logout();
    window.location.href = "service-partner.html";
  });

  $("surveyForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!validate()) return;
    const saved = await storage.saveSurvey(partner.id, collect());
    await storage.saveQueueStatus({
      partnerId: partner.id,
      organizationName: partner.organizationName,
      organizationType: partner.organizationType,
      serviceLocation: partner.serviceLocation,
      isPublic: saved.isPublic,
      isOpen: saved.isOpen,
      dataMode: "setup-ready",
      queueLength: 0,
      aiPeopleCount: 0,
      sensorPeopleCount: 0,
      finalPeopleCount: 0,
      crowdLevel: "Low",
      estimatedWaitTime: 0,
      averageServiceTime: null,
      activeCounters: saved.activeCounters,
      confidence: "Low",
      queueTrend: "Waiting",
      occupancyPercent: 0,
      queueDensity: "Low",
      deviceHealth: "Setup completed. Waiting for devices.",
      bestVisitAdvice: "Learning service speed",
      recommendation: "This location is registered. Wait time will be calculated after today’s first service samples are collected.",
      status: saved.isOpen ? "Open" : "Closed",
      scheduleEnabled: saved.scheduleEnabled,
      openingTime: saved.openingTime,
      closingTime: saved.closingTime,
      closedDays: saved.closedDays,
      scheduleStatus: saved.scheduleEnabled ? "Schedule configured" : "Manual open/closed",
      lastUpdated: storage.nowIso()
    });
    storage.toast("Setup saved. Opening Service Control Hub.");
    setTimeout(() => (window.location.href = "service-control-hub.html"), 700);
  });
})();
