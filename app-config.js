/*
  QueuePulse AI - public deployment configuration.

  Database setup order:
  1) Create a Supabase project.
  2) Run supabase_schema.sql in Supabase SQL Editor.
  3) Deploy supabase/functions/device-ingest with JWT verification disabled.
  4) Copy the Supabase project URL and anon/public key into this file.
  5) Register each ESP32 in Device Registration and generate a token-based sketch.

  Frontend safety:
  - supabaseUrl is safe in the browser.
  - supabaseAnonKey / publishable key is safe in the browser when RLS policies are enabled.
  - Never put the service_role key, database password, Wi-Fi password, or ESP32 device token in public source control.
*/
window.AIOT_CONFIG = {
  storageMode: "supabase", // "supabase" for public model, "local" for offline demo
  supabaseUrl: "https://ihjjbewxeefogwgecuiw.supabase.co", // Use ONLY the base URL. Do not include /rest/v1/.
  supabaseAnonKey: "sb_publishable_SOKpNGUloZ7I4hg2zlVoTg_qSZ-yomz", // Supabase anon/public key only. Never put service_role key here.
  deviceIngestFunctionUrl: "https://ihjjbewxeefogwgecuiw.supabase.co/functions/v1/device-ingest",
  appName: "QueuePulse AI",
  localKeys: {
    partners: "aiot_partners_public_v1",
    surveys: "aiot_surveys_public_v1",
    queueStatuses: "aiot_queue_statuses_public_v1",
    session: "aiot_current_partner_public_v1",
    serviceRecords: "aiot_service_records_public_v1",
    devices: "aiot_devices_public_v1",
    queueHistory: "aiot_queue_history_public_v1",
    activeLocation: "aiot_active_location_public_v1"
  },
  demoAccount: {
    email: "demo@queue.test",
    password: "demo1234"
  },
  defaultSurvey: {
    activeCounters: 2,
    defaultServiceTime: 4, // database compatibility only; wait time is learned from daily service samples
    dailyLearningSampleCount: 8,
    noWaitQueueLimit: 8,
    lowCrowdLimit: 8,
    mediumCrowdLimit: 15,
    maxQueueCapacity: 30,
    firstBenchmarkWeight: 30,
    recentAverageWeight: 70,
    queueLayout: "single-line",
    usesWebcamAi: true,
    usesEsp32: true,
    usesUltrasonic: false,
    isPublic: true,
    isOpen: true,
    confidenceThreshold: 0.55,
    sourceMode: "auto",
    scheduleEnabled: true,
    openingTime: "08:30",
    closingTime: "16:30",
    closedDays: ["Sunday"],
    timezone: "Asia/Colombo",
    bestVisitLookaheadHours: 4,
    aiQueueZone: { enabled: true, x1: 0.08, y1: 0.22, x2: 0.92, y2: 0.98 },
    aiReadinessScore: 0,
    aiSetupCompleted: false
  },
  cameraAnalytics: {
    detectionIntervalMs: 650,
    stableWindowSize: 9,
    minEventGapMs: 2500,
    defaultConfidenceThreshold: 0.58,
    maxServiceIntervalMinutes: 30,
    maxArrivalIntervalMinutes: 30,
    queueZoneEnabled: true,
    queueZone: { x1: 0.08, y1: 0.22, x2: 0.92, y2: 0.98 },
    minPersonAreaRatio: 0.006,
    maxPersonAreaRatio: 0.55,
    minPersonHeightRatio: 0.10,
    maxPersonHeightRatio: 0.96,
    minPersonAspectRatio: 0.16,
    maxPersonAspectRatio: 1.25,
    minConfirmedTrackFrames: 2,
    missedFrameGrace: 2,
    maxLostTrackFrames: 5,
    trackMatchDistance: 0.16,
    maxCountStepPerFrame: 2,
    stagnantGuardMinutes: 8,
    liveServiceMinSamples: 8,
    dailyLearningSampleCount: 8,
    noWaitQueueLimit: 8,
    liveServiceWeight: 0.60,
    surveyFallbackWeight: 0.40
  },
  esp32: {
    defaultEndpoint: "/api/queue-device",
    healthEndpoint: "/api/health",
    testCloudEndpoint: "/api/test-cloud",
    resetEndpoint: "/api/reset",
    pollIntervalMs: 2000,
    offlineAfterMs: 7000,
    cloudPushIntervalMs: 3000,
    recommendedPins: {
      irEntry: 27,
      irExit: 26,
      ultrasonicTrig: 25,
      ultrasonicEcho: 34
    }
  }
};
