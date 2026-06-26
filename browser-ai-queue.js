(async function () {
  const storage = window.AIOTStorage;
  const config = window.AIOT_CONFIG;
  if (!storage || !config) {
    const message = "Core app scripts are missing. Check that app-config.js and storage-api.js load before browser-ai-queue.js.";
    console.error(message);
    const terminal = document.getElementById("terminalLog");
    if (terminal) terminal.textContent = `[system] ${message}`;
    return;
  }
  await storage.init();

  const $ = id => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  const setValue = (id, value) => { const el = $(id); if (el) el.value = value; };
  const setChecked = (id, value) => { const el = $(id); if (el) el.checked = Boolean(value); };

  const partner = storage.getCurrentPartner();
  if (!partner) {
    storage.toast("Please login or register first.");
    setTimeout(() => (window.location.href = "service-partner.html"), 900);
    return;
  }

  const survey = storage.getSurvey(partner.id);
  let serviceRecords = storage.getServiceRecords(partner.id);

  const state = {
    partner,
    survey,
    model: null,
    stream: null,
    cameraRunning: false,
    cameraReady: false,
    cameraFallbackMode: false,
    confidenceThreshold: Number(survey.confidenceThreshold || config.cameraAnalytics.defaultConfidenceThreshold),
    rawAICount: 0,
    stableAICount: 0,
    recentCounts: [],
    countTimeline: [],
    previousStableCount: 0,
    lastCountEventAt: 0,
    lastArrivalAt: null,
    lastServiceAt: null,
    arrivalIntervals: [],
    serviceIntervals: [],
    serviceEvents: [],
    arrivalEvents: [],
    previousCenters: [],
    movementScores: [],
    cameraDensityRatio: 0,
    lineFormationScore: 0,
    cameraQualityScore: 0,
    cameraAnomalies: [],
    cameraRejectedReasons: [],
    tracks: new Map(),
    nextTrackId: 1,
    sensorQualityScore: 0,
    lastReliableAICount: 0,
    lastReliableFinalCount: 0,
    finalCountTimeline: [],
    lastFinalCountAt: 0,
    esp32Connected: false,
    esp32Timer: null,
    esp32Source: "cloud",
    esp32LastReadAt: null,
    esp32PreviousEntry: 0,
    esp32PreviousExit: 0,
    sensorEvents: [],
    sensorServiceIntervals: [],
    lastSensorServiceAt: null,
    esp32Data: null,
    latestStatus: null,
    lastSaveAt: 0,
    settings: {
      sourceMode: survey.sourceMode || survey.analysisMode || "auto",
      activeCounters: Number(survey.activeCounters || 2),
      defaultServiceTime: Number(survey.defaultServiceTime || 4),
      dailyLearningSampleCount: Number(survey.dailyLearningSampleCount || config.cameraAnalytics.dailyLearningSampleCount || 8),
      noWaitQueueLimit: Number(survey.noWaitQueueLimit || survey.lowCrowdLimit || config.cameraAnalytics.noWaitQueueLimit || 8),
      lowCrowdLimit: Number(survey.noWaitQueueLimit || survey.lowCrowdLimit || 8),
      mediumCrowdLimit: Number(survey.mediumCrowdLimit || 15),
      maxQueueCapacity: Number(survey.maxQueueCapacity || 30),
      isPublic: survey.isPublic !== false,
      isOpen: survey.isOpen !== false,
      scheduleEnabled: survey.scheduleEnabled !== false,
      openingTime: survey.openingTime || "08:30",
      closingTime: survey.closingTime || "16:30",
      closedDays: Array.isArray(survey.closedDays) ? survey.closedDays : ["Sunday"],
      timezone: survey.timezone || "Asia/Colombo",
      aiQueueZone: survey.aiQueueZone || survey.queueZone || config.cameraAnalytics.queueZone,
      aiReadinessScore: Number(survey.aiReadinessScore || 0),
      aiSetupCompleted: Boolean(survey.aiSetupCompleted)
    }
  };

  function log(message) {
    const terminal = $("terminalLog");
    if (!terminal) return;
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    terminal.textContent = `${line}\n${terminal.textContent}`.slice(0, 12000);
  }

  function classPill(id, status) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("online", "offline", "warning", "danger", "info", "success");
    if (status) el.classList.add(status);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, decimals = 0) {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function mode(values) {
    if (!values.length) return 0;
    const counts = new Map();
    values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }

  function minutesBetween(a, b) {
    return Math.abs(b - a) / 60000;
  }

  function perHourFromIntervals(intervals) {
    const med = median(intervals);
    return med && med > 0 ? round(60 / med, 1) : 0;
  }

  function localDateKey(value = Date.now()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function todayServiceRecords() {
    const today = localDateKey();
    return serviceRecords.filter(record => localDateKey(record.createdAt || record.created_at || Date.now()) === today);
  }

  function dailyLearningTarget() {
    return Math.max(7, Math.min(8, Number(state.settings.dailyLearningSampleCount || config.cameraAnalytics.dailyLearningSampleCount || 8)));
  }

  function learnedDailyServiceTime() {
    const values = todayServiceRecords().map(r => Number(r.value)).filter(v => v >= 1 && v <= 30);
    const target = dailyLearningTarget();
    if (values.length < target) {
      return { average: null, confidence: "Learning", samples: values.length, target, ready: false };
    }
    const firstBatch = values.slice(0, target);
    const firstAvg = firstBatch.reduce((a, b) => a + b, 0) / firstBatch.length;
    if (values.length <= target) {
      return { average: round(firstAvg, 2), confidence: "Medium", samples: values.length, target, ready: true };
    }
    const latest = values.slice(-Math.min(5, values.length));
    const latestAvg = latest.reduce((a, b) => a + b, 0) / latest.length;
    return { average: round(firstAvg * 0.6 + latestAvg * 0.4, 2), confidence: values.length >= target + 5 ? "High" : "Medium", samples: values.length, target, ready: true };
  }

  async function saveLearnedServiceSample(minutes, source) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value < 1 || value > 30) return;
    try {
      serviceRecords = await storage.addServiceRecord(partner.id, value, source || "auto");
      log(`Service time sample saved: ${round(value, 2)} min (${source || "auto"}).`);
    } catch (error) {
      log(`Service time sample save failed: ${error.message}`);
    }
  }


  function qualityLabel(score) {
    if (score >= 80) return "High";
    if (score >= 55) return "Medium";
    return "Low";
  }

  function qualityValue(label) {
    if (label === "High") return 85;
    if (label === "Medium") return 62;
    return 35;
  }

  function robustMedian(values) {
    const clean = values.map(Number).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    if (!clean.length) return null;
    if (clean.length < 5) return median(clean);
    const q1 = clean[Math.floor((clean.length - 1) * 0.25)];
    const q3 = clean[Math.floor((clean.length - 1) * 0.75)];
    const iqr = Math.max(1, q3 - q1);
    const filtered = clean.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    return median(filtered.length ? filtered : clean);
  }

  function robustInterval(intervals, min = 0.15, max = 30) {
    const clean = intervals.map(Number).filter(v => Number.isFinite(v) && v >= min && v <= max).sort((a, b) => a - b);
    if (!clean.length) return { value: null, samples: 0, stability: 0 };
    const value = robustMedian(clean);
    const deviations = clean.map(v => Math.abs(v - value));
    const mad = robustMedian(deviations) || 0;
    const stability = clamp(100 - (mad / Math.max(value, 0.1)) * 100, 20, 100);
    return { value: round(value, 2), samples: clean.length, stability: round(stability) };
  }

  function linearTrend(items) {
    if (!items || items.length < 4) return 0;
    const firstTime = items[0].time || Date.now();
    const xs = items.map(item => ((item.time || Date.now()) - firstTime) / 60000);
    const ys = items.map(item => Number(item.count || 0));
    const xAvg = xs.reduce((a, b) => a + b, 0) / xs.length;
    const yAvg = ys.reduce((a, b) => a + b, 0) / ys.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < xs.length; i++) {
      numerator += (xs[i] - xAvg) * (ys[i] - yAvg);
      denominator += (xs[i] - xAvg) ** 2;
    }
    return denominator ? numerator / denominator : 0;
  }

  function cameraAnomalyPenalty() {
    const anomalies = state.cameraAnomalies.slice(-12);
    let penalty = 0;
    if (anomalies.includes("single-frame-spike")) penalty += 12;
    if (anomalies.includes("occlusion-drop-guard")) penalty += 16;
    if (anomalies.includes("unstable-count-window")) penalty += 10;
    if (anomalies.includes("outside-queue-zone")) penalty += 8;
    if (anomalies.includes("tiny-box") || anomalies.includes("bad-person-shape")) penalty += 8;
    if (movementLabel() === "High") penalty += 8;
    if (state.stableAICount >= 3 && state.lineFormationScore < 25) penalty += 8;
    return clamp(penalty, 0, 48);
  }

  function deriveStableCameraCount(rawCount) {
    const previous = state.stableAICount;
    const recent = state.recentCounts.slice(-config.cameraAnalytics.stableWindowSize);
    const med = robustMedian(recent);
    const frequent = mode(recent);
    let candidate = Math.round(Number.isFinite(med) ? (med * 0.65 + frequent * 0.35) : rawCount);
    const rawRepeats = recent.filter(v => v === rawCount).length;
    const largeChange = Math.abs(candidate - previous) >= 3;
    const anomalies = [];

    if (previous > 0 && largeChange && rawRepeats < 2 && recent.length >= 4) {
      candidate = previous;
      anomalies.push("single-frame-spike");
    }

    const bigDrop = previous >= 4 && candidate <= Math.floor(previous * 0.5);
    const visualStillOccupied = state.cameraDensityRatio >= 0.08 || movementLabel() !== "Calm";
    if (bigDrop && visualStillOccupied) {
      candidate = Math.max(0, previous - 1);
      anomalies.push("occlusion-drop-guard");
    }

    const unstable = recent.length >= 5 && (Math.max(...recent) - Math.min(...recent)) >= 4;
    if (unstable) anomalies.push("unstable-count-window");

    state.cameraAnomalies = [...state.cameraAnomalies, ...anomalies].slice(-12);
    state.lastReliableAICount = candidate;
    return Math.max(0, candidate);
  }

  function blendedCount(cameraCount, sensorCount, cameraScore, sensorScore) {
    const total = Math.max(1, cameraScore + sensorScore);
    return Math.round((cameraCount * cameraScore + sensorCount * sensorScore) / total);
  }

  function applyContinuityGuard(candidate, mode, agreementGood) {
    const previous = state.lastReliableFinalCount;
    if (!previous || agreementGood || mode === "waiting") return Math.max(0, Math.round(candidate));
    const diff = candidate - previous;
    const maxStep = Math.max(2, Math.ceil(previous * 0.4));
    if (Math.abs(diff) <= maxStep) return Math.max(0, Math.round(candidate));
    const guarded = previous + Math.sign(diff) * maxStep;
    log(`AI continuity guard softened sudden queue change: ${previous} → ${candidate}, using ${guarded}.`);
    return Math.max(0, Math.round(guarded));
  }

  function getCrowdLevel(count) {
    if (count <= state.settings.lowCrowdLimit) return "Low";
    if (count <= state.settings.mediumCrowdLimit) return "Medium";
    return "High";
  }

  function getTrend() {
    const recent = state.finalCountTimeline.length ? state.finalCountTimeline.slice(-10) : state.countTimeline.slice(-10);
    if (recent.length < 4) return "Waiting";
    const slope = linearTrend(recent);
    if (slope >= 0.35) return "Increasing";
    if (slope <= -0.35) return "Decreasing";
    return "Stable";
  }

  function movementLabel() {
    const value = median(state.movementScores.slice(-8));
    if (value === null) return "--";
    if (value < 0.018) return "Calm";
    if (value < 0.06) return "Normal";
    return "High";
  }

  function densityLabel(count) {
    const occupancy = (count / Math.max(1, state.settings.maxQueueCapacity)) * 100;
    const area = state.cameraDensityRatio * 100;
    if (occupancy >= 70 || area >= 30) return "High";
    if (occupancy >= 35 || area >= 14) return "Medium";
    return "Low";
  }

  function formationLabel() {
    if (state.stableAICount < 2) return "Not enough people";
    if (state.lineFormationScore >= 70) return "Clear line";
    if (state.lineFormationScore >= 40) return "Loose line";
    return "Scattered";
  }

  function calculateMovement(centers) {
    if (!state.previousCenters.length || !centers.length) {
      state.previousCenters = centers;
      return 0;
    }
    const sortedNow = [...centers].sort((a, b) => a.x - b.x || a.y - b.y);
    const sortedPrev = [...state.previousCenters].sort((a, b) => a.x - b.x || a.y - b.y);
    const length = Math.min(sortedNow.length, sortedPrev.length);
    if (!length) return 0;
    let total = 0;
    for (let i = 0; i < length; i++) {
      const dx = sortedNow[i].x - sortedPrev[i].x;
      const dy = sortedNow[i].y - sortedPrev[i].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    state.previousCenters = centers;
    return total / length;
  }

  function calculateLineFormation(centers) {
    if (centers.length < 2) return 0;
    const xs = centers.map(c => c.x);
    const ys = centers.map(c => c.y);
    const std = arr => {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.sqrt(arr.reduce((sum, value) => sum + (value - avg) ** 2, 0) / arr.length);
    };
    const xStd = std(xs);
    const yStd = std(ys);
    const alignment = Math.max(xStd, yStd) > 0 ? Math.min(xStd, yStd) / Math.max(xStd, yStd) : 1;
    return round(clamp((1 - alignment) * 100, 0, 100));
  }

  function recordCountEvents(newStableCount) {
    const now = Date.now();
    const previous = state.previousStableCount;
    const gapOk = now - state.lastCountEventAt >= config.cameraAnalytics.minEventGapMs;
    if (!gapOk || newStableCount === previous) return;

    const delta = newStableCount - previous;
    if (delta > 0) {
      for (let i = 0; i < delta; i++) state.arrivalEvents.push(now);
      if (state.lastArrivalAt) {
        const interval = minutesBetween(state.lastArrivalAt, now);
        if (interval <= config.cameraAnalytics.maxArrivalIntervalMinutes) state.arrivalIntervals.push(interval);
      }
      state.lastArrivalAt = now;
      log(`AI queue increase: ${previous} → ${newStableCount}. Arrival event recorded.`);
    }
    if (delta < 0) {
      for (let i = 0; i < Math.abs(delta); i++) state.serviceEvents.push(now);
      if (state.lastServiceAt) {
        const interval = minutesBetween(state.lastServiceAt, now);
        if (interval <= config.cameraAnalytics.maxServiceIntervalMinutes) {
          state.serviceIntervals.push(interval);
          saveLearnedServiceSample(interval, "camera");
        }
      }
      state.lastServiceAt = now;
      log(`AI queue decrease: ${previous} → ${newStableCount}. Service/departure event recorded.`);
      storage.saveServiceTimeEvent?.(partner.id, {
        source: "camera",
        eventType: "service_completed",
        intervalMinutes: state.serviceIntervals.at(-1) || null,
        queueCountBefore: previous,
        queueCountAfter: newStableCount
      }).catch(error => log(`Service event save failed: ${error.message}`));
    }
    state.previousStableCount = newStableCount;
    state.lastCountEventAt = now;
  }



  function queueZone() {
    const savedZone = state.survey?.aiQueueZone || state.survey?.queueZone || state.settings?.aiQueueZone || null;
    const zone = savedZone || config.cameraAnalytics.queueZone || {};
    return {
      enabled: zone.enabled !== false && config.cameraAnalytics.queueZoneEnabled !== false,
      x1: clamp(Number(zone.x1 ?? 0), 0, 1),
      y1: clamp(Number(zone.y1 ?? 0), 0, 1),
      x2: clamp(Number(zone.x2 ?? 1), 0, 1),
      y2: clamp(Number(zone.y2 ?? 1), 0, 1)
    };
  }

  function footPointFromBox(bbox, frameWidth, frameHeight) {
    const [x, y, w, h] = bbox;
    return {
      x: clamp((x + w / 2) / Math.max(1, frameWidth), 0, 1),
      y: clamp((y + h) / Math.max(1, frameHeight), 0, 1)
    };
  }

  function centerPointFromBox(bbox, frameWidth, frameHeight) {
    const [x, y, w, h] = bbox;
    return {
      x: clamp((x + w / 2) / Math.max(1, frameWidth), 0, 1),
      y: clamp((y + h / 2) / Math.max(1, frameHeight), 0, 1)
    };
  }

  function insideQueueZone(point) {
    const zone = queueZone();
    if (!zone.enabled) return true;
    const minX = Math.min(zone.x1, zone.x2);
    const maxX = Math.max(zone.x1, zone.x2);
    const minY = Math.min(zone.y1, zone.y2);
    const maxY = Math.max(zone.y1, zone.y2);
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }

  function validatePersonPrediction(prediction, video) {
    const frameWidth = video.videoWidth || 1;
    const frameHeight = video.videoHeight || 1;
    const [x, y, w, h] = prediction.bbox || [0, 0, 0, 0];
    const areaRatio = (w * h) / Math.max(1, frameWidth * frameHeight);
    const heightRatio = h / Math.max(1, frameHeight);
    const aspectRatio = w / Math.max(1, h);
    const foot = footPointFromBox(prediction.bbox, frameWidth, frameHeight);
    const center = centerPointFromBox(prediction.bbox, frameWidth, frameHeight);
    const reasons = [];

    if (!insideQueueZone(foot)) reasons.push("outside-queue-zone");
    if (areaRatio < Number(config.cameraAnalytics.minPersonAreaRatio || 0.006)) reasons.push("tiny-box");
    if (areaRatio > Number(config.cameraAnalytics.maxPersonAreaRatio || 0.55)) reasons.push("oversized-box");
    if (heightRatio < Number(config.cameraAnalytics.minPersonHeightRatio || 0.10)) reasons.push("low-height-box");
    if (heightRatio > Number(config.cameraAnalytics.maxPersonHeightRatio || 0.96)) reasons.push("full-frame-box");
    if (aspectRatio < Number(config.cameraAnalytics.minPersonAspectRatio || 0.16) || aspectRatio > Number(config.cameraAnalytics.maxPersonAspectRatio || 1.25)) reasons.push("bad-person-shape");

    return {
      ok: reasons.length === 0,
      reasons,
      prediction,
      bbox: prediction.bbox,
      score: Number(prediction.score || 0),
      areaRatio,
      heightRatio,
      aspectRatio,
      foot,
      center
    };
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function updatePersonTracks(detections) {
    const now = Date.now();
    const maxDistance = Number(config.cameraAnalytics.trackMatchDistance || 0.16);
    const maxLost = Number(config.cameraAnalytics.maxLostTrackFrames || 5);
    const unmatchedTracks = new Set(state.tracks.keys());
    const matchedDetections = new Set();

    detections.forEach((det, detIndex) => {
      let bestId = null;
      let bestDistance = Infinity;
      state.tracks.forEach((track, id) => {
        if (!unmatchedTracks.has(id)) return;
        const d = distance(track.center, det.center);
        if (d < bestDistance) {
          bestDistance = d;
          bestId = id;
        }
      });

      if (bestId !== null && bestDistance <= maxDistance) {
        const track = state.tracks.get(bestId);
        const motion = distance(track.center, det.center);
        state.tracks.set(bestId, {
          ...track,
          bbox: det.bbox,
          center: det.center,
          foot: det.foot,
          score: det.score,
          hits: track.hits + 1,
          missed: 0,
          lastSeen: now,
          motionScore: clamp(track.motionScore * 0.7 + motion * 0.3, 0, 1),
          areaRatio: det.areaRatio
        });
        unmatchedTracks.delete(bestId);
        matchedDetections.add(detIndex);
      }
    });

    detections.forEach((det, detIndex) => {
      if (matchedDetections.has(detIndex)) return;
      const id = state.nextTrackId++;
      state.tracks.set(id, {
        id,
        bbox: det.bbox,
        center: det.center,
        foot: det.foot,
        score: det.score,
        hits: 1,
        missed: 0,
        firstSeen: now,
        lastSeen: now,
        motionScore: 0,
        areaRatio: det.areaRatio
      });
    });

    unmatchedTracks.forEach(id => {
      const track = state.tracks.get(id);
      if (!track) return;
      track.missed += 1;
      state.tracks.set(id, track);
      if (track.missed > maxLost) state.tracks.delete(id);
    });

    const minHits = Number(config.cameraAnalytics.minConfirmedTrackFrames || 2);
    const missedGrace = Number(config.cameraAnalytics.missedFrameGrace || 2);
    const confirmed = [...state.tracks.values()].filter(track => {
      if (track.hits < minHits) return false;
      if (track.missed > missedGrace) return false;
      if (!insideQueueZone(track.foot)) return false;
      return true;
    });
    return confirmed;
  }

  function validateAndTrackPersons(predictions, video) {
    const validated = predictions.map(item => validatePersonPrediction(item, video));
    const accepted = validated.filter(item => item.ok);
    const rejectedReasons = validated.flatMap(item => item.reasons);
    state.cameraRejectedReasons = [...state.cameraRejectedReasons, ...rejectedReasons].slice(-30);
    if (rejectedReasons.length) {
      state.cameraAnomalies = [...state.cameraAnomalies, ...rejectedReasons.slice(0, 4)].slice(-16);
    }
    const confirmedTracks = updatePersonTracks(accepted);
    return { accepted, rejectedReasons, confirmedTracks };
  }

  function drawDetections(detections) {
    const canvas = $("overlayCanvas");
    const video = $("cameraVideo");
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth || canvas.clientWidth;
    canvas.height = video.videoHeight || canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const zone = queueZone();
    if (zone.enabled) {
      const x = Math.min(zone.x1, zone.x2) * canvas.width;
      const y = Math.min(zone.y1, zone.y2) * canvas.height;
      const w = Math.abs(zone.x2 - zone.x1) * canvas.width;
      const h = Math.abs(zone.y2 - zone.y1) * canvas.height;
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#22d3ee";
      ctx.fillStyle = "rgba(34, 211, 238, 0.10)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "16px system-ui";
      ctx.fillText("Queue Zone", x + 8, Math.max(18, y + 20));
      ctx.restore();
    }

    ctx.lineWidth = 3;
    ctx.font = "16px system-ui";
    detections.forEach(item => {
      const bbox = item.bbox || item.prediction?.bbox || [0, 0, 0, 0];
      const score = Number(item.score ?? item.prediction?.score ?? 0);
      const [x, y, w, h] = bbox;
      ctx.strokeStyle = "#67e8f9";
      ctx.fillStyle = "rgba(6,182,212,0.13)";
      ctx.strokeRect(x, y, w, h);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(`queue person ${Math.round(score * 100)}%`, x + 6, Math.max(18, y + 18));
    });
  }

  function isLocalhost() {
    return ["localhost", "127.0.0.1", "::1", ""].includes(window.location.hostname);
  }

  function cameraContextError() {
    if (window.location.protocol === "file:") {
      return "Camera access is blocked when opening HTML directly. Run the folder with a local server or host it with HTTPS.";
    }
    if (!window.isSecureContext && !isLocalhost()) {
      return "Camera access requires HTTPS or localhost. Open the site from HTTPS or run it locally with a development server.";
    }
    return "";
  }

  function setCameraMessage(title, message) {
    const placeholder = $("cameraPlaceholder");
    if (!placeholder) return;
    placeholder.style.display = "grid";
    placeholder.innerHTML = `<div><h3>${title}</h3><p>${message}</p></div>`;
  }

  function loadScriptOnce(src, globalName, timeoutMs = 18000) {
    return new Promise((resolve, reject) => {
      if (globalName && window[globalName]) return resolve(window[globalName]);

      const finish = () => {
        const value = globalName ? window[globalName] : true;
        if (globalName && !value) reject(new Error(`${globalName} did not initialize after loading ${src}`));
        else resolve(value);
      };

      const existing = Array.from(document.scripts).find(script => script.src === src);
      if (existing) {
        if (globalName && window[globalName]) return resolve(window[globalName]);
        const timer = setTimeout(() => reject(new Error(`Timed out while loading ${src}`)), timeoutMs);
        existing.addEventListener("load", () => { clearTimeout(timer); finish(); }, { once: true });
        existing.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); }, { once: true });
        return;
      }

      const script = document.createElement("script");
      const timer = setTimeout(() => {
        script.remove();
        reject(new Error(`Timed out while loading ${src}`));
      }, timeoutMs);
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => { clearTimeout(timer); finish(); };
      script.onerror = () => { clearTimeout(timer); reject(new Error(`Failed to load ${src}`)); };
      document.head.appendChild(script);
    });
  }

  async function loadScriptFromAny(candidates, globalName, label) {
    if (globalName && window[globalName]) return window[globalName];
    const errors = [];
    for (const src of candidates) {
      try {
        log(`Loading ${label} from ${new URL(src).hostname}...`);
        return await loadScriptOnce(src, globalName);
      } catch (error) {
        errors.push(error.message);
        log(`${label} load attempt failed: ${error.message}`);
      }
    }
    throw new Error(`${label} could not load. ${errors.join(" | ")}`);
  }

  async function ensureTfReady() {
    if (!window.tf) throw new Error("TensorFlow.js is unavailable after script loading.");
    if (window.tf.ready) await window.tf.ready();
    try {
      if (window.tf.setBackend) {
        try {
          await window.tf.setBackend("webgl");
        } catch (_) {
          await window.tf.setBackend("cpu");
        }
      }
      if (window.tf.ready) await window.tf.ready();
    } catch (error) {
      throw new Error(`TensorFlow backend failed: ${error.message}`);
    }
  }

  async function ensureAiModel() {
    if (state.model) return state.model;
    setText("modelStatus", "Loading AI");
    classPill("modelStatus", "warning");
    setCameraMessage("Loading AI model", "Please wait. The camera will start only after the person-counting model is ready.");

    const tfSources = [
      "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
      "https://unpkg.com/@tensorflow/tfjs@4.22.0/dist/tf.min.js"
    ];
    const cocoSources = [
      "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js",
      "https://unpkg.com/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js"
    ];

    try {
      await loadScriptFromAny(tfSources, "tf", "TensorFlow.js");
      await ensureTfReady();
      await loadScriptFromAny(cocoSources, "cocoSsd", "COCO-SSD");
      if (!window.cocoSsd?.load) throw new Error("COCO-SSD model loader is unavailable.");

      setText("modelStatus", "Opening model");
      state.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
      state.cameraFallbackMode = false;
      setText("modelStatus", "AI Loaded");
      classPill("modelStatus", "online");
      log("AI person-counting model loaded successfully.");
      return state.model;
    } catch (error) {
      state.model = null;
      state.cameraFallbackMode = false;
      setText("modelStatus", "AI Failed");
      classPill("modelStatus", "danger");
      setCameraMessage("AI model failed", "The camera was not started because person-counting AI is required. Check internet/CDN access and run the site from localhost or HTTPS.");
      throw new Error(`AI model failed to load: ${error.message}`);
    }
  }

  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(device => device.kind === "videoinput");
      const select = $("cameraSelect");
      if (!select) return;
      const current = select.value;
      select.innerHTML = '<option value="">Default camera</option>';
      cameras.forEach((camera, index) => {
        const option = document.createElement("option");
        option.value = camera.deviceId;
        option.textContent = camera.label || `Camera ${index + 1}`;
        select.appendChild(option);
      });
      if (current) select.value = current;
    } catch (error) {
      log(`Camera list failed: ${error.message}`);
    }
  }

  async function startCamera() {
    const contextProblem = cameraContextError();
    if (contextProblem) {
      setText("cameraStatus", "Blocked");
      classPill("cameraStatus", "danger");
      setText("modelStatus", "Waiting");
      classPill("modelStatus", "warning");
      setCameraMessage("Camera blocked", contextProblem);
      storage.toast(contextProblem);
      log(`Camera access blocked: ${contextProblem}`);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = "Your browser does not support webcam access.";
      setText("cameraStatus", "Unsupported");
      classPill("cameraStatus", "danger");
      setCameraMessage("Camera unsupported", message);
      storage.toast(message);
      log(message);
      return;
    }

    const startButton = $("startCameraButton");
    if (startButton) {
      startButton.disabled = true;
      startButton.textContent = "Starting AI...";
    }

    try {
      setText("cameraStatus", "Waiting for AI");
      classPill("cameraStatus", "warning");
      setText("modelStatus", "Loading AI");
      classPill("modelStatus", "warning");
      if (state.stream) stopCamera(false);

      await ensureAiModel();

      setText("cameraStatus", "Opening camera");
      classPill("cameraStatus", "warning");
      setCameraMessage("Opening camera", "Allow camera permission when the browser asks.");

      const deviceId = $("cameraSelect")?.value;
      const constraints = {
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = $("cameraVideo");
      if (!video) throw new Error("Camera video element is missing from the page.");
      video.srcObject = state.stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      state.cameraRunning = true;
      state.cameraReady = true;
      state.cameraFallbackMode = false;
      const placeholder = $("cameraPlaceholder");
      if (placeholder) placeholder.style.display = "none";
      setText("cameraStatus", "AI Live");
      classPill("cameraStatus", "online");
      await enumerateCameras();
      log("Camera opened. AI person detection started.");
      detectLoop();
    } catch (error) {
      if (state.stream) stopCamera(false);
      state.cameraRunning = false;
      state.cameraReady = false;
      state.cameraFallbackMode = false;
      setText("cameraStatus", "Offline");
      classPill("cameraStatus", "offline");
      if (!String(error.message || "").includes("AI model failed")) {
        setText("modelStatus", state.model ? "AI Loaded" : "Error");
        classPill("modelStatus", state.model ? "online" : "danger");
      }
      const friendly = error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in the browser and try again."
        : error.name === "NotFoundError"
          ? "No camera was found. Connect a webcam and try again."
          : error.message || "AI camera failed to start.";
      if (!String(friendly).includes("AI model failed")) setCameraMessage("AI camera failed", friendly);
      storage.toast(friendly);
      log(`AI camera start failed: ${friendly}`);
    } finally {
      if (startButton) {
        startButton.disabled = false;
        startButton.textContent = "Start AI Camera";
      }
    }
  }

  function stopCamera(showToast = true) {
    state.cameraRunning = false;
    state.cameraReady = false;
    state.cameraFallbackMode = false;
    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }
    const video = $("cameraVideo");
    if (video) video.srcObject = null;
    const placeholder = $("cameraPlaceholder");
    if (placeholder) placeholder.style.display = "grid";
    setText("cameraStatus", "Offline");
    classPill("cameraStatus", "offline");
    if (showToast) storage.toast("AI camera stopped.");
    log("AI camera stopped.");
    updateAll();
  }

  async function detectLoop() {
    if (!state.cameraRunning || !state.model) return;
    const video = $("cameraVideo");
    if (!video || video.readyState < 2) {
      setTimeout(detectLoop, config.cameraAnalytics.detectionIntervalMs);
      return;
    }
    try {
      state.confidenceThreshold = Number($("confidenceInput")?.value || state.confidenceThreshold);
      const predictions = await state.model.detect(video);
      const personCandidates = predictions.filter(item => item.class === "person" && item.score >= state.confidenceThreshold);
      const { accepted, confirmedTracks } = validateAndTrackPersons(personCandidates, video);

      // rawAICount now means validated queue-zone detections, not every person in the full frame.
      state.rawAICount = accepted.length;
      const confirmedCount = confirmedTracks.length;

      const frameArea = (video.videoWidth || 1) * (video.videoHeight || 1);
      const centers = confirmedTracks.map(track => track.center);
      const areaRatio = confirmedTracks.reduce((sum, track) => sum + Number(track.areaRatio || 0), 0) ||
        accepted.reduce((sum, item) => sum + ((item.bbox[2] * item.bbox[3]) / frameArea), 0);
      state.cameraDensityRatio = clamp(areaRatio, 0, 1);
      state.lineFormationScore = calculateLineFormation(centers);
      const movement = calculateMovement(centers);
      state.movementScores.push(movement);
      state.movementScores = state.movementScores.slice(-20);

      state.recentCounts.push(confirmedCount);
      state.recentCounts = state.recentCounts.slice(-config.cameraAnalytics.stableWindowSize);
      const newStable = deriveStableCameraCount(confirmedCount);
      state.stableAICount = newStable;
      state.countTimeline.push({ time: Date.now(), count: newStable });
      state.countTimeline = state.countTimeline.slice(-50);
      recordCountEvents(newStable);
      drawDetections(confirmedTracks);
      updateAll();
    } catch (error) {
      log(`AI detection error: ${error.message}`);
    }
    setTimeout(detectLoop, config.cameraAnalytics.detectionIntervalMs);
  }

  function normalizeEsp32Data(data) {
    const entry = Number(data.entryCount ?? data.entries ?? data.inCount ?? 0);
    const exit = Number(data.exitCount ?? data.exits ?? data.outCount ?? 0);
    const current = Number(data.currentPeople ?? data.peopleCount ?? data.queueCount ?? Math.max(0, entry - exit));
    const distance = Number(data.distanceCm ?? data.ultrasonicCm ?? data.distance ?? NaN);
    const occupied = Boolean(data.ultrasonicOccupied ?? data.occupied ?? (Number.isFinite(distance) && distance > 0 && distance < 90));
    const irEntry = String(data.irEntryState ?? data.irState ?? data.entryIrState ?? "unknown");
    const irExit = String(data.irExitState ?? data.exitIrState ?? "unknown");
    return {
      raw: data,
      deviceId: data.deviceId || data.device_id || "ESP32",
      currentPeople: Math.max(0, current),
      entryCount: Math.max(0, entry),
      exitCount: Math.max(0, exit),
      distanceCm: Number.isFinite(distance) ? round(distance, 1) : null,
      ultrasonicOccupied: occupied,
      irEntryState: irEntry,
      irExitState: irExit,
      uptimeMs: Number(data.uptimeMs || data.uptime || 0),
      wifiRssi: data.wifiRssi ?? data.rssi ?? null,
      timestamp: data.createdAt ? new Date(data.createdAt).getTime() : (data.receivedAt ? new Date(data.receivedAt).getTime() : Date.now())
    };
  }

  function esp32Url() {
    const ip = ($("esp32IpInput")?.value || "").trim();
    const endpoint = ($("esp32EndpointInput")?.value || config.esp32.defaultEndpoint).trim();
    if (!ip) throw new Error("Enter the ESP32 IP address first.");
    const base = ip.startsWith("http://") || ip.startsWith("https://") ? ip.replace(/\/$/, "") : `http://${ip.replace(/\/$/, "")}`;
    if (window.location.protocol === "https:" && base.startsWith("http://")) {
      throw new Error("Browser mixed-content protection blocks HTTP ESP32 calls from an HTTPS website. Use cloud push through Supabase, or test the local bridge from localhost/http.");
    }
    return `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  }

  async function pollCloudEsp32() {
    if (!state.esp32Connected) return;
    try {
      const reading = await storage.getLatestDeviceReading(partner.id);
      if (!reading) {
        setText("esp32Status", "Waiting for cloud data");
        classPill("esp32Status", "warning");
        log("No ESP32 cloud readings yet. Keep ESP32 powered and wait for Cloud code: 200.");
        return;
      }
      const normalized = normalizeEsp32Data(reading);
      const readingTime = normalized.timestamp || Date.now();
      const ageMs = Date.now() - readingTime;
      recordSensorEvents(normalized);
      state.esp32Data = normalized;
      state.esp32LastReadAt = readingTime;
      if (ageMs <= config.esp32.offlineAfterMs * 3) {
        setText("esp32Status", "Cloud Online");
        classPill("esp32Status", "online");
      } else {
        setText("esp32Status", "Cloud Stale");
        classPill("esp32Status", "warning");
      }
      const cloudStatus = await storage.getCurrentQueueStatus(partner.id).catch(() => null);
      if (cloudStatus) state.latestStatus = cloudStatus;
      updateAll();
    } catch (error) {
      setText("esp32Status", "Cloud Error");
      classPill("esp32Status", "offline");
      log(`ESP32 cloud polling failed: ${error.message}. Check Supabase schema, RLS, login session, and device_readings table.`);
    }
  }

  async function pollLocalEsp32() {
    if (!state.esp32Connected) return;
    try {
      const response = await fetch(esp32Url(), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const normalized = normalizeEsp32Data(data);
      recordSensorEvents(normalized);
      state.esp32Data = normalized;
      state.esp32LastReadAt = Date.now();
      setText("esp32Status", "Local Online");
      classPill("esp32Status", "online");
      updateAll();
    } catch (error) {
      setText("esp32Status", "Local Offline");
      classPill("esp32Status", "offline");
      log(`Local ESP32 polling failed: ${error.message}. Hosted HTTPS pages usually cannot call local HTTP ESP32 IPs. Use cloud sync for deployment.`);
    }
  }

  function pollEsp32() {
    return state.esp32Source === "local" ? pollLocalEsp32() : pollCloudEsp32();
  }

  function recordSensorEvents(data) {
    const now = Date.now();
    if (data.entryCount > state.esp32PreviousEntry) {
      const diff = data.entryCount - state.esp32PreviousEntry;
      for (let i = 0; i < diff; i++) state.sensorEvents.push({ type: "entry", time: now });
      log(`ESP32 IR entry count increased: ${state.esp32PreviousEntry} → ${data.entryCount}.`);
    }
    if (data.exitCount > state.esp32PreviousExit) {
      const diff = data.exitCount - state.esp32PreviousExit;
      for (let i = 0; i < diff; i++) state.sensorEvents.push({ type: "exit", time: now });
      if (state.lastSensorServiceAt) {
        const interval = minutesBetween(state.lastSensorServiceAt, now);
        if (interval <= config.cameraAnalytics.maxServiceIntervalMinutes) {
          state.sensorServiceIntervals.push(interval);
          saveLearnedServiceSample(interval, "esp32");
        }
      }
      state.lastSensorServiceAt = now;
      log(`ESP32 IR exit/served count increased: ${state.esp32PreviousExit} → ${data.exitCount}.`);
    }
    state.esp32PreviousEntry = data.entryCount;
    state.esp32PreviousExit = data.exitCount;
    state.sensorEvents = state.sensorEvents.slice(-80);
    state.sensorServiceIntervals = state.sensorServiceIntervals.slice(-12);
  }

  function connectEsp32() {
    const localIp = ($("esp32IpInput")?.value || "").trim();
    const forceLocal = Boolean(localIp);
    try {
      if (forceLocal) esp32Url();
      state.esp32Source = forceLocal ? "local" : "cloud";
      state.esp32Connected = true;
      clearInterval(state.esp32Timer);
      state.esp32Timer = setInterval(pollEsp32, config.esp32.pollIntervalMs);
      setText("esp32Status", forceLocal ? "Connecting Local" : "Connecting Cloud");
      classPill("esp32Status", "warning");
      log(forceLocal
        ? "Local ESP32 bridge started. This only works on the same network and usually not from hosted HTTPS pages."
        : "ESP32 cloud sync started. Reading sensor data from Supabase device_readings.");
      pollEsp32();
    } catch (error) {
      storage.toast(error.message);
      log(`ESP32 connection failed: ${error.message}`);
    }
  }

  function disconnectEsp32() {
    state.esp32Connected = false;
    clearInterval(state.esp32Timer);
    state.esp32Timer = null;
    state.esp32Data = null;
    state.esp32LastReadAt = null;
    setText("esp32Status", "Offline");
    classPill("esp32Status", "offline");
    log("ESP32 sensor sync disconnected.");
    updateAll();
  }

  async function resetEsp32() {
    try {
      const baseUrl = esp32Url().replace($("esp32EndpointInput")?.value || config.esp32.defaultEndpoint, "");
      await fetch(`${baseUrl}${config.esp32.resetEndpoint}`, { cache: "no-store" });
      state.esp32PreviousEntry = 0;
      state.esp32PreviousExit = 0;
      state.sensorEvents = [];
      state.sensorServiceIntervals = [];
      storage.toast("ESP32 reset requested.");
      log("ESP32 reset endpoint called.");
    } catch (error) {
      storage.toast("Reset failed. You can press the ESP32 reset button instead.");
      log(`ESP32 reset failed: ${error.message}`);
    }
  }

  function sourceAvailability() {
    const camera = state.cameraReady && state.recentCounts.length >= 2;
    const esp32 = state.esp32Data && state.esp32LastReadAt && Date.now() - state.esp32LastReadAt < config.esp32.offlineAfterMs;
    return { camera, esp32 };
  }

  function sensorConfidence() {
    const available = sourceAvailability().esp32;
    if (!available) {
      state.sensorQualityScore = 0;
      return "Low";
    }
    const data = state.esp32Data;
    let score = 42;
    if (Number.isFinite(data.currentPeople)) score += 18;
    if (Number.isFinite(data.distanceCm)) score += 12;
    if (data.entryCount || data.exitCount) score += 12;
    if (data.irEntryState !== "unknown" || data.irExitState !== "unknown") score += 8;
    if (Number(data.wifiRssi) && Number(data.wifiRssi) > -75) score += 8;
    if (data.exitCount > data.entryCount + 2) score -= 18;
    if (sensorAlert() !== "None") score -= 18;
    if (state.sensorServiceIntervals.length >= 2) score += 10;
    state.sensorQualityScore = clamp(score, 0, 100);
    return qualityLabel(state.sensorQualityScore);
  }

  function cameraConfidence() {
    if (!state.cameraReady) {
      state.cameraQualityScore = 0;
      return "Low";
    }
    let score = 32;
    const confirmedTracks = [...state.tracks.values()].filter(track => track.hits >= Number(config.cameraAnalytics.minConfirmedTrackFrames || 2) && track.missed <= Number(config.cameraAnalytics.missedFrameGrace || 2)).length;
    if (state.recentCounts.length >= config.cameraAnalytics.stableWindowSize) score += 20;
    if (confirmedTracks >= state.stableAICount && confirmedTracks > 0) score += 16;
    if (state.serviceIntervals.length >= 2) score += 14;
    if (state.lineFormationScore >= 55) score += 10;
    else if (state.lineFormationScore >= 30) score += 5;
    if (state.cameraDensityRatio >= 0 && Number.isFinite(state.cameraDensityRatio)) score += 8;
    if (state.rawAICount === state.stableAICount) score += 4;
    score -= cameraAnomalyPenalty();
    state.cameraQualityScore = clamp(score, 0, 100);
    return qualityLabel(state.cameraQualityScore);
  }

  function chooseQueueCount() {
    const available = sourceAvailability();
    const sourceMode = state.settings.sourceMode;
    const ai = Math.max(0, Math.round(state.stableAICount));
    const sensor = Math.max(0, Math.round(state.esp32Data?.currentPeople ?? 0));
    const camQuality = cameraConfidence();
    const senQuality = sensorConfidence();
    const camScore = state.cameraQualityScore || qualityValue(camQuality);
    const senScore = state.sensorQualityScore || qualityValue(senQuality);

    if (sourceMode === "camera") {
      const count = applyContinuityGuard(available.camera ? ai : 0, "camera-only", false);
      return { count, mode: available.camera ? "camera-only" : "waiting", quality: available.camera ? camQuality : "Low" };
    }
    if (sourceMode === "esp32") {
      const count = applyContinuityGuard(available.esp32 ? sensor : 0, "esp32-only", false);
      return { count, mode: available.esp32 ? "esp32-only" : "waiting", quality: available.esp32 ? senQuality : "Low" };
    }
    if (sourceMode === "fusion" || (sourceMode === "auto" && available.camera && available.esp32)) {
      if (!available.camera && available.esp32) {
        const count = applyContinuityGuard(sensor, "esp32-only", false);
        return { count, mode: "esp32-only", quality: senQuality };
      }
      if (available.camera && !available.esp32) {
        const count = applyContinuityGuard(ai, "camera-only", false);
        return { count, mode: "camera-only", quality: camQuality };
      }
      const diff = Math.abs(ai - sensor);
      const diffRatio = diff / Math.max(1, Math.max(ai, sensor));
      const agreementGood = diff <= 2 || diffRatio <= 0.2;
      let candidate;
      let quality;
      if (agreementGood) {
        candidate = blendedCount(ai, sensor, camScore, senScore);
        quality = camScore >= 70 && senScore >= 70 ? "High" : "Medium";
      } else if (camScore >= senScore + 20) {
        candidate = ai;
        quality = camQuality === "High" ? "Medium" : "Low";
      } else if (senScore >= camScore + 20) {
        candidate = sensor;
        quality = senQuality === "High" ? "Medium" : "Low";
      } else {
        candidate = Math.max(ai, sensor);
        quality = "Low";
      }
      const count = applyContinuityGuard(candidate, "combined-fusion", agreementGood);
      return { count, mode: "combined-fusion", quality };
    }
    if (available.camera) {
      const count = applyContinuityGuard(ai, "camera-only", false);
      return { count, mode: "camera-only", quality: camQuality };
    }
    if (available.esp32) {
      const count = applyContinuityGuard(sensor, "esp32-only", false);
      return { count, mode: "esp32-only", quality: senQuality };
    }
    return { count: 0, mode: "waiting", quality: "Low" };
  }

  function sensorFlowRate() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recent = state.sensorEvents.filter(event => event.time >= oneHourAgo).length;
    const oldest = state.sensorEvents[0]?.time;
    if (!oldest || state.sensorEvents.length < 2) return 0;
    const hours = Math.max(1 / 60, (Date.now() - oldest) / 3600000);
    return round(recent / hours, 1);
  }

  function calculateWait(finalCount) {
    const learned = learnedDailyServiceTime();
    const noWaitLimit = Math.max(1, Number(state.settings.noWaitQueueLimit || state.settings.lowCrowdLimit || 8));
    const target = learned.target;

    if (finalCount <= noWaitLimit) {
      return {
        wait: 0,
        averageServiceTime: learned.ready ? learned.average : null,
        observedServiceInterval: null,
        basis: `Queue is ${finalCount}/${noWaitLimit}. Visitor can visit now; wait-time prediction is not needed for low queue.`,
        confidence: learned.ready ? learned.confidence : "Medium",
        effectiveServiceInterval: 0,
        loadFactor: 1,
        learningSamples: learned.samples,
        learningTarget: target,
        learningReady: learned.ready
      };
    }

    if (!learned.ready) {
      return {
        wait: 0,
        averageServiceTime: null,
        observedServiceInterval: null,
        basis: `Learning today’s service speed: ${learned.samples}/${target} served-visitor samples collected. Wait time starts after learning is complete.`,
        confidence: "Learning",
        effectiveServiceInterval: 0,
        loadFactor: 1,
        learningSamples: learned.samples,
        learningTarget: target,
        learningReady: false
      };
    }

    const cameraObserved = robustInterval(state.serviceIntervals.slice(-12));
    const sensorObserved = robustInterval(state.sensorServiceIntervals.slice(-12));
    const observedPool = [];
    if (cameraObserved.value) observedPool.push(...state.serviceIntervals.slice(-12));
    if (sensorObserved.value) observedPool.push(...state.sensorServiceIntervals.slice(-12));
    const observed = robustInterval(observedPool);
    const learnedSystemInterval = learned.average / Math.max(1, state.settings.activeCounters);
    const arrivalRate = perHourFromIntervals(state.arrivalIntervals.slice(-10));
    const serviceRate = observed.value ? round(60 / observed.value, 1) : round(60 / Math.max(learnedSystemInterval, 0.1), 1);
    let effectiveInterval = learnedSystemInterval;
    let confidence = learned.confidence;
    let basis = `Learned from today’s first ${target} served visitors ÷ active counters`;

    const minLiveSamples = Number(config.cameraAnalytics.liveServiceMinSamples || target);
    const liveWeight = clamp(Number(config.cameraAnalytics.liveServiceWeight || 0.6), 0.35, 0.85);

    if (observed.value && observed.samples >= minLiveSamples) {
      const observedLooksAbnormal = observed.value > learnedSystemInterval * 3.5 || observed.value < learnedSystemInterval * 0.25;
      if (observedLooksAbnormal && observed.samples < minLiveSamples + 2) {
        effectiveInterval = learnedSystemInterval * 0.75 + observed.value * 0.25;
        confidence = "Medium";
        basis = "Daily learned service speed protected abnormal live interval";
      } else {
        const adaptiveLiveWeight = observed.samples >= target && observed.stability >= 70 ? Math.min(0.75, liveWeight + 0.1) : liveWeight;
        effectiveInterval = observed.value * adaptiveLiveWeight + learnedSystemInterval * (1 - adaptiveLiveWeight);
        confidence = observed.samples >= target && observed.stability >= 70 ? "High" : "Medium";
        basis = `${Math.round(adaptiveLiveWeight * 100)}% live service speed + ${Math.round((1 - adaptiveLiveWeight) * 100)}% daily learned speed`;
      }
    }

    const trend = getTrend();
    let loadFactor = 1;
    if (trend === "Increasing" && serviceRate > 0 && arrivalRate > serviceRate) {
      loadFactor += clamp((arrivalRate / serviceRate - 1) * 0.25, 0.05, 0.6);
      confidence = confidence === "High" ? "Medium" : confidence;
    }

    const stagnantMinutes = Number(config.cameraAnalytics.stagnantGuardMinutes || 8);
    const noRecentService = finalCount > 0 && state.lastServiceAt && (Date.now() - state.lastServiceAt) / 60000 > Math.max(stagnantMinutes, learned.average * 2);
    const noSensorService = finalCount > 0 && state.lastSensorServiceAt && (Date.now() - state.lastSensorServiceAt) / 60000 > Math.max(stagnantMinutes, learned.average * 2);
    if ((noRecentService || noSensorService) && trend !== "Decreasing") {
      loadFactor += 0.15;
      confidence = "Low";
      basis = `${basis} + stagnant queue guard`;
    }

    return {
      wait: Math.max(0, Math.round(finalCount * effectiveInterval * loadFactor)),
      averageServiceTime: learned.average,
      observedServiceInterval: observed.value ? round(observed.value, 2) : null,
      basis,
      confidence,
      effectiveServiceInterval: round(effectiveInterval, 2),
      loadFactor: round(loadFactor, 2),
      learningSamples: learned.samples,
      learningTarget: target,
      learningReady: true
    };
  }


  function getScheduleState() {
    if (window.AIOTQueueEngine?.scheduleStatus) {
      return window.AIOTQueueEngine.scheduleStatus(state.settings);
    }
    return { isOpen: state.settings.isOpen !== false, label: state.settings.isOpen === false ? "Closed manually" : "Open now", nextOpeningText: "Schedule unavailable" };
  }

  function buildAlerts(status) {
    const alerts = [];
    if (status.isOpen === false) alerts.push("Location closed");
    if (status.confidence === "Low") alerts.push("Low confidence reading");
    if (status.crowdLevel === "High") alerts.push("High crowd level");
    if (status.queueTrend === "Increasing" && Number(status.arrivalRatePerHour || 0) > Number(status.serviceRatePerHour || 0)) alerts.push("Queue increasing faster than service rate");
    if (status.sensorAlert && status.sensorAlert !== "None") alerts.push(`Sensor alert: ${status.sensorAlert}`);
    if (status.dataMode === "waiting") alerts.push("No live source available");
    return alerts.slice(0, 5);
  }

  function bestAdvice(crowdLevel, wait, trend, isOpen, scheduleState, waitInfo, finalCount) {
    if (!isOpen) return { status: "Closed", advice: scheduleState?.nextOpeningText || "Closed now", recommendation: `This service location is currently marked closed. ${scheduleState?.nextOpeningText || "Check again later before visiting."}` };
    if (scheduleState?.label === "Closing soon") return { status: "Closing Soon", advice: "Visit only if urgent", recommendation: `This location is closing soon. Check the live queue before travelling.` };
    if (waitInfo?.learningReady === false && finalCount > Number(state.settings.noWaitQueueLimit || 8)) return { status: "Learning", advice: "Learning service speed", recommendation: `The system is learning today’s service speed (${waitInfo.learningSamples}/${waitInfo.learningTarget} samples). Wait time will appear after learning is complete.` };
    if (finalCount <= Number(state.settings.noWaitQueueLimit || 8)) return { status: "Open", advice: "You can visit now", recommendation: `Queue is low (${finalCount} people or fewer). You can visit now without relying on a wait-time prediction.` };
    if (crowdLevel === "Medium" || wait <= 25) return { status: "Busy", advice: trend === "Increasing" ? "Visit soon or delay" : "Acceptable wait", recommendation: `Queue is ${crowdLevel.toLowerCase()} and trend is ${trend.toLowerCase()}. Estimated wait is ${wait} minutes.` };
    return { status: "Very Busy", advice: "Try later", recommendation: `Crowd is high. Estimated wait is ${wait} minutes. Visiting later is better unless urgent.` };
  }

  function buildStatus() {
    const chosen = chooseQueueCount();
    const finalCount = chosen.count;
    state.lastReliableFinalCount = finalCount;
    state.lastFinalCountAt = Date.now();
    state.finalCountTimeline.push({ time: state.lastFinalCountAt, count: finalCount });
    state.finalCountTimeline = state.finalCountTimeline.slice(-60);
    const wait = calculateWait(finalCount);
    const crowdLevel = getCrowdLevel(finalCount);
    const trend = getTrend();
    const occupancy = Math.round((finalCount / Math.max(1, state.settings.maxQueueCapacity)) * 100);
    const density = densityLabel(finalCount);
    const scheduleState = getScheduleState();
    const effectiveOpen = scheduleState.isOpen !== false;
    if (!effectiveOpen) {
      wait.wait = 0;
      wait.basis = "Closed status: wait time is not useful while the service location is closed";
      wait.confidence = "High";
    }
    const advice = bestAdvice(crowdLevel, wait.wait, trend, effectiveOpen, scheduleState, wait, finalCount);
    const confidenceOrder = { Learning: 0, Low: 1, Medium: 2, High: 3 };
    const finalConfidence = confidenceOrder[chosen.quality] < confidenceOrder[wait.confidence] ? chosen.quality : wait.confidence;
    const sourceQuality = chosen.mode === "combined-fusion" ? `AI/Sensor agreement: ${chosen.quality}` : `${chosen.mode}: ${chosen.quality}`;

    const status = {
      partnerId: partner.id,
      organizationName: partner.organizationName,
      organizationType: partner.organizationType,
      serviceLocation: partner.serviceLocation,
      isPublic: state.settings.isPublic,
      isOpen: effectiveOpen,
      manualOpen: state.settings.isOpen,
      scheduleEnabled: state.settings.scheduleEnabled,
      openingTime: state.settings.openingTime,
      closingTime: state.settings.closingTime,
      closedDays: state.settings.closedDays,
      scheduleStatus: scheduleState.label,
      nextOpeningText: scheduleState.nextOpeningText,
      dataMode: chosen.mode,
      queueLength: finalCount,
      aiPeopleCount: state.stableAICount,
      rawAICount: state.rawAICount,
      sensorPeopleCount: state.esp32Data?.currentPeople || 0,
      finalPeopleCount: finalCount,
      crowdLevel,
      estimatedWaitTime: wait.wait,
      averageServiceTime: wait.averageServiceTime,
      learningSamples: wait.learningSamples,
      learningTarget: wait.learningTarget,
      learningReady: wait.learningReady,
      observedServiceInterval: wait.observedServiceInterval,
      waitBasis: wait.basis,
      activeCounters: state.settings.activeCounters,
      confidence: finalConfidence,
      cameraConfidence: cameraConfidence(),
      sensorConfidence: sensorConfidence(),
      sourceQuality,
      queueTrend: trend,
      occupancyPercent: clamp(occupancy, 0, 999),
      queueDensity: density,
      lineFormation: formationLabel(),
      cameraMovement: movementLabel(),
      arrivalRatePerHour: perHourFromIntervals(state.arrivalIntervals.slice(-8)),
      serviceRatePerHour: perHourFromIntervals([...state.serviceIntervals, ...state.sensorServiceIntervals].slice(-8)),
      entryCount: state.esp32Data?.entryCount || 0,
      exitCount: state.esp32Data?.exitCount || 0,
      distanceCm: state.esp32Data?.distanceCm ?? null,
      sensorOccupancy: state.esp32Data ? (state.esp32Data.ultrasonicOccupied ? "Occupied" : "Clear") : "--",
      sensorFlowRate: sensorFlowRate(),
      sensorAlert: sensorAlert(),
      deviceHealth: deviceHealth(),
      bestVisitAdvice: advice.advice,
      recommendation: advice.recommendation,
      status: advice.status,
      analysisSummary: analysisSummary(chosen.mode, finalConfidence, trend),
      alerts: [],
      alertSummary: "No active alert.",
      lastUpdated: storage.nowIso()
    };
    status.alerts = buildAlerts(status);
    status.alertSummary = status.alerts[0] || "No active alert.";
    state.latestStatus = status;
    return status;
  }

  function sensorAlert() {
    if (!state.esp32Data) return "None";
    const data = state.esp32Data;
    if (String(data.irEntryState).toLowerCase().includes("blocked") && String(data.irExitState).toLowerCase().includes("blocked")) return "Both IR blocked";
    if (data.distanceCm !== null && data.distanceCm < 4) return "Too close";
    if (data.distanceCm !== null && data.distanceCm > 350) return "Out of range";
    return "None";
  }

  function deviceHealth() {
    const available = sourceAvailability();
    if (available.camera && available.esp32) return "Camera + ESP32 online";
    if (available.camera) return "Camera AI online";
    if (available.esp32) return "ESP32 online";
    return "Waiting for devices";
  }

  function analysisSummary(mode, confidence, trend) {
    if (mode === "waiting") return "No live source yet";
    if (mode === "camera-only") return `Camera-only AI · ${confidence} confidence · ${trend} trend`;
    if (mode === "esp32-only") return `${state.esp32Source === "cloud" ? "ESP32 cloud" : "ESP32 local"} sensors · ${confidence} confidence · IR sensors active`;
    return `Combined camera + ESP32 · ${confidence} confidence · ${trend} trend`;
  }

  function updateUi(status) {
    setText("organizationName", partner.organizationName);
    setText("hubSubtitle", `${partner.organizationType} · ${partner.serviceLocation}`);
    setText("syncMode", storage.getMode?.() || "Local");
    setText("dataMode", status.dataMode.replace("-", " "));
    setText("modeLabel", status.dataMode);
    setText("aiPeopleCount", status.aiPeopleCount);
    setText("sensorPeopleCount", status.sensorPeopleCount);
    setText("finalPeopleCount", status.finalPeopleCount);
    setText("estimatedWaitTime", status.estimatedWaitTime);
    setText("waitBasis", status.waitBasis);
    setText("rawAICount", status.rawAICount || 0);
    setText("aiSamples", state.recentCounts.length);
    setText("observedServiceInterval", status.observedServiceInterval ?? "--");
    setText("arrivalRatePerHour", status.arrivalRatePerHour);
    setText("serviceRatePerHour", status.serviceRatePerHour);
    setText("queueTrend", status.queueTrend);
    setText("occupancyPercent", status.occupancyPercent);
    setText("cameraMovement", status.cameraMovement);
    setText("esp32DeviceId", state.esp32Data?.deviceId || "--");
    setText("sensorConfidence", status.sensorConfidence);
    setText("irEntryState", state.esp32Data?.irEntryState || "--");
    setText("irExitState", state.esp32Data?.irExitState || "--");
    setText("entryCount", status.entryCount);
    setText("exitCount", status.exitCount);
    setText("distanceCm", status.distanceCm ?? "--");
    setText("sensorOccupancy", status.sensorOccupancy);
    setText("sensorFlowRate", status.sensorFlowRate);
    setText("sensorAlert", status.sensorAlert);
    setText("predictionConfidence", status.confidence);
    setText("crowdLevel", status.crowdLevel);
    setText("averageServiceTime", status.averageServiceTime ?? "--");
    setText("serviceRecordsCount", status.learningSamples ?? todayServiceRecords().length);
    setText("learningTargetCount", status.learningTarget ?? dailyLearningTarget());
    setText("queueDensity", status.queueDensity);
    setText("lineFormation", status.lineFormation);
    setText("sourceQuality", status.sourceQuality);
    setText("bestVisitAdvice", status.bestVisitAdvice);
    setText("recommendationText", status.recommendation);
    setText("lastUpdated", new Date(status.lastUpdated).toLocaleTimeString());
    setText("deviceHealth", status.deviceHealth);
    setText("analysisSummary", status.analysisSummary);
    setText("scheduleStatusText", status.scheduleStatus || "--");
    setText("nextOpeningText", status.nextOpeningText || "--");
    setText("alertCount", (status.alerts || []).length);
    setText("primaryAlertText", status.alertSummary || "No active alert.");
    const h = status.historyStats || {};
    setText("todayAverageWait", h.todayAverageWait ?? 0);
    setText("peakHourText", h.peakHourText || "--");
    setText("bestHourText", h.bestHourText || "--");
    setText("publicStatusText", status.isPublic ? "Published" : "Private");
    setText("queueStatusPill", status.status);

    const readiness = calculateReadiness();
    setText("readinessScore", `${readiness.score}%`);
    setText("readinessText", readiness.text);
    classPill("queueStatusPill", status.status === "Open" ? "online" : status.status === "Closed" ? "offline" : "warning");
    classPill("predictionConfidence", status.confidence === "High" ? "online" : status.confidence === "Medium" ? "warning" : "offline");
    classPill("modeLabel", status.dataMode === "waiting" ? "warning" : "online");
    const dot = $("modeDot");
    if (dot) dot.className = status.dataMode === "waiting" ? "pulse-dot warning" : "pulse-dot";
  }

  function calculateReadiness() {
    const available = sourceAvailability();
    let score = 12;
    if (survey.hasWifi) score += 8;
    if (survey.hasPowerSupply) score += 8;
    if (survey.hasGoodLighting) score += 8;
    if (survey.aiSetupCompleted || survey.aiQueueZone || survey.queueZone) score += 18;
    if (Number(survey.aiReadinessScore || 0) >= 70) score += 10;
    if (available.camera) score += 26;
    if (available.esp32) score += 20;
    score = clamp(score, 0, 100);
    if (score >= 80) return { score, text: "Ready for public publishing." };
    if (score >= 55) return { score, text: "Usable. Review AI setup for better accuracy." };
    return { score, text: "Complete AI setup, then start a live source." };
  }

  async function saveStatus(force = false) {
    const status = state.latestStatus || buildStatus();
    const now = Date.now();
    if (!force && now - state.lastSaveAt < 3000) return;
    state.lastSaveAt = now;
    if (status.dataMode === "camera-only" || status.dataMode === "combined-fusion") {
      await storage.saveCameraReading?.(partner.id, {
        aiPeopleCount: status.aiPeopleCount,
        rawAICount: status.rawAICount,
        confidence: status.cameraConfidence,
        queueDensity: status.queueDensity,
        cameraMovement: status.cameraMovement,
        lineFormation: status.lineFormation,
        payload: status
      });
    }
    const savedStatus = await storage.saveQueueStatus(status);
    if (savedStatus?.historyStats) {
      state.latestStatus = savedStatus;
      updateUi(savedStatus);
    }
    setText("publicStatusText", status.isPublic ? "Published" : "Private");
  }

  function updateAll() {
    const status = buildStatus();
    updateUi(status);
    saveStatus(false).catch(error => log(`Save failed: ${error.message}`));
  }

  function loadSettingsToForm() {
    setValue("activeCountersInput", state.settings.activeCounters);
    setValue("dailyLearningSampleCountInput", state.settings.dailyLearningSampleCount);
    setValue("noWaitQueueLimitInput", state.settings.noWaitQueueLimit);
    setValue("mediumCrowdLimitInput", state.settings.mediumCrowdLimit);
    setValue("queueCapacityInput", state.settings.maxQueueCapacity);
    setChecked("isPublicToggle", state.settings.isPublic);
    setChecked("isOpenToggle", state.settings.isOpen);
    setChecked("scheduleEnabledToggle", state.settings.scheduleEnabled);
    setValue("openingTimeInput", state.settings.openingTime);
    setValue("closingTimeInput", state.settings.closingTime);
    setValue("confidenceInput", state.confidenceThreshold);
    setValue("sourceModeSelect", state.settings.sourceMode);
  }

  async function applySettings() {
    state.settings.sourceMode = $("sourceModeSelect")?.value || "auto";
    state.settings.activeCounters = Math.max(1, Number($("activeCountersInput")?.value || 1));
    state.settings.dailyLearningSampleCount = Math.max(7, Math.min(8, Number($("dailyLearningSampleCountInput")?.value || 8)));
    state.settings.noWaitQueueLimit = Math.max(1, Number($("noWaitQueueLimitInput")?.value || 8));
    state.settings.lowCrowdLimit = state.settings.noWaitQueueLimit;
    state.settings.mediumCrowdLimit = Math.max(state.settings.noWaitQueueLimit + 1, Number($("mediumCrowdLimitInput")?.value || 15));
    state.settings.maxQueueCapacity = Math.max(5, Number($("queueCapacityInput")?.value || 30));
    state.settings.isPublic = Boolean($("isPublicToggle")?.checked);
    state.settings.isOpen = Boolean($("isOpenToggle")?.checked);
    state.settings.scheduleEnabled = Boolean($("scheduleEnabledToggle")?.checked);
    state.settings.openingTime = $("openingTimeInput")?.value || "08:30";
    state.settings.closingTime = $("closingTimeInput")?.value || "16:30";
    state.confidenceThreshold = clamp(Number($("confidenceInput")?.value || state.confidenceThreshold), 0.2, 0.95);
    await storage.saveSurvey(partner.id, { ...survey, ...state.settings, confidenceThreshold: state.confidenceThreshold });
    storage.toast("Prediction settings applied.");
    log("Prediction settings applied.");
    updateAll();
  }

  function copyStatus() {
    const status = state.latestStatus || buildStatus();
    navigator.clipboard?.writeText(JSON.stringify(status, null, 2));
    storage.toast("Queue JSON copied.");
  }

  function bindEvents() {
    $("startCameraButton")?.addEventListener("click", startCamera);
    $("stopCameraButton")?.addEventListener("click", () => stopCamera(true));
    $("connectEsp32Button")?.addEventListener("click", connectEsp32);
    $("disconnectEsp32Button")?.addEventListener("click", disconnectEsp32);
    $("resetSensorButton")?.addEventListener("click", resetEsp32);
    const safeApplySettings = () => applySettings().catch(error => {
      storage.toast(error.message || "Settings could not be saved.");
      log(`Settings save failed: ${error.message}`);
    });
    $("applyPredictionButton")?.addEventListener("click", safeApplySettings);
    $("sourceModeSelect")?.addEventListener("change", safeApplySettings);
    $("isOpenToggle")?.addEventListener("change", safeApplySettings);
    $("isPublicToggle")?.addEventListener("change", safeApplySettings);
    $("scheduleEnabledToggle")?.addEventListener("change", safeApplySettings);
    $("openingTimeInput")?.addEventListener("change", safeApplySettings);
    $("closingTimeInput")?.addEventListener("change", safeApplySettings);
    $("addServiceTimeButton")?.addEventListener("click", async () => {
      try {
        const value = Number($("serviceTimeInput")?.value);
        serviceRecords = await storage.addServiceRecord(partner.id, value, "manual");
        $("serviceTimeInput").value = "";
        storage.toast("Service sample added.");
        updateAll();
      } catch (error) {
        storage.toast(error.message);
      }
    });
    $("clearServiceTimesButton")?.addEventListener("click", async () => {
      serviceRecords = await storage.clearServiceRecords(partner.id);
      storage.toast("Service samples cleared.");
      updateAll();
    });
    $("copyStatusButton")?.addEventListener("click", copyStatus);
    $("forceSaveButton")?.addEventListener("click", () => saveStatus(true).then(() => storage.toast("Queue status saved for public finder.")).catch(error => { storage.toast(error.message || "Queue status could not be saved."); log(`Manual save failed: ${error.message}`); }));
    $("clearLogButton")?.addEventListener("click", () => { const el = $("terminalLog"); if (el) el.textContent = "[system] Log cleared."; });
    $("logoutBtn")?.addEventListener("click", async () => { await storage.logout(); window.location.href = "service-partner.html"; });
    $("cameraSelect")?.addEventListener("change", () => { if (state.cameraRunning) startCamera().catch(error => log(`Camera switch failed: ${error.message}`)); });
  }

  loadSettingsToForm();
  bindEvents();
  updateAll();
  enumerateCameras();
  log(`Loaded Service Control Hub for ${partner.organizationName}.`);
  if (storage.client && state.settings.sourceMode !== "camera") {
    connectEsp32();
  }
})().catch(error => {
  console.error("Service Control Hub failed to initialize", error);
  const terminal = document.getElementById("terminalLog");
  if (terminal) terminal.textContent = `[system] Service Control Hub failed to initialize: ${error.message || error}`;
  const region = document.getElementById("toastRegion");
  if (region) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = error.message || "Service Control Hub failed to initialize.";
    region.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
});
