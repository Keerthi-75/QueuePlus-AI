/*
  Advanced shared queue calculation engine.
  Internal-only upgrade: no new dashboard features are required.
  Purpose:
  - stabilize noisy camera counts
  - fuse camera + ESP32 more safely
  - reject one-off spikes and abnormal service intervals
  - adapt wait time during increasing/stagnant queues
  - keep using survey/location configuration as the source of truth
*/
(function () {
  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
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
    const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return null;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
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
    return {
      value: round(value, 2),
      samples: clean.length,
      stability: round(clamp(100 - (mad / Math.max(value, 0.1)) * 100, 20, 100))
    };
  }

  function normalizeConfig(config = {}) {
    const lowCrowdLimit = Math.max(1, Math.round(number(config.lowCrowdLimit ?? config.low_crowd_limit, 5)));
    const mediumCrowdLimit = Math.max(lowCrowdLimit + 1, Math.round(number(config.mediumCrowdLimit ?? config.medium_crowd_limit, 15)));
    return {
      activeCounters: Math.max(1, Math.round(number(config.activeCounters ?? config.active_counters, 2))),
      defaultServiceTime: clamp(number(config.defaultServiceTime ?? config.default_service_time, 4), 1, 30),
      dailyLearningSampleCount: Math.max(7, Math.min(8, Math.round(number(config.dailyLearningSampleCount ?? config.daily_learning_sample_count, 8)))),
      noWaitQueueLimit: Math.max(1, Math.round(number(config.noWaitQueueLimit ?? config.no_wait_queue_limit ?? lowCrowdLimit, 8))),
      lowCrowdLimit,
      mediumCrowdLimit,
      maxQueueCapacity: Math.max(5, Math.round(number(config.maxQueueCapacity ?? config.max_queue_capacity, 30))),
      firstBenchmarkWeight: clamp(number(config.firstBenchmarkWeight ?? config.first_benchmark_weight, 30), 0, 100),
      recentAverageWeight: clamp(number(config.recentAverageWeight ?? config.recent_average_weight, 70), 0, 100),
      sourceMode: String(config.sourceMode ?? config.analysis_mode ?? 'auto'),
      isPublic: config.isPublic ?? config.is_public ?? true,
      isOpen: config.isOpen ?? config.is_open ?? true,
      scheduleEnabled: config.scheduleEnabled ?? config.schedule_enabled ?? true,
      openingTime: config.openingTime ?? config.opening_time ?? '08:30',
      closingTime: config.closingTime ?? config.closing_time ?? '16:30',
      closedDays: Array.isArray(config.closedDays) ? config.closedDays : (Array.isArray(config.closed_days) ? config.closed_days : ['Sunday']),
      timezone: config.timezone || 'Asia/Colombo'
    };
  }

  function crowdLevel(count, cfg) {
    if (count <= cfg.lowCrowdLimit) return 'Low';
    if (count <= cfg.mediumCrowdLimit) return 'Medium';
    return 'High';
  }

  function qualityFromScore(score) {
    if (score >= 80) return 'High';
    if (score >= 55) return 'Medium';
    return 'Low';
  }

  function qualityValue(label) {
    if (label === 'High') return 85;
    if (label === 'Medium') return 62;
    return 35;
  }

  function stabilizeCameraCount({ rawCount = 0, recentCounts = [], previousStableCount = 0, densityRatio = 0, movementLabel = 'Normal' }) {
    const raw = Math.max(0, Math.round(number(rawCount, 0)));
    const recent = [...recentCounts, raw].slice(-9).map(v => Math.max(0, Math.round(number(v, 0))));
    const med = robustMedian(recent);
    let candidate = Math.round(med ?? raw);
    const repeats = recent.filter(v => v === raw).length;
    const anomalies = [];

    if (previousStableCount > 0 && Math.abs(candidate - previousStableCount) >= 3 && repeats < 2 && recent.length >= 4) {
      candidate = previousStableCount;
      anomalies.push('single-frame-spike');
    }

    const bigDrop = previousStableCount >= 4 && candidate <= Math.floor(previousStableCount * 0.5);
    if (bigDrop && (densityRatio >= 0.08 || movementLabel !== 'Calm')) {
      candidate = Math.max(0, previousStableCount - 1);
      anomalies.push('occlusion-drop-guard');
    }

    if (recent.length >= 5 && Math.max(...recent) - Math.min(...recent) >= 4) {
      anomalies.push('unstable-count-window');
    }

    return { stableCount: Math.max(0, candidate), recentCounts: recent, anomalies };
  }

  function chooseCount({
    cameraCount = 0,
    sensorCount = 0,
    cameraOnline = false,
    sensorOnline = false,
    sourceMode = 'auto',
    cameraQuality = 'Medium',
    sensorQuality = 'Medium',
    previousFinalCount = 0
  }) {
    const ai = Math.max(0, Math.round(number(cameraCount, 0)));
    const sensor = Math.max(0, Math.round(number(sensorCount, 0)));
    const mode = String(sourceMode || 'auto');
    const camScore = qualityValue(cameraQuality);
    const senScore = qualityValue(sensorQuality);

    function guard(candidate, selectedMode, agreementGood = false) {
      const previous = Math.max(0, Math.round(number(previousFinalCount, 0)));
      if (!previous || agreementGood || selectedMode === 'waiting') return Math.max(0, Math.round(candidate));
      const diff = candidate - previous;
      const maxStep = Math.max(2, Math.ceil(previous * 0.4));
      if (Math.abs(diff) <= maxStep) return Math.max(0, Math.round(candidate));
      return Math.max(0, Math.round(previous + Math.sign(diff) * maxStep));
    }

    if (mode === 'camera' || mode === 'camera_only') {
      return { finalPeopleCount: cameraOnline ? guard(ai, 'camera-only') : 0, dataMode: cameraOnline ? 'camera-only' : 'waiting', sourceConfidence: cameraOnline ? cameraQuality : 'Low' };
    }
    if (mode === 'esp32' || mode === 'esp32_only') {
      return { finalPeopleCount: sensorOnline ? guard(sensor, 'esp32-only') : 0, dataMode: sensorOnline ? 'esp32-only' : 'waiting', sourceConfidence: sensorOnline ? sensorQuality : 'Low' };
    }

    if (cameraOnline && sensorOnline) {
      const difference = Math.abs(ai - sensor);
      const ratio = difference / Math.max(1, Math.max(ai, sensor));
      const agreementGood = difference <= 2 || ratio <= 0.2;
      let finalPeopleCount;
      let sourceConfidence;
      if (agreementGood) {
        finalPeopleCount = Math.round((ai * camScore + sensor * senScore) / Math.max(1, camScore + senScore));
        sourceConfidence = camScore >= 70 && senScore >= 70 ? 'High' : 'Medium';
      } else if (camScore >= senScore + 20) {
        finalPeopleCount = ai;
        sourceConfidence = cameraQuality === 'High' ? 'Medium' : 'Low';
      } else if (senScore >= camScore + 20) {
        finalPeopleCount = sensor;
        sourceConfidence = sensorQuality === 'High' ? 'Medium' : 'Low';
      } else {
        finalPeopleCount = Math.max(ai, sensor);
        sourceConfidence = 'Low';
      }
      return { finalPeopleCount: guard(finalPeopleCount, 'combined-fusion', agreementGood), dataMode: 'combined-fusion', sourceConfidence, sourceDifference: difference };
    }
    if (cameraOnline) return { finalPeopleCount: guard(ai, 'camera-only'), dataMode: 'camera-only', sourceConfidence: cameraQuality };
    if (sensorOnline) return { finalPeopleCount: guard(sensor, 'esp32-only'), dataMode: 'esp32-only', sourceConfidence: sensorQuality };
    return { finalPeopleCount: 0, dataMode: 'waiting', sourceConfidence: 'Low' };
  }

  function sameLocalDay(value, now = new Date()) {
    const date = new Date(value || Date.now());
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  }

  function learnedDailyServiceTime(records = [], cfg) {
    const target = Math.max(7, Math.min(8, number(cfg.dailyLearningSampleCount, 8)));
    const values = records
      .filter(item => sameLocalDay(item.createdAt ?? item.created_at ?? Date.now()))
      .map(item => number(item.value ?? item, NaN))
      .filter(v => v >= 1 && v <= 30);
    if (values.length < target) return { averageServiceTime: null, confidence: 'Learning', samples: values.length, target, ready: false };
    const firstBatch = values.slice(0, target);
    const firstAvg = firstBatch.reduce((a, b) => a + b, 0) / firstBatch.length;
    if (values.length <= target) return { averageServiceTime: round(firstAvg, 2), confidence: 'Medium', samples: values.length, target, ready: true };
    const latest = values.slice(-Math.min(5, values.length));
    const latestAvg = latest.reduce((a, b) => a + b, 0) / latest.length;
    return { averageServiceTime: round(firstAvg * 0.6 + latestAvg * 0.4, 2), confidence: values.length >= target + 5 ? 'High' : 'Medium', samples: values.length, target, ready: true };
  }

  function waitTime({ finalPeopleCount, manualRecords = [], observedIntervals = [], arrivalIntervals = [], trend = 'Stable', config = {} }) {
    const cfg = normalizeConfig(config);
    const learned = learnedDailyServiceTime(manualRecords, cfg);
    const noWaitLimit = Math.max(1, cfg.noWaitQueueLimit);

    if (finalPeopleCount <= noWaitLimit) {
      return {
        estimatedWaitTime: 0,
        averageServiceTime: learned.ready ? learned.averageServiceTime : null,
        observedServiceInterval: null,
        waitBasis: `Queue is ${finalPeopleCount}/${noWaitLimit}. Visitor can visit now; wait-time prediction is not needed for low queue.`,
        waitConfidence: learned.ready ? learned.confidence : 'Medium',
        effectiveServiceInterval: 0,
        loadFactor: 1,
        learningSamples: learned.samples,
        learningTarget: learned.target,
        learningReady: learned.ready
      };
    }

    if (!learned.ready) {
      return {
        estimatedWaitTime: 0,
        averageServiceTime: null,
        observedServiceInterval: null,
        waitBasis: `Learning today's service speed: ${learned.samples}/${learned.target} served-visitor samples collected. Wait time starts after learning is complete.`,
        waitConfidence: 'Learning',
        effectiveServiceInterval: 0,
        loadFactor: 1,
        learningSamples: learned.samples,
        learningTarget: learned.target,
        learningReady: false
      };
    }

    const observed = robustInterval(observedIntervals);
    const learnedSystemInterval = learned.averageServiceTime / Math.max(1, cfg.activeCounters);
    let effectiveInterval = learnedSystemInterval;
    let waitConfidence = learned.confidence;
    let waitBasis = `Learned from today's first ${learned.target} served visitors ÷ active counters`;

    if (observed.value && observed.samples >= learned.target) {
      const observedWeight = observed.samples >= learned.target && observed.stability >= 70 ? 0.70 : 0.60;
      effectiveInterval = observed.value * observedWeight + learnedSystemInterval * (1 - observedWeight);
      waitConfidence = observed.samples >= learned.target && observed.stability >= 70 ? 'High' : 'Medium';
      waitBasis = `${Math.round(observedWeight * 100)}% live service speed + ${Math.round((1 - observedWeight) * 100)}% daily learned speed`;
    }

    const arrival = robustInterval(arrivalIntervals);
    const arrivalRate = arrival.value ? 60 / arrival.value : 0;
    const serviceRate = observed.value ? 60 / observed.value : 60 / Math.max(learnedSystemInterval, 0.1);
    let loadFactor = 1;
    if (trend === 'Increasing' && serviceRate > 0 && arrivalRate > serviceRate) {
      loadFactor += clamp((arrivalRate / serviceRate - 1) * 0.25, 0.05, 0.6);
      waitConfidence = waitConfidence === 'High' ? 'Medium' : waitConfidence;
    }

    return {
      estimatedWaitTime: Math.max(0, Math.round(finalPeopleCount * effectiveInterval * loadFactor)),
      averageServiceTime: learned.averageServiceTime,
      observedServiceInterval: observed.value,
      waitBasis,
      waitConfidence,
      effectiveServiceInterval: round(effectiveInterval, 2),
      loadFactor: round(loadFactor, 2),
      learningSamples: learned.samples,
      learningTarget: learned.target,
      learningReady: true
    };
  }

  function minutesFromTime(text) {
    const match = String(text || '').match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Math.max(0, Math.min(1439, Number(match[1]) * 60 + Number(match[2])));
  }

  function dayName(date) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()];
  }

  function scheduleStatus(config = {}, date = new Date()) {
    const cfg = normalizeConfig(config);

    // Manual open/closed is the strongest signal from Setup Survey / Control Hub.
    // If the Service Partner marks the location as open, the AI must still predict
    // waiting time even if the saved schedule says the current clock time is outside hours.
    if (cfg.isOpen === false) {
      return { isOpen: false, label: 'Closed manually', nextOpeningText: 'Turn on Location Open to publish wait time.' };
    }

    if (cfg.scheduleEnabled === false) {
      return { isOpen: true, label: 'Manual open', nextOpeningText: 'Schedule automation off' };
    }

    const closedDays = Array.isArray(cfg.closedDays) ? cfg.closedDays : [];
    const today = dayName(date);
    const openMins = minutesFromTime(cfg.openingTime);
    const closeMins = minutesFromTime(cfg.closingTime);
    const nowMins = date.getHours() * 60 + date.getMinutes();

    if (openMins === null || closeMins === null) {
      return { isOpen: true, label: 'Open now', nextOpeningText: 'Schedule incomplete. Manual open is active.' };
    }

    const within = openMins <= closeMins ? nowMins >= openMins && nowMins <= closeMins : nowMins >= openMins || nowMins <= closeMins;
    const minutesToClose = (closeMins - nowMins + 1440) % 1440;

    if (closedDays.includes(today)) {
      return { isOpen: true, label: 'Open override', nextOpeningText: `Schedule says closed on ${today}, but Location Open is active.` };
    }

    if (!within && nowMins < openMins) {
      return { isOpen: true, label: 'Open override', nextOpeningText: `Schedule opens at ${cfg.openingTime}, but Location Open is active.` };
    }

    if (!within) {
      return { isOpen: true, label: 'Open override', nextOpeningText: `Schedule closed after ${cfg.closingTime}, but Location Open is active.` };
    }

    if (minutesToClose <= 30) return { isOpen: true, label: 'Closing soon', nextOpeningText: `Closes at ${cfg.closingTime}` };
    return { isOpen: true, label: 'Open now', nextOpeningText: `Open until ${cfg.closingTime}` };
  }

  function buildAlerts(input = {}) {
    const alerts = [];
    if (input.isOpen === false) alerts.push('Location is closed');
    if (input.confidence === 'Low') alerts.push('Low confidence reading');
    if (input.crowdLevel === 'High') alerts.push('High crowd level');
    if (input.trend === 'Increasing' && Number(input.arrivalRatePerHour || 0) > Number(input.serviceRatePerHour || 0)) alerts.push('Queue increasing faster than service rate');
    if (input.sensorAlert && input.sensorAlert !== 'None') alerts.push(`Sensor alert: ${input.sensorAlert}`);
    if (input.sourceDifference && input.sourceDifference > 3) alerts.push('Camera and ESP32 counts disagree');
    if (input.dataMode === 'waiting') alerts.push('No live source available');
    return alerts.slice(0, 5);
  }

  function bestAdvice({ crowdLevel, wait, trend = 'Stable', isOpen = true, schedule = null, historyStats = null }) {
    if (!isOpen) return { status: 'Closed', advice: schedule?.nextOpeningText || 'Closed now', recommendation: `This service location is currently closed. ${schedule?.nextOpeningText || 'Check again later before visiting.'}` };
    if (schedule?.label === 'Closing soon') return { status: 'Closing Soon', advice: 'Visit only if urgent', recommendation: `This location is closing soon. Current wait is about ${wait} minutes.` };
    if (historyStats?.learnedBestVisitAdvice && crowdLevel !== 'Low') return { status: 'Busy', advice: historyStats.learnedBestVisitAdvice, recommendation: `Current queue is ${crowdLevel.toLowerCase()}. ${historyStats.learnedBestVisitAdvice} based on previous queue history.` };
    if (crowdLevel === 'Low' && wait <= 10) return { status: 'Open', advice: 'Good time to visit', recommendation: `Crowd is low. Estimated wait is about ${wait} minutes.` };
    if (crowdLevel === 'Medium' || wait <= 25) return { status: 'Busy', advice: trend === 'Increasing' ? 'Visit soon or delay' : 'Acceptable wait', recommendation: `Queue is ${crowdLevel.toLowerCase()} and trend is ${String(trend).toLowerCase()}. Estimated wait is ${wait} minutes.` };
    return { status: 'Very Busy', advice: 'Try later', recommendation: `Crowd is high. Estimated wait is ${wait} minutes. Visiting later is better unless urgent.` };
  }

  function calculate(input = {}) {
    const cfg = normalizeConfig(input.config || input.survey || {});
    const chosen = chooseCount({
      cameraCount: input.cameraCount,
      sensorCount: input.sensorCount,
      cameraOnline: Boolean(input.cameraOnline),
      sensorOnline: Boolean(input.sensorOnline),
      sourceMode: input.sourceMode || cfg.sourceMode,
      cameraQuality: input.cameraQuality || 'Medium',
      sensorQuality: input.sensorQuality || 'Medium',
      previousFinalCount: input.previousFinalCount || 0
    });
    const wait = waitTime({
      finalPeopleCount: chosen.finalPeopleCount,
      manualRecords: input.manualRecords || [],
      observedIntervals: input.observedIntervals || [],
      arrivalIntervals: input.arrivalIntervals || [],
      trend: input.trend || 'Stable',
      config: cfg
    });
    const level = crowdLevel(chosen.finalPeopleCount, cfg);
    const occupancyPercent = clamp(Math.round((chosen.finalPeopleCount / Math.max(1, cfg.maxQueueCapacity)) * 100), 0, 999);
    const queueDensity = occupancyPercent >= 70 ? 'High' : occupancyPercent >= 35 ? 'Medium' : 'Low';
    const schedule = scheduleStatus(cfg);
    const effectiveOpen = schedule.isOpen !== false;
    if (!effectiveOpen) {
      wait.estimatedWaitTime = 0;
      wait.waitBasis = 'Closed status: wait time is not useful while the service location is closed';
      wait.waitConfidence = 'High';
    }
    const advice = bestAdvice({ crowdLevel: level, wait: wait.estimatedWaitTime, trend: input.trend || 'Stable', isOpen: effectiveOpen, schedule, historyStats: input.historyStats || null });
    const confidenceScore = Math.min(
      chosen.sourceConfidence === 'High' ? 90 : chosen.sourceConfidence === 'Medium' ? 65 : 35,
      wait.waitConfidence === 'High' ? 90 : wait.waitConfidence === 'Medium' ? 65 : 35
    );
    return {
      ...chosen,
      ...wait,
      crowdLevel: level,
      occupancyPercent,
      queueDensity,
      confidence: qualityFromScore(confidenceScore),
      activeCounters: cfg.activeCounters,
      isOpen: effectiveOpen,
      isPublic: cfg.isPublic !== false,
      status: advice.status,
      bestVisitAdvice: advice.advice,
      recommendation: advice.recommendation,
      scheduleStatus: schedule.label,
      nextOpeningText: schedule.nextOpeningText,
      alerts: buildAlerts({ isOpen: effectiveOpen, confidence: qualityFromScore(confidenceScore), crowdLevel: level, trend: input.trend || 'Stable', arrivalRatePerHour: input.arrivalRatePerHour, serviceRatePerHour: input.serviceRatePerHour, sensorAlert: input.sensorAlert, sourceDifference: chosen.sourceDifference, dataMode: chosen.dataMode })
    };
  }

  window.AIOTQueueEngine = {
    normalizeConfig,
    calculate,
    waitTime,
    chooseCount,
    stabilizeCameraCount,
    crowdLevel,
    scheduleStatus,
    buildAlerts,
    median,
    robustMedian,
    robustInterval,
    round,
    clamp
  };
})();
