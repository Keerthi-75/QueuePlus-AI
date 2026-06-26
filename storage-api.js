(function () {
  const config = window.AIOT_CONFIG || {};
  const keys = config.localKeys || {};

  let client = null;
  let cachedPartner = null;
  let cachedPartners = [];
  let cachedSurvey = null;
  let cachedServiceRecords = [];
  let initialized = false;

  function uid(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn("Failed to read localStorage", key, error);
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function toast(message) {
    const region = document.getElementById("toastRegion");
    if (!region) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = String(message || "Operation finished.");
    region.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  function cleanSupabaseUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return "";
    return value
      .replace(/\/rest\/v1\/?$/i, "")
      .replace(/\/auth\/v1\/?$/i, "")
      .replace(/\/functions\/v1\/?$/i, "")
      .replace(/\/+$/, "");
  }

  function formatError(error, fallback = "Operation failed.") {
    if (!error) return fallback;
    if (typeof error === "string") return error;
    const direct = error.message || error.error_description || error.description || error.details || error.hint || error.code;
    if (direct) return String(direct);
    if (error.cause?.message) return String(error.cause.message);
    try {
      const text = JSON.stringify(error);
      if (text && text !== "{}") return text;
    } catch (_) {
      // Ignore stringify failures.
    }
    return fallback;
  }

  function canUseSupabase() {
    return (
      config.storageMode === "supabase" &&
      Boolean(cleanSupabaseUrl(config.supabaseUrl)) &&
      Boolean(config.supabaseAnonKey) &&
      Boolean(window.supabase)
    );
  }

  function seedDemoData() {
    const partners = readJson(keys.partners, []);
    const existing = partners.find(p => normalizeEmail(p.email) === config.demoAccount.email);
    if (existing) return existing;

    const demoPartner = {
      id: "demo_partner_001",
      organizationName: "Jaffna Municipal Service Counter",
      organizationType: "Government Office",
      serviceLocation: "Main Branch, Jaffna",
      contactPerson: "Demo Officer",
      contactNumber: "+94 00 000 0000",
      email: config.demoAccount.email,
      password: config.demoAccount.password,
      publicListing: true,
      approvalStatus: "approved",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    partners.push(demoPartner);
    writeJson(keys.partners, partners);

    const surveys = readJson(keys.surveys, {});
    surveys[demoPartner.id] = {
      ...config.defaultSurvey,
      entranceCount: 1,
      exitCount: 1,
      hasWifi: true,
      hasPowerSupply: true,
      hasGoodLighting: true,
      cameraPosition: "Webcam facing the waiting line from the counter side.",
      esp32PinPlan: "IR entry sensor + IR exit sensor + ultrasonic distance sensor connected to ESP32.",
      deploymentNotes: "Demo location ready for browser AI and ESP32 bridge.",
      partnerId: demoPartner.id,
      updatedAt: nowIso()
    };
    writeJson(keys.surveys, surveys);

    const statuses = readJson(keys.queueStatuses, []);
    if (!statuses.some(item => item.partnerId === demoPartner.id)) {
      statuses.push({
        id: uid("status"),
        partnerId: demoPartner.id,
        organizationName: demoPartner.organizationName,
        organizationType: demoPartner.organizationType,
        serviceLocation: demoPartner.serviceLocation,
        isPublic: true,
        isOpen: true,
        dataMode: "demo",
        queueLength: 3,
        aiPeopleCount: 3,
        sensorPeopleCount: 0,
        finalPeopleCount: 3,
        crowdLevel: "Low",
        estimatedWaitTime: 6,
        averageServiceTime: 4,
        observedServiceInterval: null,
        activeCounters: 2,
        confidence: "Medium",
        queueTrend: "Stable",
        occupancyPercent: 10,
        queueDensity: "Low",
        cameraMovement: "Normal",
        arrivalRatePerHour: 0,
        serviceRatePerHour: 0,
        entryCount: 0,
        exitCount: 0,
        distanceCm: null,
        deviceHealth: "Demo data",
        bestVisitAdvice: "Good time to visit",
        recommendation: "Crowd is low. Estimated wait is about 6 minutes.",
        status: "Open",
        sourceQuality: "Demo source",
        lastUpdated: nowIso(),
        updatedAt: nowIso()
      });
      writeJson(keys.queueStatuses, statuses);
    }
    return demoPartner;
  }

  function partnerFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      organizationName: row.organization_name,
      organizationType: row.organization_type,
      serviceLocation: row.service_location,
      contactPerson: row.contact_person,
      contactNumber: row.contact_number,
      email: row.email,
      publicListing: row.public_listing,
      approvalStatus: row.approval_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function partnerToRow(partner, ownerId) {
    return {
      owner_id: ownerId,
      organization_name: partner.organizationName,
      organization_type: partner.organizationType,
      service_location: partner.serviceLocation,
      contact_person: partner.contactPerson,
      contact_number: partner.contactNumber,
      email: partner.email,
      public_listing: partner.publicListing,
      updated_at: nowIso()
    };
  }

  function statusToRow(status) {
    const payload = { ...status };
    return {
      partner_id: status.partnerId,
      organization_name: status.organizationName,
      organization_type: status.organizationType,
      service_location: status.serviceLocation,
      is_public: status.isPublic !== false,
      is_open: status.isOpen !== false,
      status_text: status.status || "Open",
      crowd_level: status.crowdLevel || "Low",
      estimated_wait_time: Number(status.estimatedWaitTime || 0),
      final_people_count: Number(status.finalPeopleCount ?? status.queueLength ?? 0),
      confidence: status.confidence || "Low",
      data_mode: status.dataMode || "unknown",
      payload,
      updated_at: status.updatedAt || nowIso()
    };
  }

  function statusFromRow(row) {
    if (!row) return null;
    const payload = row.payload || {};
    return {
      ...payload,
      partnerId: row.partner_id,
      organizationName: row.organization_name || payload.organizationName,
      organizationType: row.organization_type || payload.organizationType,
      serviceLocation: row.service_location || payload.serviceLocation,
      isPublic: row.is_public,
      isOpen: row.is_open,
      status: row.status_text || payload.status,
      crowdLevel: row.crowd_level || payload.crowdLevel,
      estimatedWaitTime: row.estimated_wait_time ?? payload.estimatedWaitTime,
      finalPeopleCount: row.final_people_count ?? payload.finalPeopleCount,
      confidence: row.confidence || payload.confidence,
      dataMode: row.data_mode || payload.dataMode,
      updatedAt: row.updated_at || payload.updatedAt,
      lastUpdated: payload.lastUpdated || row.updated_at
    };
  }

  function historyFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      partnerId: row.partner_id,
      estimatedWaitTime: Number(row.estimated_wait_time || 0),
      finalPeopleCount: Number(row.final_people_count || 0),
      crowdLevel: row.crowd_level || "Low",
      confidence: row.confidence || "Low",
      status: row.status_text || "Open",
      payload: row.payload || {},
      createdAt: row.created_at
    };
  }

  function hourLabel(hour) {
    if (hour === null || hour === undefined || hour === "") return "--";
    const h = Number(hour);
    if (!Number.isFinite(h)) return "--";
    const suffix = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 || 12;
    return `${hour12}:00 ${suffix}`;
  }

  function deriveHistoryStats(history = []) {
    const rows = history.filter(item => item && Number.isFinite(Number(item.estimatedWaitTime)));
    if (!rows.length) {
      return { samples: 0, todayAverageWait: 0, peakHour: null, bestHour: null, peakHourText: "--", bestHourText: "--", learnedBestVisitAdvice: null };
    }
    const todayKey = new Date().toDateString();
    const today = rows.filter(item => new Date(item.createdAt || item.updatedAt || Date.now()).toDateString() === todayKey);
    const basis = today.length ? today : rows;
    const averageWait = Math.round(basis.reduce((sum, item) => sum + Number(item.estimatedWaitTime || 0), 0) / basis.length);
    const buckets = new Map();
    rows.forEach(item => {
      const d = new Date(item.createdAt || item.updatedAt || Date.now());
      const hour = d.getHours();
      const bucket = buckets.get(hour) || { totalWait: 0, totalCount: 0, samples: 0 };
      bucket.totalWait += Number(item.estimatedWaitTime || 0);
      bucket.totalCount += Number(item.finalPeopleCount || 0);
      bucket.samples += 1;
      buckets.set(hour, bucket);
    });
    let peakHour = null;
    let bestHour = null;
    let peakScore = -1;
    let bestScore = Infinity;
    buckets.forEach((bucket, hour) => {
      const avgWait = bucket.totalWait / Math.max(1, bucket.samples);
      const score = avgWait + bucket.totalCount / Math.max(1, bucket.samples);
      if (score > peakScore) { peakScore = score; peakHour = hour; }
      if (score < bestScore) { bestScore = score; bestHour = hour; }
    });
    const learnedBestVisitAdvice = bestHour !== null ? `Historically lighter around ${hourLabel(bestHour)}` : null;
    return {
      samples: rows.length,
      todayAverageWait: averageWait,
      peakHour,
      bestHour,
      peakHourText: hourLabel(peakHour),
      bestHourText: hourLabel(bestHour),
      learnedBestVisitAdvice
    };
  }

  async function createSupabaseClient() {
    if (!canUseSupabase()) return null;
    const supabaseUrl = cleanSupabaseUrl(config.supabaseUrl);
    config.supabaseUrl = supabaseUrl;
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) {
      toast("Supabase URL must be the base project URL, for example https://project-ref.supabase.co. Do not include /rest/v1/.");
      return null;
    }
    return window.supabase.createClient(supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  async function loadSupabaseSessionData() {
    cachedPartner = null;
    cachedPartners = [];
    cachedSurvey = null;
    cachedServiceRecords = [];
    if (!client) return;

    const { data: userData } = await client.auth.getUser();
    const user = userData?.user;
    if (!user) return;

    const { data: partnerRows, error: partnerError } = await client
      .from("service_partners")
      .select("*")
      .eq("owner_id", user.id)
      .order("updated_at", { ascending: false });

    if (partnerError) throw partnerError;

    if (!partnerRows || !partnerRows.length) {
      const meta = user.user_metadata || {};
      const fallbackPartner = {
        organizationName: meta.organization_name || "New Service Location",
        organizationType: meta.organization_type || "Service Counter",
        serviceLocation: meta.service_location || "Location not set",
        contactPerson: meta.contact_person || "",
        contactNumber: meta.contact_number || "",
        email: normalizeEmail(user.email),
        publicListing: true
      };
      const { data: inserted, error } = await client
        .from("service_partners")
        .insert(partnerToRow(fallbackPartner, user.id))
        .select("*")
        .single();
      if (error) throw error;
      cachedPartners = [partnerFromRow(inserted)];
    } else {
      cachedPartners = partnerRows.map(partnerFromRow).filter(Boolean);
    }

    const activeId = localStorage.getItem(keys.activeLocation || "aiot_active_location_public_v1");
    cachedPartner = cachedPartners.find(item => item.id === activeId) || cachedPartners[0] || null;
    if (cachedPartner) localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", cachedPartner.id);

    if (cachedPartner) {
      let configPayload = null;
      try {
        const { data: configRow, error: configError } = await client
          .from("location_configs")
          .select("payload")
          .eq("partner_id", cachedPartner.id)
          .maybeSingle();
        if (configError) throw configError;
        configPayload = configRow?.payload || null;
      } catch (error) {
        console.warn("location_configs not available, falling back to service_location_surveys", error);
      }

      if (!configPayload) {
        const { data: surveyRow } = await client
          .from("service_location_surveys")
          .select("payload")
          .eq("partner_id", cachedPartner.id)
          .maybeSingle();
        configPayload = surveyRow?.payload || null;
      }
      cachedSurvey = { ...config.defaultSurvey, ...(configPayload || {}) };

      const { data: recordRows } = await client
        .from("service_records")
        .select("value, source, created_at")
        .eq("partner_id", cachedPartner.id)
        .order("created_at", { ascending: true });
      cachedServiceRecords = (recordRows || []).map(row => ({
        value: Number(row.value),
        source: row.source,
        createdAt: row.created_at
      }));
    }
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(String(text));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function generateDeviceToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return `aiot_${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  }

  const api = {
    uid,
    nowIso,
    toast,
    cleanSupabaseUrl,
    formatError,
    async init() {
      if (initialized) return client;
      client = await createSupabaseClient();
      this.client = client;
      if (client) {
        try {
          await loadSupabaseSessionData();
        } catch (error) {
          console.warn("Supabase session load failed", error);
          toast(formatError(error, "Supabase session load failed."));
        }
      } else {
        seedDemoData();
      }
      initialized = true;
      return client;
    },
    getMode() {
      if (client) return "Supabase Public";
      if (config.storageMode === "supabase") return "Local fallback: add Supabase config";
      return "Local Demo";
    },
    async refresh() {
      if (client) await loadSupabaseSessionData();
    },
    async registerPartner(data) {
      const partner = {
        organizationName: data.organizationName.trim(),
        organizationType: data.organizationType.trim(),
        serviceLocation: data.serviceLocation.trim(),
        contactPerson: data.contactPerson.trim(),
        contactNumber: data.contactNumber.trim(),
        email: normalizeEmail(data.email),
        password: data.password,
        publicListing: Boolean(data.publicListing),
        approvalStatus: "approved",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      if (client) {
        const { data: authData, error: authError } = await client.auth.signUp({
          email: partner.email,
          password: partner.password,
          options: {
            data: {
              organization_name: partner.organizationName,
              organization_type: partner.organizationType,
              service_location: partner.serviceLocation,
              contact_person: partner.contactPerson,
              contact_number: partner.contactNumber,
              public_listing: partner.publicListing
            }
          }
        });
        if (authError) throw authError;

        const user = authData?.user;
        if (!authData?.session) {
          return {
            ...partner,
            id: user?.id || uid("pending_partner"),
            pendingEmailConfirmation: true
          };
        }

        const row = partnerToRow(partner, user.id);
        const { data: existingRows, error: findError } = await client
          .from("service_partners")
          .select("*")
          .eq("owner_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1);
        if (findError) throw findError;
        let inserted = existingRows?.[0] || null;
        if (inserted) {
          const { data: updated, error: updateError } = await client
            .from("service_partners")
            .update(row)
            .eq("id", inserted.id)
            .select("*")
            .single();
          if (updateError) throw updateError;
          inserted = updated;
        } else {
          const { data: created, error: insertError } = await client
            .from("service_partners")
            .insert(row)
            .select("*")
            .single();
          if (insertError) throw insertError;
          inserted = created;
        }
        cachedPartner = partnerFromRow(inserted);
        cachedPartners = [cachedPartner];
        localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", cachedPartner.id);
        cachedSurvey = { ...config.defaultSurvey };
        cachedServiceRecords = [];
        return cachedPartner;
      }

      const partners = readJson(keys.partners, []);
      if (partners.some(p => normalizeEmail(p.email) === partner.email)) {
        throw new Error("This email is already registered in demo storage.");
      }
      const localPartner = { ...partner, id: uid("partner") };
      partners.push(localPartner);
      writeJson(keys.partners, partners);
      writeJson(keys.session, localPartner.id);
      localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", localPartner.id);
      return localPartner;
    },
    async login(email, password) {
      const normalized = normalizeEmail(email);
      if (client) {
        const { error } = await client.auth.signInWithPassword({ email: normalized, password });
        if (error) throw error;
        await loadSupabaseSessionData();
        if (!cachedPartner) throw new Error("Login succeeded but no Service Partner profile exists yet.");
        return cachedPartner;
      }

      const partners = readJson(keys.partners, []);
      const partner = partners.find(p => normalizeEmail(p.email) === normalized && String(p.password) === String(password));
      if (!partner) throw new Error("Login failed. Use your registered email/password or the demo account.");
      writeJson(keys.session, partner.id);
      localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", partner.id);
      return partner;
    },
    async logout() {
      if (client) await client.auth.signOut();
      cachedPartner = null;
      cachedPartners = [];
      cachedSurvey = null;
      cachedServiceRecords = [];
      localStorage.removeItem(keys.session);
      localStorage.removeItem(keys.activeLocation || "aiot_active_location_public_v1");
    },
    getCurrentPartner() {
      if (client) return cachedPartner;
      const partnerId = localStorage.getItem(keys.activeLocation || "aiot_active_location_public_v1") || readJson(keys.session, null);
      if (!partnerId) return null;
      return readJson(keys.partners, []).find(p => p.id === partnerId) || null;
    },
    getPartnerById(partnerId) {
      if (cachedPartner?.id === partnerId) return cachedPartner;
      if (client) return cachedPartners.find(p => p.id === partnerId) || null;
      return readJson(keys.partners, []).find(p => p.id === partnerId) || null;
    },
    async setActivePartner(partnerId) {
      if (!partnerId) return null;
      localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", partnerId);
      if (client) {
        cachedPartner = cachedPartners.find(p => p.id === partnerId) || cachedPartner;
        await loadSupabaseSessionData();
        return cachedPartner;
      }
      writeJson(keys.session, partnerId);
      return this.getCurrentPartner();
    },
    async listPartners() {
      if (client) {
        if (!cachedPartners.length) await loadSupabaseSessionData();
        return cachedPartners.slice();
      }
      return readJson(keys.partners, []);
    },
    async createLocation(form = {}) {
      const current = this.getCurrentPartner();
      const partner = {
        id: uid("partner"),
        organizationName: form.organizationName || "New Service Location",
        organizationType: form.organizationType || "Service Counter",
        serviceLocation: form.serviceLocation || "Location not set",
        contactPerson: form.contactPerson || current?.contactPerson || "",
        contactNumber: form.contactNumber || "",
        email: form.email || current?.email || "",
        password: current?.password || config.demoAccount.password,
        publicListing: form.publicListing !== false,
        approvalStatus: "approved",
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      if (client) {
        const { data: userData } = await client.auth.getUser();
        const user = userData?.user;
        if (!user) throw new Error("Login required before creating another location.");
        const { data, error } = await client.from("service_partners").insert(partnerToRow(partner, user.id)).select("*").single();
        if (error) throw error;
        const created = partnerFromRow(data);
        cachedPartners.unshift(created);
        cachedPartner = created;
        localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", created.id);
        await this.saveSurvey(created.id, { ...config.defaultSurvey, isPublic: created.publicListing });
        return created;
      }
      const partners = readJson(keys.partners, []);
      partners.push(partner);
      writeJson(keys.partners, partners);
      writeJson(keys.session, partner.id);
      localStorage.setItem(keys.activeLocation || "aiot_active_location_public_v1", partner.id);
      const surveys = readJson(keys.surveys, {});
      surveys[partner.id] = { ...config.defaultSurvey, partnerId: partner.id, updatedAt: nowIso() };
      writeJson(keys.surveys, surveys);
      return partner;
    },
    async saveSurvey(partnerId, survey) {
      const cleaned = {
        ...config.defaultSurvey,
        ...survey,
        partnerId,
        updatedAt: nowIso()
      };
      cachedSurvey = cleaned;

      if (client) {
        const configRow = {
          partner_id: partnerId,
          active_counters: cleaned.activeCounters,
          default_service_time: cleaned.defaultServiceTime,
          low_crowd_limit: cleaned.lowCrowdLimit,
          medium_crowd_limit: cleaned.mediumCrowdLimit,
          max_queue_capacity: cleaned.maxQueueCapacity,
          analysis_mode: cleaned.sourceMode || cleaned.analysisMode || "auto",
          camera_enabled: cleaned.usesWebcamAi !== false,
          esp32_enabled: cleaned.usesEsp32 !== false,
          ultrasonic_enabled: cleaned.usesUltrasonic !== false,
          ir_entry_enabled: cleaned.irEntryEnabled !== false,
          ir_exit_enabled: cleaned.irExitEnabled !== false,
          is_public: cleaned.isPublic !== false,
          is_open: cleaned.isOpen !== false,
          schedule_enabled: cleaned.scheduleEnabled !== false,
          opening_time: cleaned.openingTime || "08:30",
          closing_time: cleaned.closingTime || "16:30",
          closed_days: cleaned.closedDays || [],
          timezone: cleaned.timezone || "Asia/Colombo",
          payload: cleaned,
          updated_at: cleaned.updatedAt
        };

        const { error: surveyError } = await client.from("service_location_surveys").upsert({
          partner_id: partnerId,
          payload: cleaned,
          updated_at: cleaned.updatedAt
        }, { onConflict: "partner_id" });
        if (surveyError) throw surveyError;

        const { error: configError } = await client.from("location_configs").upsert(configRow, { onConflict: "partner_id" });
        if (configError) throw configError;

        const { error: partnerUpdateError } = await client.from("service_partners").update({
          setup_completed: true,
          public_listing: cleaned.isPublic !== false,
          updated_at: cleaned.updatedAt
        }).eq("id", partnerId);
        if (partnerUpdateError) throw partnerUpdateError;
        if (cachedPartner && cachedPartner.id === partnerId) cachedPartner.publicListing = cleaned.isPublic !== false;
        return cleaned;
      }

      const surveys = readJson(keys.surveys, {});
      surveys[partnerId] = cleaned;
      writeJson(keys.surveys, surveys);
      return cleaned;
    },
    getSurvey(partnerId) {
      if (client) return { ...config.defaultSurvey, ...(cachedSurvey || {}) };
      const surveys = readJson(keys.surveys, {});
      return { ...config.defaultSurvey, ...(surveys[partnerId] || {}) };
    },
    getServiceRecords(partnerId) {
      if (client) return cachedServiceRecords.slice();
      const all = readJson(keys.serviceRecords, {});
      return all[partnerId] || [];
    },
    async addServiceRecord(partnerId, minutes, source = "manual") {
      const value = Number(minutes);
      if (!Number.isFinite(value) || value < 1 || value > 30) {
        throw new Error("Service time must be between 1 and 30 minutes.");
      }
      const record = { value, source, createdAt: nowIso() };
      cachedServiceRecords.push(record);

      if (client) {
        const { error } = await client.from("service_records").insert({
          partner_id: partnerId,
          value,
          source,
          created_at: record.createdAt
        });
        if (error) throw error;
        return cachedServiceRecords.slice();
      }

      const all = readJson(keys.serviceRecords, {});
      all[partnerId] = all[partnerId] || [];
      all[partnerId].push(record);
      writeJson(keys.serviceRecords, all);
      return all[partnerId];
    },
    async clearServiceRecords(partnerId) {
      cachedServiceRecords = [];
      if (client) {
        const { error } = await client.from("service_records").delete().eq("partner_id", partnerId);
        if (error) throw error;
        return [];
      }
      const all = readJson(keys.serviceRecords, {});
      all[partnerId] = [];
      writeJson(keys.serviceRecords, all);
      return [];
    },

    async saveCameraReading(partnerId, reading) {
      const payload = { ...reading, partnerId, createdAt: nowIso() };
      if (client) {
        const { error } = await client.from("camera_readings").insert({
          partner_id: partnerId,
          ai_people_count: Math.max(0, Math.round(Number(reading.aiPeopleCount || 0))),
          raw_ai_count: Math.max(0, Math.round(Number(reading.rawAICount || 0))),
          confidence: reading.confidence || "Low",
          queue_density: reading.queueDensity || null,
          movement_level: reading.cameraMovement || null,
          line_formation: reading.lineFormation || null,
          payload,
          created_at: payload.createdAt
        });
        if (error) throw error;
      }
      return payload;
    },
    async saveServiceTimeEvent(partnerId, event) {
      const payload = { ...event, partnerId, createdAt: nowIso() };
      if (client) {
        const { error } = await client.from("service_time_events").insert({
          partner_id: partnerId,
          source: event.source || "camera",
          event_type: event.eventType || event.event_type || "service_completed",
          interval_minutes: event.intervalMinutes ?? null,
          queue_count_before: event.queueCountBefore ?? null,
          queue_count_after: event.queueCountAfter ?? null,
          payload,
          created_at: payload.createdAt
        });
        if (error) throw error;
      }
      return payload;
    },
    async listQueueHistory(partnerId, limit = 120) {
      if (client) {
        const { data, error } = await client
          .from("queue_status_history")
          .select("*")
          .eq("partner_id", partnerId)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) {
          console.warn("queue_status_history unavailable", error);
          return [];
        }
        return (data || []).map(historyFromRow).filter(Boolean).reverse();
      }
      const all = readJson(keys.queueHistory || "aiot_queue_history_public_v1", {});
      return (all[partnerId] || []).slice(-limit);
    },
    async saveQueueHistorySnapshot(status) {
      const snapshot = {
        id: uid("history"),
        partnerId: status.partnerId,
        estimatedWaitTime: Number(status.estimatedWaitTime || 0),
        finalPeopleCount: Number(status.finalPeopleCount ?? status.queueLength ?? 0),
        crowdLevel: status.crowdLevel || "Low",
        confidence: status.confidence || "Low",
        status: status.status || "Open",
        payload: { ...status },
        createdAt: nowIso()
      };
      if (client) {
        const { error } = await client.from("queue_status_history").insert({
          partner_id: snapshot.partnerId,
          estimated_wait_time: snapshot.estimatedWaitTime,
          final_people_count: snapshot.finalPeopleCount,
          crowd_level: snapshot.crowdLevel,
          confidence: snapshot.confidence,
          status_text: snapshot.status,
          payload: snapshot.payload,
          created_at: snapshot.createdAt
        });
        if (error) console.warn("History snapshot save failed", error);
        return snapshot;
      }
      const all = readJson(keys.queueHistory || "aiot_queue_history_public_v1", {});
      all[snapshot.partnerId] = all[snapshot.partnerId] || [];
      all[snapshot.partnerId].push(snapshot);
      all[snapshot.partnerId] = all[snapshot.partnerId].slice(-500);
      writeJson(keys.queueHistory || "aiot_queue_history_public_v1", all);
      return snapshot;
    },
    deriveHistoryStats,
    async saveQueueStatus(status) {
      const previousHistory = await this.listQueueHistory(status.partnerId, 160).catch(() => []);
      const historyStats = deriveHistoryStats(previousHistory);
      const current = {
        id: status.id || uid("status"),
        ...status,
        historyStats,
        bestVisitAdvice: status.bestVisitAdvice || historyStats.learnedBestVisitAdvice || "Waiting for live data",
        updatedAt: nowIso(),
        lastUpdated: status.lastUpdated || nowIso()
      };

      if (client) {
        const { error } = await client.from("queue_statuses").upsert(statusToRow(current), { onConflict: "partner_id" });
        if (error) throw error;
        await this.saveQueueHistorySnapshot(current);
        return current;
      }

      const statuses = readJson(keys.queueStatuses, []);
      const index = statuses.findIndex(item => item.partnerId === status.partnerId);
      if (index >= 0) statuses[index] = current;
      else statuses.push(current);
      writeJson(keys.queueStatuses, statuses);
      await this.saveQueueHistorySnapshot(current);
      return current;
    },
    async listPublicQueueStatuses() {
      if (client) {
        const { data, error } = await client
          .from("public_queue_statuses")
          .select("*")
          .order("updated_at", { ascending: false });
        if (error) throw error;
        return (data || []).map(statusFromRow).filter(Boolean);
      }
      return readJson(keys.queueStatuses, []).filter(item => item.isPublic !== false);
    },
    async getLatestDeviceReading(partnerId) {
      if (!partnerId) throw new Error("Missing active service location.");
      if (!client) return null;
      const { data, error } = await client
        .from("device_readings")
        .select("*, devices(device_id, device_name)")
        .eq("partner_id", partnerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const payload = data.payload || {};
      return {
        deviceId: data.devices?.device_id || payload.deviceId || data.device_id || "ESP32",
        deviceName: data.devices?.device_name || payload.deviceName || "ESP32 Queue Device",
        currentPeople: Number(data.current_people || 0),
        entryCount: Number(data.entry_count || 0),
        exitCount: Number(data.exit_count || 0),
        irEntryState: data.ir_entry_state || payload.irEntryState || "unknown",
        irExitState: data.ir_exit_state || payload.irExitState || "unknown",
        distanceCm: data.distance_cm === null || data.distance_cm === undefined ? null : Number(data.distance_cm),
        ultrasonicOccupied: Boolean(data.ultrasonic_occupied),
        wifiRssi: data.wifi_rssi,
        uptimeMs: data.uptime_ms,
        createdAt: data.created_at,
        receivedAt: payload.receivedAt || data.created_at,
        cloudSource: true,
        raw: data
      };
    },
    async getCurrentQueueStatus(partnerId) {
      if (!partnerId) throw new Error("Missing active service location.");
      if (client) {
        const { data, error } = await client
          .from("queue_statuses")
          .select("*")
          .eq("partner_id", partnerId)
          .maybeSingle();
        if (error) throw error;
        return data ? statusFromRow(data) : null;
      }
      return readJson(keys.queueStatuses, []).find(item => item.partnerId === partnerId) || null;
    },
    async listDevices(partnerId) {
      if (client) {
        const { data, error } = await client
          .from("devices")
          .select("id, device_name, device_type, device_id, is_active, last_seen_at, created_at")
          .eq("partner_id", partnerId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return data || [];
      }
      return readJson(keys.devices, []).filter(item => item.partnerId === partnerId);
    },
    async registerDevice(partnerId, form) {
      const token = generateDeviceToken();
      const tokenHash = await sha256(token);
      const device = {
        id: uid("device"),
        partnerId,
        deviceName: form.deviceName || "ESP32 Queue Device",
        deviceType: form.deviceType || "esp32-ir-ultrasonic",
        deviceId: form.deviceId || `esp32-${Date.now()}`,
        token,
        tokenHash,
        isActive: true,
        createdAt: nowIso()
      };

      if (client) {
        const { data, error } = await client.from("devices").insert({
          partner_id: partnerId,
          device_name: device.deviceName,
          device_type: device.deviceType,
          device_id: device.deviceId,
          token_hash: tokenHash,
          is_active: true
        }).select("id, device_name, device_type, device_id, is_active, created_at").single();
        if (error) throw error;
        return { ...data, token };
      }

      const devices = readJson(keys.devices, []);
      devices.push(device);
      writeJson(keys.devices, devices);
      return device;
    },
    getDeviceIngestUrl() {
      if (config.deviceIngestFunctionUrl) return config.deviceIngestFunctionUrl;
      if (config.supabaseUrl) return `${config.supabaseUrl.replace(/\/$/, "")}/functions/v1/device-ingest`;
      return "";
    },
    exportLocalData() {
      return {
        partners: readJson(keys.partners, []),
        surveys: readJson(keys.surveys, {}),
        queueStatuses: readJson(keys.queueStatuses, []),
        serviceRecords: readJson(keys.serviceRecords, {}),
        devices: readJson(keys.devices, [])
      };
    },
    downloadLocalData() {
      const blob = new Blob([JSON.stringify(this.exportLocalData(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aiot-demo-data-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  window.AIOTStorage = api;
})();
