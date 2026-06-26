(async function () {
  const storage = window.AIOTStorage;
  const config = window.AIOT_CONFIG || {};
  await storage.init();

  const $ = id => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

  const partner = storage.getCurrentPartner();
  $("logoutBtn")?.addEventListener("click", async () => { await storage.logout(); window.location.href = "service-partner.html"; });

  if (!partner) {
    storage.toast("Please login first.");
    setTimeout(() => (window.location.href = "service-partner.html"), 700);
    return;
  }

  let survey = storage.getSurvey(partner.id);
  let stream = null;
  let drawing = false;
  let startPoint = null;

  function savedZone() {
    return survey.aiQueueZone || survey.queueZone || config.cameraAnalytics?.queueZone || { x1: 0.08, y1: 0.22, x2: 0.92, y2: 0.98 };
  }

  function zoneFromInputs() {
    return {
      enabled: true,
      x1: clamp($("zoneX1").value, 0, 100) / 100,
      y1: clamp($("zoneY1").value, 0, 100) / 100,
      x2: clamp($("zoneX2").value, 0, 100) / 100,
      y2: clamp($("zoneY2").value, 0, 100) / 100
    };
  }

  function setInputs(zone) {
    $("zoneX1").value = Math.round(clamp(zone.x1, 0, 1) * 100);
    $("zoneY1").value = Math.round(clamp(zone.y1, 0, 1) * 100);
    $("zoneX2").value = Math.round(clamp(zone.x2, 0, 1) * 100);
    $("zoneY2").value = Math.round(clamp(zone.y2, 0, 1) * 100);
  }

  function zoneQuality(zone) {
    const width = Math.abs(zone.x2 - zone.x1);
    const height = Math.abs(zone.y2 - zone.y1);
    const area = width * height;
    if (area < 0.08 || width < 0.2 || height < 0.2) return { label: "Too small", score: 30 };
    if (area > 0.82) return { label: "Too wide", score: 55 };
    return { label: "Ready", score: 90 };
  }

  function updateReadiness() {
    const zone = zoneFromInputs();
    const quality = zoneQuality(zone);
    let score = quality.score;
    if ($("cameraAngleOk").checked) score += 4; else score -= 18;
    if ($("lightingOk").checked) score += 4; else score -= 20;
    if ($("zoneClean").checked) score += 4; else score -= 18;
    if (stream) score += 8; else score -= 5;
    if ($("fusionPreferred").checked && survey.usesEsp32 !== false) score += 4;
    score = Math.round(clamp(score, 0, 100));

    const label = score >= 78 ? "Ready" : score >= 55 ? "Needs review" : "Incomplete";
    setText("readinessScore", `${score}%`);
    setText("readinessLabel", label);
    setText("readinessBadge", label);
    setText("zoneState", quality.label);
    setText("zoneSizeText", `${Math.round(Math.abs(zone.x2 - zone.x1) * 100)}% × ${Math.round(Math.abs(zone.y2 - zone.y1) * 100)}%`);
    setText("recommendedMode", $("fusionPreferred").checked && survey.usesEsp32 !== false ? "Combined" : "Camera");
    setText("cameraState", stream ? "Live" : "Offline");
    setText("cameraQualityText", stream ? "Preview active." : "Start camera test.");
    setText("readinessNote", score >= 78 ? "Ready for live operation." : "Adjust camera, lighting or zone.");
    return { score, label };
  }

  function drawZone() {
    const canvas = $("setupCanvas");
    const video = $("setupVideo");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = video.videoWidth || rect.width || 1280;
    canvas.height = video.videoHeight || rect.height || 720;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const zone = zoneFromInputs();
    const x = Math.min(zone.x1, zone.x2) * canvas.width;
    const y = Math.min(zone.y1, zone.y2) * canvas.height;
    const w = Math.abs(zone.x2 - zone.x1) * canvas.width;
    const h = Math.abs(zone.y2 - zone.y1) * canvas.height;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#67e8f9";
    ctx.fillStyle = "rgba(6, 182, 212, 0.16)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "16px system-ui";
    ctx.fillText("Queue Zone", x + 10, Math.max(24, y + 24));
    ctx.restore();
  }

  function canvasPoint(event) {
    const canvas = $("setupCanvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    };
  }

  async function startPreview() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not supported by this browser.");
      if (stream) stopPreview(false);
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const video = $("setupVideo");
      video.srcObject = stream;
      await video.play();
      $("setupPlaceholder").style.display = "none";
      setText("cameraDot", "");
      drawZone();
      updateReadiness();
    } catch (error) {
      storage.toast(error.message || "Camera test failed.");
    }
  }

  function stopPreview(showToast = true) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    const video = $("setupVideo");
    if (video) video.srcObject = null;
    const placeholder = $("setupPlaceholder");
    if (placeholder) placeholder.style.display = "grid";
    updateReadiness();
    if (showToast) storage.toast("Camera test stopped.");
  }

  async function saveSetup() {
    const zone = zoneFromInputs();
    const readiness = updateReadiness();
    survey = await storage.saveSurvey(partner.id, {
      ...survey,
      aiQueueZone: zone,
      queueZone: zone,
      aiReadinessScore: readiness.score,
      aiReadinessLabel: readiness.label,
      cameraAngleOk: $("cameraAngleOk").checked,
      lightingOk: $("lightingOk").checked,
      queueZoneClean: $("zoneClean").checked,
      fusionPreferred: $("fusionPreferred").checked,
      aiSetupCompleted: readiness.score >= 55
    });
    setText("setupMessage", `Saved. AI readiness: ${readiness.score}%.`);
    storage.toast("AI setup saved.");
  }

  function bind() {
    ["zoneX1", "zoneY1", "zoneX2", "zoneY2", "cameraAngleOk", "lightingOk", "zoneClean", "fusionPreferred"].forEach(id => {
      $(id)?.addEventListener("input", () => { drawZone(); updateReadiness(); });
      $(id)?.addEventListener("change", () => { drawZone(); updateReadiness(); });
    });
    $("startPreviewButton")?.addEventListener("click", startPreview);
    $("stopPreviewButton")?.addEventListener("click", () => stopPreview(true));
    $("resetZoneButton")?.addEventListener("click", () => { setInputs(config.cameraAnalytics?.queueZone || { x1: 0.08, y1: 0.22, x2: 0.92, y2: 0.98 }); drawZone(); updateReadiness(); });
    $("saveAiSetupButton")?.addEventListener("click", saveSetup);

    const canvas = $("setupCanvas");
    canvas?.addEventListener("pointerdown", event => { drawing = true; startPoint = canvasPoint(event); });
    canvas?.addEventListener("pointermove", event => {
      if (!drawing || !startPoint) return;
      const p = canvasPoint(event);
      setInputs({ x1: startPoint.x, y1: startPoint.y, x2: p.x, y2: p.y });
      drawZone();
      updateReadiness();
    });
    window.addEventListener("pointerup", () => { drawing = false; startPoint = null; });
  }

  setText("setupSummary", `${partner.organizationName} · ${partner.serviceLocation}. Save a calibrated queue zone before live operation.`);
  setInputs(savedZone());
  $("cameraAngleOk").checked = survey.cameraAngleOk !== false;
  $("lightingOk").checked = survey.lightingOk !== false;
  $("zoneClean").checked = survey.queueZoneClean !== false;
  $("fusionPreferred").checked = survey.fusionPreferred !== false;
  bind();
  updateReadiness();
  drawZone();
})();
