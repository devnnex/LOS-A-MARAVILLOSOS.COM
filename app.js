const SYNC_INTERVAL_MS = 5000;
const CHAT_SYNC_INTERVAL_MS = 1200;

const SUPABASE_CONFIG = {
  url: "https://zwguroyjngzrdbdwvzkg.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3Z3Vyb3lqbmd6cmRiZHd2emtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyODkyMTgsImV4cCI6MjA5ODg2NTIxOH0.JGzaXCojcgN_9aW_93v-Uj1Dw522yhbdX93tJNaE0kM"
};

try { SUPABASE_CONFIG.url = new URL(String(SUPABASE_CONFIG.url || "").trim()).origin; } catch (error) { /* La validación existente mostrará la configuración incompleta. */ }

const APPS_SCRIPT_CONFIG = {
  // Tambien puede configurarse desde Inventario > Respaldo remoto del negocio.
  webAppUrl: "https://script.google.com/macros/s/AKfycbwJiieFJ1OoR0TCU45yesBFxvPydXexG3Na1dnveblcsJQ-rWgY7WevMp8BDaagnzkc/exec"
};
const APPS_SCRIPT_REQUIRED_VERSION = "2.8.0";
const APPS_SCRIPT_TIMEOUT_MS = 45000;

const isAppsScriptVersionCompatible = (version) => {
  const current = String(version || "").trim();
  if (!current) return true;
  const parse = (value) => value.split(".").map((part) => Number(part));
  const installed = parse(current);
  const required = parse(APPS_SCRIPT_REQUIRED_VERSION);
  if (installed.some((part) => !Number.isFinite(part)) || required.some((part) => !Number.isFinite(part))) {
    return current === APPS_SCRIPT_REQUIRED_VERSION;
  }
  for (let index = 0; index < Math.max(installed.length, required.length); index += 1) {
    const difference = Number(installed[index] || 0) - Number(required[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

const transientAppsScriptError = (message) => {
  const error = new Error(message);
  error.transient = true;
  return error;
};

const isTransientAppsScriptError = (error) => Boolean(
  error?.transient
  || /failed to fetch|networkerror|network request failed|load failed|aborterror|timeout/i.test(String(error?.message || error || ""))
);

const SupabaseDb = (() => {
  let authToken = "";
  let clientTableAccess = { table_id: "", code: "" };
  let client = null;
  const rpcNames = {
    getBootstrapData: "get_bootstrap_data",
    getAdminSnapshot: "get_admin_snapshot",
    getClientSnapshot: "get_client_snapshot",
    getClientTableState: "get_client_table_state",
    getInitialSetupStatus: "get_initial_setup_status",
    bootstrapFirstAdmin: "bootstrap_first_admin",
    getCurrentUser: "get_current_user",
    listUsers: "list_users",
    saveUser: "save_user",
    deleteUser: "delete_user",
    acknowledgeServiceRequests: "acknowledge_service_requests",
    resolveBill: "resolve_bill",
    createServiceRequest: "create_service_request",
    createServiceRequestsBatch: "create_service_requests_batch",
    listChatMessages: "list_chat_messages",
    sendChatMessage: "send_chat_message",
    closeChatSession: "close_chat_session"
  };

  const init = () => {
    if (client) return client;
    if (!window.supabase?.createClient) throw new Error("No se cargó el cliente de Supabase.");
    const authenticatedFetch = (input, options = {}) => {
      const headers = new Headers(options.headers || {});
      if (authToken) headers.set("x-app-token", authToken);
      if (clientTableAccess.table_id) headers.set("x-table-id", clientTableAccess.table_id);
      if (clientTableAccess.code) headers.set("x-table-code", clientTableAccess.code);
      return fetch(input, { ...options, headers });
    };
    client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: authenticatedFetch }
    });
    return client;
  };

  return {
    init,
    from: (table) => init().from(table),
    rpc: (name, payload = {}) => init().rpc(rpcNames[name] || name, payload),
    setAuthToken: (token = "") => { authToken = token; },
    setTableAccess: (tableId = "", code = "") => { clientTableAccess = { table_id: tableId, code }; },
    storage: { from: (bucket) => init().storage.from(bucket) },
    channel: (...args) => init().channel(...args),
    removeChannel: (channel) => init().removeChannel(channel)
  };
})();

const App = (() => {
  const REQUEST_LABELS = {
    waiter: "Llamar mesero",
    bill: "Ver cuenta",
    other: "Canción solicitada"
  };

  const REQUEST_ICONS = {
    waiter: "bell-ring",
    bill: "receipt-text",
    other: "message-circle-question"
  };

  const DEFAULT_CURRENCY = "COP";
  const INVENTORY_STORAGE_KEY = "tienda_napoles_inventory_v1";
  const INVOICE_STORAGE_KEY = "tienda_napoles_invoices_v1";
  const INVENTORY_MOVEMENTS_STORAGE_KEY = "tienda_napoles_inventory_movements_v1";
  const APPS_SCRIPT_OUTBOX_KEY = "tienda_napoles_appscript_outbox_v1";
  const WALK_IN_DRAFTS_STORAGE_KEY = "tienda_napoles_walk_in_drafts_v1";
  const SERVICE_ZONE_STORAGE_KEY = "tienda_napoles_service_zone_v1";
  const TIP_SETTINGS_STORAGE_KEY = "tienda_napoles_tip_settings_v1";
  const TIP_SPLIT_STORAGE_KEY = "tienda_napoles_tip_split_people_v1";
  const TIP_RESET_STORAGE_KEY = "tienda_napoles_tip_reset_invoices_v1";
  const USER_LIST_CACHE_KEY = "tienda_napoles_users_v1";
  const PWA_BRAND_CACHE = "tienda-napoles-pwa-brand-v1";
  const CATEGORY_PRESETS = ["Snack", "Bebidas", "Medicina", "Otros"];
  const REQUEST_IMAGES = {
    waiter: "images/mesero.png",
    bill: "images/check.png"
  };
  const RECEIPT_SOUND = "sound/receipt-received.mp3";
  const BAR_ASSISTANT_OPTIONS = [
    {
      name: "Canasta de cerveza",
      aliases: ["canasta cerveza", "canasta de cervezas", "canasta de birra"],
      detail: "Canasta de cerveza para compartir; el mesero confirma marcas y disponibilidad."
    },
    {
      name: "Ron Medellín",
      aliases: ["ron medellin", "medellin", "botella de ron medellin"],
      detail: "Ron Medellín; el mesero confirma la presentación disponible."
    },
    {
      name: "Aguardiente",
      aliases: ["guaro", "aguardiente antioqueno", "aguardiente antioqueño", "botella de aguardiente"],
      detail: "Aguardiente; el mesero confirma marca y presentación."
    },
    {
      name: "Whisky",
      aliases: ["whiskey", "botella de whisky", "media de whisky"],
      detail: "Whisky; el mesero confirma marcas y presentaciones disponibles."
    },
    {
      name: "Vodka",
      aliases: ["botella de vodka", "media de vodka"],
      detail: "Vodka; el mesero confirma marcas y presentaciones disponibles."
    },
    {
      name: "Tequila",
      aliases: ["botella de tequila", "shots de tequila", "shot de tequila"],
      detail: "Tequila por botella o por shots, sujeto a disponibilidad."
    },
    {
      name: "Cóctel",
      aliases: ["coctel", "cocteles", "cócteles", "trago preparado"],
      detail: "Cóctel preparado; el mesero comparte las opciones disponibles."
    },
    {
      name: "Cerveza individual",
      aliases: ["una cerveza", "cerveza", "cervezas", "birra"],
      detail: "Cerveza individual; el mesero confirma las marcas disponibles."
    },
    {
      name: "Bebida sin alcohol",
      aliases: ["gaseosa", "soda", "agua", "jugos", "bebida sin alcohol"],
      detail: "Agua, gaseosa u otra bebida sin alcohol, según disponibilidad."
    }
  ];
  const ASSISTANT_SYSTEM_PROMPT = [
    "Eres el agente virtual del bar y atiendes al cliente desde su mesa con tono amable, claro y profesional.",
    "Entiendes frases naturales para pedir bebidas y productos, ver la cuenta, llamar al mesero, consultar la carta o preguntar precios.",
    "Cuando reconoces un pedido, identificas el producto y la cantidad y avisas al mesero para que confirme los detalles.",
    "Si falta una mesa, no permites enviar pedidos ni solicitudes; primero pides verificar la mesa.",
    "No informas precios ni inventas presentaciones; el mesero confirma marcas, tamaños, disponibilidad y valores.",
    "Si no reconoces el producto exacto, envías igualmente la solicitud al equipo y se lo explicas al cliente.",
    "Siempre corriges ortografía, tildes, mayúsculas, puntos y comas en los mensajes que llegan al administrador.",
    "Trabajas con una guía interna de opciones de bar y no consultas el catálogo de productos de la base de datos."
  ].join("\n");

  const ASSISTANT_INTENTS = {
    help: [
      "en que me puedes ayudar",
      "como me puedes ayudar",
      "me puedes ayudar",
      "que puedes hacer",
      "que haces",
      "ayudame",
      "ayuda",
      "hola",
      "buenas"
    ],
    menu: [
      "menu",
      "carta",
      "opciones",
      "que tienen",
      "que venden",
      "que me recomiendas",
      "recomiendame",
      "recomendacion",
      "bebidas",
      "cervezas",
      "licores",
      "cocteles",
      "cócteles",
      "botellas",
      "tragos"
    ],
    order: [
      "quiero pedir",
      "quiero ordenar",
      "me gustaria pedir",
      "me gustaria ordenar",
      "voy a pedir",
      "voy a ordenar",
      "dame",
      "traeme",
      "agrega",
      "anota",
      "pideme",
      "ordenar"
    ],
    bill: [
      "cuenta",
      "factura",
      "recibo",
      "cobrar",
      "pagar",
      "la cuenta por favor"
    ],
    waiter: [
      "mesero",
      "mesera",
      "atiendan",
      "atender",
      "venga alguien",
      "llama a alguien",
      "necesito atencion"
    ],
    inquiry: [
      "que tiene",
      "ingredientes",
      "cuanto vale",
      "cuanto cuesta",
      "precio",
      "precios",
      "de que es",
      "como viene",
      "presentacion",
      "presentación",
      "cuantos ml"
    ]
  };

  const ASSISTANT_NUMBER_WORDS = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10
  };
  const state = {
    sb: null,
    page: "",
    business: null,
    tables: [],
    categories: [],
    items: [],
    activeCategory: "all",
    currentTable: null,
    currentSession: null,
    sessionItems: [],
    clientRequests: [],
    tableAccountStatus: "idle",
    tableAccountTotal: 0,
    localBillOpen: false,
    clientHydrationToken: 0,
    billReceiptArmedIds: new Set(),
    requests: [],
    sessions: [],
    authToken: "",
    currentUser: null,
    users: [],
    inventoryMeta: {},
    inventoryMovements: [],
    movementRequestId: 0,
    movementNextBeforeRow: null,
    movementLoadingMore: false,
    movementSearch: "",
    movementTypeFilter: "all",
    invoiceHistory: [],
    inventorySearch: "",
    inventoryStatusFilter: "all",
    inventoryCategoryFilter: "all",
    incomeReport: null,
    incomeLoading: false,
    incomeLoadingMore: false,
    incomeRequestId: 0,
    incomeRequestKey: "",
    incomeRangePreset: "month",
    incomeSearchTimer: null,
    incomeRecoveryPromise: null,
    incomeRecoveredRanges: new Set(),
    incomeRecoveryReport: null,
    incomeLastRequestAt: 0,
    productPickerMatches: [],
    consumptionDrafts: [],
    consumptionDraftEditIndex: -1,
    activePaymentTotal: 0,
    activePaymentBase: 0,
    activePaymentTip: 0,
    tipSettings: { enabled: false, percentage: 10 },
    tipSplitPeople: 1,
    clearedTipInvoiceKeys: new Set(),
    paymentProcessing: false,
    lastPaidReceipt: null,
    appsScriptOutboxBusy: false,
    appsScriptOutboxTimer: null,
    alertFilter: "all",
    optimisticRequestStates: new Map(),
    optimisticSessionStates: new Map(),
    soundEnabled: false,
    soundPrimed: false,
    soundPriming: false,
    mousePrimeAttempted: false,
    lastAlertSignature: "",
    lastRequestBadgeCount: 0,
    announcedRequestIds: new Set(),
    alertAnnouncementQueue: [],
    alertAnnouncementBusy: false,
    alarmToneFinish: null,
    speechFinish: null,
    alertRenderSignature: null,
    accountsRenderSignature: null,
    activeAccountDetailId: "",
    adminSnapshotSignature: "",
    clientSnapshotSignature: "",
    visibleToastKeys: new Set(),
    toastLastShown: new Map(),
    alarmTimer: null,
    alarmStopTimer: null,
    adminPollTimer: null,
    adminSyncBusy: false,
    activeAdminSection: "dashboard",
    dashboardTableZoneFilter: "all",
    dashboardTableSearch: "",
    serviceTableZoneFilter: "all",
    serviceTableSearch: "",
    outdoorTableDraftIds: null,
    outdoorTableDraftDirty: false,
    sectionRenderTimer: null,
    sectionRenderFrame: 0,
    sectionSwitchToken: 0,
    tableManagerRenderSignature: "",
    usersRenderSignature: "",
    adminAiRenderSignature: "",
    coreRefreshBusy: false,
    pwaBrandSignature: "",
    pwaBrandSyncToken: 0,
    pwaManifestObjectUrl: "",
    pwaIconObjectUrls: [],
    pwaRegistrationPromise: null,
    qrCache: new Map(),
    selectedTableQrIds: new Set(),
    activeServiceZone: localStorage.getItem(SERVICE_ZONE_STORAGE_KEY) === "planter" ? "planter" : "bar",
    tableRenderSignature: "",
    assistantMessages: [],
    assistantThreads: { bar: [], song: [] },
    assistantMode: "bar",
    chatMessages: [],
    adminChats: new Map(),
    adminChatTypingTimers: new Map(),
    adminBroadcastChannel: null,
    adminChatActive: false,
    adminChatNotice: "",
    clientChatInitialized: false,
    clientChatSoundSessionId: "",
    clientStaffMessageSoundIds: new Set(),
    chatPollTimer: null,
    chatTypingTimer: null,
    peerTyping: false,
    adminAiMessages: [],
    tableLocked: false,
    qrLocked: false,
    clientChannel: null,
    clientPollTimer: null,
    clientSyncBusy: false,
    requestOutboxBusy: false,
    requestOutboxTimer: null,
    requestOutboxMemory: [],
    billResolutionBusy: false,
    billResolutionTimer: null,
    qrCameraStream: null,
    qrScanner: null,
    qrScannerControls: null,
    qrCameraDevices: [],
    qrScanBusy: false,
    subscriptions: []
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const icon = (name, size = 18) => `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;

  const money = (value, currency = DEFAULT_CURRENCY) =>
    new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: DEFAULT_CURRENCY,
      maximumFractionDigits: 0
    }).format(Number(value || 0));

  const currencyInputNumber = (fieldOrValue) => {
    if (typeof fieldOrValue === "number") return Number.isFinite(fieldOrValue) ? Math.max(0, Math.round(fieldOrValue)) : 0;
    const raw = typeof fieldOrValue === "object" && fieldOrValue !== null ? fieldOrValue.value : fieldOrValue;
    const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 15);
    return digits ? Number(digits) : 0;
  };

  const formattedCurrencyInput = (value, { allowEmpty = false } = {}) => {
    const raw = typeof value === "object" && value !== null ? value.value : value;
    const normalizedRaw = typeof raw === "number" ? String(Math.max(0, Math.round(raw))) : String(raw ?? "");
    const digits = normalizedRaw.replace(/\D/g, "").slice(0, 15);
    if (!digits) return allowEmpty ? "" : "$0";
    return `$${Number(digits).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
  };

  const setCurrencyInputValue = (input, value) => {
    if (!input) return;
    input.value = formattedCurrencyInput(value);
    input.dataset.rawValue = String(currencyInputNumber(value));
  };

  const bindCurrencyInputs = (root = document) => {
    $$('[data-currency-input]', root).forEach((input) => {
      if (input.dataset.currencyBound === "true") return;
      input.dataset.currencyBound = "true";
      setCurrencyInputValue(input, input.value);
      input.addEventListener("input", () => {
        input.value = formattedCurrencyInput(input.value, { allowEmpty: true });
        input.dataset.rawValue = String(currencyInputNumber(input));
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
      });
      input.addEventListener("focus", () => {
        window.setTimeout(() => input.select(), 0);
      });
      input.addEventListener("blur", () => setCurrencyInputValue(input, input.value));
    });
  };

  const toast = (message, type = "ok", key = `${type}:${message}`) => {
    const now = Date.now();
    const cooldown = type === "error" ? 15000 : 3000;
    if (state.visibleToastKeys.has(key)) return;
    if (now - Number(state.toastLastShown.get(key) || 0) < cooldown) return;
    state.visibleToastKeys.add(key);
    state.toastLastShown.set(key, now);
    let box = $(".system-modal-stack");
    if (!box) {
      box = document.createElement("div");
      box.className = "system-modal-stack";
      document.body.appendChild(box);
    }
    const item = document.createElement("div");
    item.className = `system-modal ${type}`;
    const iconName = type === "error" ? "circle-alert" : "badge-check";
    item.innerHTML = `
      <div class="system-modal-icon">${icon(iconName, 24)}</div>
      <div>
        <strong>${type === "error" ? "Atencion" : "Listo"}</strong>
        <p>${message}</p>
      </div>
    `;
    box.appendChild(item);
    refreshIcons();
    setTimeout(() => {
      item.classList.add("leaving");
      setTimeout(() => {
        item.remove();
        state.visibleToastKeys.delete(key);
      }, 220);
    }, type === "error" ? 5600 : 3600);
  };

  const isConfigured = () => Boolean(
    window.supabase?.createClient &&
    SUPABASE_CONFIG.url &&
    SUPABASE_CONFIG.anonKey &&
    !SUPABASE_CONFIG.url.includes("TU_") &&
    !SUPABASE_CONFIG.anonKey.includes("TU_")
  );

  const uid = () =>
    crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const refreshIcons = () => {
    if (window.lucide) window.lucide.createIcons();
  };

  const setLoading = (isLoading) => {
    document.body.classList.toggle("is-loading", isLoading);
  };

  const connect = () => {
    if (!isConfigured()) {
      toast("Configura SUPABASE_CONFIG y verifica que cargue supabase-js.", "error");
      return false;
    }
    state.sb = SupabaseDb;
    state.sb.init();
    return true;
  };

  const db = async (builder, fallback = null) => {
    try {
      const { data, error } = await builder;
      if (error) throw error;
      return data;
    } catch (error) {
      console.error(error);
      const message = String(error?.message || "");
      const transient = error?.transient || /reintento de red|failed to fetch|networkerror|network request failed|load failed|aborterror|timeout/i.test(message);
      if (!transient) toast(message || "Error de Supabase", "error");
      return fallback;
    }
  };

  const loadBusiness = async () => {
    const data = await db(
      state.sb.from("business_settings").select("*").eq("is_primary", true).maybeSingle(),
      null
    );
    state.business = data || state.business || {
      business_name: "Tu restaurante",
      subtitle: "Servicio a la mesa rapido y claro",
      accent_color: "#f05a28",
      currency: DEFAULT_CURRENCY,
      tips_enabled: false,
      tip_percentage: 10
    };
    applyBusinessTipSettings();
    document.documentElement.style.setProperty("--accent", state.business.accent_color || "#f05a28");
    return Boolean(data);
  };

  const loadCore = async () => {
    const [tables, categories, items] = await Promise.all([
      db(state.sb.from("restaurant_tables").select("*").order("table_number", { ascending: true }), null),
      db(state.sb.from("menu_categories").select("*").order("sort_order", { ascending: true }), null),
      db(
        state.sb
          .from("menu_items")
          .select("*, menu_categories(name)")
          .order("sort_order", { ascending: true }),
        null
      )
    ]);
    if (Array.isArray(tables)) state.tables = tables;
    if (Array.isArray(categories)) state.categories = categories;
    if (Array.isArray(items)) state.items = items;
    return Array.isArray(tables) && Array.isArray(categories) && Array.isArray(items);
  };

  const ensurePresetCategories = async () => {
    if (state.currentUser?.role !== "admin") return;
    const existing = new Set(state.categories.map((category) => normalizeText(category.name)));
    const missing = CATEGORY_PRESETS.filter((name) => !existing.has(normalizeText(name)));
    if (!missing.length) return;
    const created = (await Promise.all(missing.map((name, index) => dbQuiet(
      state.sb.from("menu_categories").insert({ name, sort_order: 100 + index, is_active: true }).select("*").single(),
      null
    )))).filter(Boolean);
    if (created.length) {
      state.categories = [...state.categories, ...created];
      persistBootstrapCache();
      renderMenuManager();
    }
  };

  const emptyState = (title, text, iconName = "sparkles") => `
    <div class="empty-state">
      ${icon(iconName, 26)}
      <strong>${title}</strong>
      <span>${text}</span>
    </div>
  `;

  const tableLabel = (table) => table?.table_name || `Mesa ${table?.table_number || ""}`.trim();

  const servicePointKind = (table) => {
    const name = normalizeText(table?.table_name || "");
    if (/^barra\s+\d+$/.test(name)) return "bar";
    if (/^matera\s+\d+$/.test(name)) return "planter";
    return "";
  };

  const isServicePoint = (table) => Boolean(servicePointKind(table));

  const normalTables = () => state.tables.filter((table) => !isServicePoint(table));

  const isOutdoorTable = (table) => table?.is_outdoor === true;

  const tableMatchesZone = (table, filter = "all") => filter === "all"
    || (filter === "outdoor" ? isOutdoorTable(table) : !isOutdoorTable(table));

  const filterTablesBySmartSearch = (tables, searchValue = "") => {
    const compactQuery = String(searchValue || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!compactQuery) return tables;
    const numberQuery = compactQuery.replace(/^MESA/, "").replace(/^M/, "");
    if (/^\d+$/.test(numberQuery)) {
      const exact = tables.filter((table) => String(table.table_number || "") === numberQuery);
      return exact.length ? exact : tables.filter((table) => String(table.table_number || "").startsWith(numberQuery));
    }
    const textQuery = normalizeText(searchValue);
    return tables.filter((table) => normalizeText([
      tableLabel(table),
      table.table_number,
      `M${table.table_number || ""}`,
      `MESA ${table.table_number || ""}`
    ].join(" ")).includes(textQuery));
  };

  const sessionLabel = (session) => session?.sale_channel === "walk_in" || !session?.table_id
    ? "Venta individual"
    : tableLabel(session?.restaurant_tables);

  const sessionReference = (session) => String(session?.id || "")
    .replace(/^walk-in-/i, "")
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();

  const tableCode = (table) => table?.qr_code || `mesa-${table?.table_number || ""}`;

  const clientUrlForCode = (code) => {
    const url = new URL("index.html", window.FRONTEND_URL || location.href);
    url.search = "";
    url.searchParams.set("mesa", code);
    url.searchParams.set("page", "client");
    return url.href;
  };

  const qrTextForTable = (table) => clientUrlForCode(tableCode(table));

  const generateQrDataUrl = (text, size = 720) =>
    new Promise((resolve, reject) => {
      if (!window.QRCode) {
        reject(new Error("No se cargo el generador de QR."));
        return;
      }
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "-9999px";
      host.style.top = "0";
      document.body.appendChild(host);
      new window.QRCode(host, {
        text,
        width: size,
        height: size,
        colorDark: "#14171d",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.H
      });
      window.setTimeout(() => {
        const canvas = host.querySelector("canvas");
        const image = host.querySelector("img");
        const dataUrl = canvas?.toDataURL("image/png") || image?.src;
        host.remove();
        dataUrl ? resolve(dataUrl) : reject(new Error("No se pudo generar el QR."));
      }, 40);
    });

  const cachedQrDataUrl = async (text, size = 720) => {
    const key = `${size}:${text}`;
    if (!state.qrCache.has(key)) {
      state.qrCache.set(key, generateQrDataUrl(text, size));
    }
    return state.qrCache.get(key);
  };

  const renderQrImage = async (target, text, alt = "QR") => {
    if (!target || !text) return;
    if (target.dataset.qrText === text && target.querySelector("img")) return;
    target.dataset.qrText = text;
    target.classList.add("qr-loading");
    try {
      const dataUrl = await cachedQrDataUrl(text, 420);
      target.innerHTML = `<img src="${dataUrl}" alt="${alt}">`;
    } catch (error) {
      target.innerHTML = `${icon("qr-code", 20)}`;
    } finally {
      target.classList.remove("qr-loading");
      refreshIcons();
    }
  };

  const setRealtimeStatus = (status, tone = "connecting") => {
    const badge = $("#realtimeStatus");
    if (!badge) return;
    badge.className = `live-status ${tone}`;
    badge.innerHTML = `${icon(tone === "live" ? "wifi" : "wifi-off", 15)} ${status}`;
    refreshIcons();
  };

  const showAdminSection = (section = "dashboard") => {
    if (section === "tips" && !tipsEnabled()) section = state.currentUser?.role === "waiter" ? "service" : "accounts";
    if (state.currentUser?.role === "waiter" && !["service", "accounts", "tips"].includes(section)) section = "service";
    state.activeAdminSection = section;
    $$("[data-admin-section]").forEach((el) => {
      el.classList.toggle("section-active", el.dataset.adminSection === section);
    });
    $$(".admin-sidebar nav a").forEach((link) => {
      const target = link.getAttribute("href")?.replace("#", "");
      const active = target === section;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (section === "movements" && navigator.onLine && isAppsScriptConfigured()) {
      const list = $("#inventoryMovementList");
      const summary = $("#movementSummary");
      if (list) list.innerHTML = emptyState("Actualizando movimientos", "Consultando el historial oficial...", "refresh-cw");
      if (summary) summary.innerHTML = "";
      refreshIcons();
    }
    const switchToken = ++state.sectionSwitchToken;
    window.cancelAnimationFrame(state.sectionRenderFrame);
    window.clearTimeout(state.sectionRenderTimer);
    state.sectionRenderFrame = window.requestAnimationFrame(() => {
      if (state.activeAdminSection !== section || switchToken !== state.sectionSwitchToken) return;
      state.sectionRenderTimer = window.setTimeout(() => {
        if (state.activeAdminSection !== section || switchToken !== state.sectionSwitchToken) return;
        if (section === "dashboard") {
          renderAlerts();
          renderTables();
        }
        if (section === "accounts") renderAccounts();
        if (section === "tips") renderTips();
        if (section === "service") renderServiceTables();
        if (section === "menu") {
          renderTableManager();
          renderTableFormQr();
        }
        if (section === "inventory") renderInventory();
        if (section === "movements") {
          if (!navigator.onLine || !isAppsScriptConfigured()) renderInventoryMovements();
          void loadInventoryMovements();
        }
        if (section === "income") {
          initializeIncomeFilters();
          if (!state.incomeLoading || state.incomeRequestKey !== JSON.stringify(incomeFiltersFromForm())) void loadIncomeReport();
        }
        if (section === "users") renderUsers();
        if (section === "assistant") renderAdminAi();
      }, 0);
    });
  };

  const findTableFromUrl = () => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("mesa") || params.get("table") || params.get("t") || params.get("qr");
    if (!raw) return null;
    const table = state.tables.find(
      (table) =>
        !isServicePoint(table) && (
          String(table.table_number) === String(raw) ||
          String(table.qr_code).toLowerCase() === String(raw).toLowerCase() ||
          String(table.id) === String(raw)
        )
    );
    state.qrLocked = Boolean(table);
    state.tableLocked = state.qrLocked;
    return table;
  };

  const refreshTableLock = () => {
    if (!state.currentTable) return;
    const hasAccount = state.sessionItems.some(
      (item) => item.status !== "cancelled" && Number(item.quantity || 0) > 0
    );
    state.tableAccountStatus = hasAccount ? "active" : "empty";
    state.tableAccountTotal = state.sessionItems
      .filter((item) => item.status !== "cancelled")
      .reduce((total, item) => total + Number(item.unit_price || 0) * Number(item.quantity || 0), 0);
    if (!state.tableLocked) state.tableLocked = hasAccount;
    if (state.currentTable) renderTablePicker();
  };

  const ensureOpenSession = async (tableId) => {
    let session = await db(
      state.sb
        .from("table_sessions")
        .select("*")
        .eq("table_id", tableId)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      null
    );
    if (!session) {
      session = await db(
        state.sb.from("table_sessions").insert({ table_id: tableId, status: "open" }).select("*").single(),
        null
      );
    }
    if (state.currentSession?.id !== session?.id) state.clientSnapshotSignature = "";
    state.currentSession = session;
    return session;
  };

  const reconcilePendingBillsForTable = (requests = []) => {
    const queuedIds = new Set(readRequestOutbox().map((item) => item.request_id));
    pendingBillIds().forEach((id) => {
      const request = requests.find((item) => item.id === id);
      if (request?.status === "pending" || request?.status === "sending" || queuedIds.has(id)) {
        state.billReceiptArmedIds.add(id);
      } else if (!state.billReceiptArmedIds.has(id)) {
        clearPendingBill(id);
      }
    });
  };

  const hydrateSelectedTable = async (tableId) => {
    const table = state.currentTable;
    if (!table || table.id !== tableId) return null;
    const token = ++state.clientHydrationToken;
    state.tableAccountStatus = "checking";
    state.tableAccountTotal = 0;
    renderTablePicker();
    const snapshot = await dbQuiet(state.sb.rpc("getClientTableState", {
      table_id: table.id,
      table_access_code: tableCode(table),
      ensure_session: true
    }), null);
    if (token !== state.clientHydrationToken || state.currentTable?.id !== tableId) return null;
    if (snapshot?.session) {
      state.currentSession = snapshot.session;
      state.sessionItems = snapshot.sessionItems || [];
      state.clientRequests = snapshot.requests || [];
      state.clientSnapshotSignature = "";
    } else {
      const session = await ensureOpenSession(tableId);
      if (token !== state.clientHydrationToken || state.currentTable?.id !== tableId || !session) return null;
      await loadClientSnapshot();
    }
    reconcilePendingBillsForTable(state.clientRequests);
    refreshTableLock();
    renderAccount();
    renderBillChat();
    subscribeClient();
    return state.currentSession;
  };

  const loadClientSessionItems = async () => {
    if (!state.currentSession) return;
    state.sessionItems = await db(
      state.sb
        .from("session_items")
        .select("*")
        .eq("session_id", state.currentSession.id)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false }),
      []
    );
    refreshTableLock();
  };

  const loadClientRequests = async () => {
    if (!state.currentSession) {
      state.clientRequests = [];
      return;
    }
    state.clientRequests = await db(
      state.sb
        .from("service_requests")
        .select("*")
        .eq("session_id", state.currentSession.id)
        .order("created_at", { ascending: false }),
      []
    );
  };

  const dbQuiet = async (builder, fallback = null) => {
    try {
      const { data, error } = await builder;
      if (error) return fallback;
      return data;
    } catch (error) {
      return fallback;
    }
  };

  let bootstrapPromise = null;
  const bootstrapCacheKey = () => {
    const params = new URLSearchParams(location.search);
    const code = params.get("mesa") || params.get("table") || params.get("t") || params.get("qr") || "none";
    return `la_licorera_17_supabase_bootstrap_v2_${state.page}_${state.authToken ? "staff" : encodeURIComponent(code)}`;
  };

  const tableValueFromUrl = () => {
    const params = new URLSearchParams(location.search);
    return params.get("mesa") || params.get("table") || params.get("t") || params.get("qr") || "";
  };
  const persistBootstrapCache = () => {
    try {
      localStorage.setItem(bootstrapCacheKey(), JSON.stringify({
        business: state.business,
        tables: state.tables,
        categories: state.categories,
        items: state.items
      }));
    } catch (error) { /* cache opcional */ }
  };
  const loadBootstrap = async () => {
    if (bootstrapPromise) return bootstrapPromise;
    const applyBootstrap = (data) => {
      if (!data) return false;
      state.business = data.business || {
        business_name: "Tu restaurante",
        subtitle: "Servicio a la mesa rapido y claro",
        accent_color: "#f05a28",
        currency: DEFAULT_CURRENCY,
        tips_enabled: false,
        tip_percentage: 10
      };
      state.tables = data.tables || [];
      state.categories = data.categories || [];
      state.items = data.items || [];
      loadInventoryStore();
      document.documentElement.style.setProperty("--accent", state.business.accent_color || "#f05a28");
      return true;
    };
    let hasCachedBootstrap = false;
    try {
      hasCachedBootstrap = applyBootstrap(JSON.parse(localStorage.getItem(bootstrapCacheKey()) || "null"));
    } catch (error) {
      hasCachedBootstrap = false;
    }
    bootstrapPromise = (async () => {
      const params = new URLSearchParams(location.search);
      const accessCode = params.get("mesa") || params.get("table") || params.get("t") || params.get("qr") || "";
      const data = await dbQuiet(state.sb.rpc("getBootstrapData", {
        auth_token: state.authToken || "",
        table_access_code: accessCode
      }), null);
      if (data) {
        applyBootstrap(data);
        persistBootstrapCache();
      } else if (!hasCachedBootstrap) {
        await Promise.all([loadBusiness(), loadCore()]);
      }
      document.documentElement.style.setProperty("--accent", state.business.accent_color || "#f05a28");
      return true;
    })();
    // Con datos de la sesion anterior la interfaz no espera a la red.
    if (hasCachedBootstrap) {
      bootstrapPromise.then(() => {
        if (state.page === "client") {
          renderBrand();
          renderTablePicker();
          renderMenu();
        }
        if (state.page === "admin") {
          renderBrand();
          renderAdminShell();
          renderTableFormQr();
        }
      });
      return true;
    }
    return bootstrapPromise;
  };

  const loadClientSnapshot = async () => {
    if (!state.currentSession) return;
    const snapshot = await dbQuiet(
      state.sb.rpc("getClientSnapshot", {
        session_id: state.currentSession.id,
        table_id: state.currentTable?.id || null,
        table_access_code: tableCode(state.currentTable)
      }),
      null
    );
    if (!snapshot) {
      await Promise.all([loadClientSessionItems(), loadClientRequests()]);
      return true;
    }
    const signature = JSON.stringify([
      (snapshot.sessionItems || []).map((item) => [item.id, item.status, item.quantity, item.updated_at]),
      (snapshot.requests || []).map((request) => [request.id, request.status, request.updated_at])
    ]);
    if (signature === state.clientSnapshotSignature) return false;
    state.clientSnapshotSignature = signature;
    state.sessionItems = snapshot.sessionItems || [];
    state.clientRequests = snapshot.requests || [];
    refreshTableLock();
    return true;
  };

  const pwaAssetUrl = (name) => new URL(name, document.baseURI).href;

  const pwaBrandVersion = (value) => Array.from(String(value || "")).reduce(
    (hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0,
    0
  ).toString(36).replace("-", "n");

  const registerPwa = () => {
    if (state.pwaRegistrationPromise) return state.pwaRegistrationPromise;
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    if (!("serviceWorker" in navigator) || (location.protocol !== "https:" && !localHost)) {
      state.pwaRegistrationPromise = Promise.resolve(null);
      return state.pwaRegistrationPromise;
    }
    state.pwaRegistrationPromise = navigator.serviceWorker.register("./service-worker.js", { scope: "./" })
      .catch(() => null);
    return state.pwaRegistrationPromise;
  };

  const waitForPwaController = async () => {
    if (!("serviceWorker" in navigator)) return false;
    if (navigator.serviceWorker.controller) return true;
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        navigator.serviceWorker.removeEventListener("controllerchange", finish);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", finish, { once: true });
      window.setTimeout(finish, 2500);
    });
    return Boolean(navigator.serviceWorker.controller);
  };

  const loadPwaLogo = (url) => new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("No se pudo preparar el logo para la instalación."));
    image.src = url;
  });

  const pwaIconBlob = async (logoUrl, size) => {
    const image = await loadPwaLogo(logoUrl);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("El navegador no puede generar el icono de instalación.");
    context.fillStyle = "#000000";
    context.fillRect(0, 0, size, size);
    const safeArea = size;
    const scale = Math.min(safeArea / image.naturalWidth, safeArea / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("No se pudo convertir el logo en icono.")),
      "image/png"
    ));
  };

  const replacePwaManifestLink = (href) => {
    const current = $("#appManifest");
    if (!current || current.href === href) return;
    current.href = href;
  };

  const syncPwaBranding = async () => {
    if (!state.business) return;
    const name = String(state.business.business_name || "Tienda Nápoles").trim() || "Tienda Nápoles";
    const logoUrl = pwaAssetUrl("images/los-anos-login.png");
    const themeColor = String(state.business.accent_color || "#f05a28");
    const signature = `${name}|${logoUrl}|${themeColor}`;
    if (signature === state.pwaBrandSignature) return;
    state.pwaBrandSignature = signature;
    const syncToken = ++state.pwaBrandSyncToken;
    const version = pwaBrandVersion(signature);
    const themeMeta = $("#pwaThemeColor");
    if (themeMeta) themeMeta.content = themeColor;

    state.pwaIconObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.pwaIconObjectUrls = [];
    let icon192 = null;
    let icon512 = null;
    if (logoUrl) {
      try {
        [icon192, icon512] = await Promise.all([pwaIconBlob(logoUrl, 192), pwaIconBlob(logoUrl, 512)]);
      } catch (error) {
        icon192 = null;
        icon512 = null;
      }
    }
    if (syncToken !== state.pwaBrandSyncToken) return;

    let iconEntries = [
      { src: "./images/los-anos-pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "./images/los-anos-pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
    ];
    if (icon192 && icon512) {
      const faviconUrl = URL.createObjectURL(icon192);
      const largeIconUrl = URL.createObjectURL(icon512);
      state.pwaIconObjectUrls = [faviconUrl, largeIconUrl];
      if ($("#appFavicon")) {
        $("#appFavicon").href = faviconUrl;
        $("#appFavicon").type = "image/png";
      }
      if ($("#appleTouchIcon")) $("#appleTouchIcon").href = faviconUrl;
      if ("caches" in window) {
        const cache = await caches.open(PWA_BRAND_CACHE);
        await Promise.all([
          cache.put(pwaAssetUrl("pwa-icon-192.png"), new Response(icon192, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } })),
          cache.put(pwaAssetUrl("pwa-icon-512.png"), new Response(icon512, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } }))
        ]);
      }
      iconEntries = [
        { src: `./pwa-icon-192.png?v=${version}`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `./pwa-icon-512.png?v=${version}`, sizes: "512x512", type: "image/png", purpose: "any" }
      ];
    } else if (logoUrl) {
      if ($("#appFavicon")) $("#appFavicon").href = logoUrl;
      if ($("#appleTouchIcon")) $("#appleTouchIcon").href = logoUrl;
      iconEntries = [{ src: logoUrl, sizes: "any", type: "image/png", purpose: "any" }];
    }

    const manifest = {
      id: "./admin.html",
      name,
      short_name: Array.from(name).slice(0, 15).join(""),
      description: "Administración y servicio a la mesa",
      lang: "es-CO",
      start_url: "./admin.html",
      scope: "./",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: themeColor,
      prefer_related_applications: false,
      icons: iconEntries
    };
    const manifestText = JSON.stringify(manifest);
    if ("caches" in window) {
      const cache = await caches.open(PWA_BRAND_CACHE);
      await cache.put(pwaAssetUrl("pwa-manifest.webmanifest"), new Response(manifestText, {
        headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" }
      }));
    }
    if (syncToken !== state.pwaBrandSyncToken) return;
    await registerPwa();
    const controlled = await waitForPwaController();
    if (syncToken !== state.pwaBrandSyncToken) return;
    if (controlled) {
      replacePwaManifestLink(`${pwaAssetUrl("pwa-manifest.webmanifest")}?v=${version}`);
      return;
    }
    if (state.pwaManifestObjectUrl) URL.revokeObjectURL(state.pwaManifestObjectUrl);
    state.pwaManifestObjectUrl = URL.createObjectURL(new Blob([manifestText], { type: "application/manifest+json" }));
    replacePwaManifestLink(state.pwaManifestObjectUrl);
  };

  const renderBrand = () => {
    const logo = state.business?.logo_url
      ? `<img src="${escapeHTML(state.business.logo_url)}" alt="${escapeHTML(state.business.business_name)}" class="brand-logo">`
      : `<div class="brand-mark">${icon("utensils", 24)}</div>`;
    $$(".js-business-name").forEach((el) => {
      el.textContent = state.business?.business_name || "Tu restaurante";
    });
    $$(".js-business-subtitle").forEach((el) => {
      el.textContent = state.business?.subtitle || "Servicio a la mesa rapido y claro";
    });
    $$(".js-brand-logo").forEach((el) => {
      el.innerHTML = logo;
    });
    const cover = $(".client-hero");
    if (cover && state.business?.cover_url) {
      cover.style.backgroundImage = `linear-gradient(180deg, rgba(12,13,17,.40), rgba(12,13,17,.88)), url('${state.business.cover_url}')`;
    }
    if (state.business) void syncPwaBranding();
  };

  const renderTablePicker = () => {
    const picker = $("#tablePicker");
    if (!picker) return;
    if (state.currentTable) {
      const accountStatus = state.tableAccountStatus === "checking"
        ? `<small class="table-account-state checking">${icon("loader-circle", 14)} Consultando cuenta</small>`
        : state.tableAccountStatus === "active"
          ? `<small class="table-account-state active">${icon("receipt-text", 14)} Cuenta activa · ${money(state.tableAccountTotal)}</small>`
          : `<small class="table-account-state empty">${icon("circle-check", 14)} Sin cuenta</small>`;
      picker.innerHTML = `
        <div class="selected-table-state">
          <strong class="selected-table-name">${icon("map-pin", 16)} ${escapeHTML(tableLabel(state.currentTable))}</strong>
          ${accountStatus}
        </div>
        ${
          state.tableLocked
            ? `<strong class="locked-table-badge">${icon("lock-keyhole", 14)} ${state.qrLocked ? "QR verificado" : "Cuenta activa"}</strong>`
            : `<button class="ghost small" data-action="change-table">${icon("refresh-cw", 15)} Cambiar</button>`
        }
      `;
      refreshIcons();
      return;
    }
    picker.innerHTML = `
      <label for="tableSelect">Selecciona tu mesa</label>
      <select id="tableSelect">
        <option value="">Mesa</option>
        ${normalTables()
          .filter((table) => table.is_active)
          .map((table) => `<option value="${escapeHTML(table.id)}">${escapeHTML(tableLabel(table))}</option>`)
          .join("")}
      </select>
    `;
    refreshIcons();
  };

  const filteredItems = () =>
    state.items.filter(
      (item) =>
        item.is_available &&
        (state.activeCategory === "all" || item.category_id === state.activeCategory)
    );

  const renderMenu = () => {
    const tabs = $("#categoryTabs");
    const menu = $("#menuList");
    if (!tabs || !menu) return;

    tabs.innerHTML = `
      <button class="chip ${state.activeCategory === "all" ? "active" : ""}" data-category="all">
        ${icon("layout-grid", 16)} Todo
      </button>
      ${state.categories
        .filter((category) => category.is_active)
        .map(
          (category) => `
            <button class="chip ${state.activeCategory === category.id ? "active" : ""}" data-category="${category.id}">
              ${icon("tag", 16)} ${escapeHTML(category.name)}
            </button>
          `
        )
        .join("")}
    `;

    const items = filteredItems();
    menu.innerHTML = items.length
      ? items
          .map(
            (item) => `
              <article class="menu-item">
                <div class="food-image">
                  ${
                    item.image_url
                      ? `<img src="${escapeHTML(item.image_url)}" alt="${escapeHTML(item.name)}">`
                      : icon("chef-hat", 26)
                  }
                </div>
                <div class="menu-copy">
                  <div>
                    <span class="category-name">${escapeHTML(item.menu_categories?.name || "Menu")}</span>
                    <h3>${escapeHTML(item.name)}</h3>
                    <p>${escapeHTML(item.description || "Preparado por la casa.")}</p>
                  </div>
                  <div class="menu-actions">
                    <strong>${money(item.price)}</strong>
                    <button class="icon-btn" data-add-item="${escapeHTML(item.id)}" aria-label="Agregar ${escapeHTML(item.name)}">
                      ${icon("plus", 18)}
                    </button>
                  </div>
                </div>
              </article>
            `
          )
          .join("")
      : emptyState("Menu en preparacion", "Agrega productos desde el administrador.", "book-open");
    refreshIcons();
  };

  const renderAccount = () => {
    const box = $("#clientAccount");
    if (!box) return;
    const subtotal = state.sessionItems.reduce(
      (sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0),
      0
    );
    box.innerHTML = state.sessionItems.length
      ? `
        <div class="account-head">
          <span>${icon("receipt", 18)} Cuenta actual</span>
          <strong>${money(subtotal)}</strong>
        </div>
        <div class="account-list">
          ${[...state.sessionItems]
            .sort((left, right) => new Date(right.created_at || right.updated_at || 0) - new Date(left.created_at || left.updated_at || 0))
            .map(
              (item) => `
                <div class="account-row">
                  <span>${Number(item.quantity || 0)}x ${escapeHTML(item.item_name)}</span>
                  <strong>${money(Number(item.unit_price) * Number(item.quantity))}</strong>
                </div>
              `
            )
            .join("")}
        </div>
      `
      : emptyState("Sin consumos", "Agrega platos o llama al mesero para ordenar.", "shopping-bag");
    refreshIcons();
  };

  const receiptItemsForSession = (session) =>
    (session?.session_items || [])
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        name: item.item_name,
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || 0),
        total: Number(item.unit_price || 0) * Number(item.quantity || 0),
        registered_by: item.created_by_user?.full_name || "Cliente",
        registered_at: item.created_at || null
      }));

  const buildBillMessage = (session) => {
    const items = receiptItemsForSession(session);
    const totals = sessionTotals(session);
    return JSON.stringify({
      kind: "bill_receipt",
      sent_at: new Date().toISOString(),
      business_name: state.business?.business_name || "Tu restaurante",
      table: tableLabel(session?.restaurant_tables),
      payer_name: session?.payer_name || "",
      waiter_name: session?.assigned_waiter?.full_name || "",
      currency: DEFAULT_CURRENCY,
      items,
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      service_fee: totals.serviceFee,
      total: totals.total
    });
  };

  const retryQuiet = async (factory, attempts = 4) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await dbQuiet(factory(), null);
      if (result) return result;
      if (attempt < attempts - 1) {
        const delay = Math.min(5000, 350 * Math.pow(2, attempt));
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    }
    return null;
  };

  const parseBillMessage = (message) => {
    try {
      const parsed = JSON.parse(message || "{}");
      if (parsed.kind === "bill_receipt") return parsed;
    } catch (error) {
      return null;
    }
    return null;
  };

  const billTicketId = (request) => `#${String(request?.id || "").slice(0, 8).toUpperCase()}`;

  const billRequestStorageKey = (tableId = state.currentTable?.id) =>
    tableId ? `la_licorera_17_pending_bills_${tableId}` : "";

  const pendingBillIds = () => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(billRequestStorageKey()) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch (error) {
      return [];
    }
  };

  const rememberPendingBill = (requestOrId) => {
    const id = typeof requestOrId === "string" ? requestOrId : requestOrId?.id;
    if (!id || !state.currentTable?.id) return;
    state.billReceiptArmedIds.add(id);
    try {
      sessionStorage.setItem(billRequestStorageKey(), JSON.stringify([...new Set([...pendingBillIds(), id])].slice(-20)));
    } catch (error) { /* almacenamiento opcional */ }
  };

  const clearPendingBill = (requestId) => {
    state.billReceiptArmedIds.delete(requestId);
    try {
      const remaining = pendingBillIds().filter((id) => id !== requestId);
      sessionStorage.setItem(billRequestStorageKey(), JSON.stringify(remaining));
    } catch (error) { /* almacenamiento opcional */ }
  };

  const BILL_RESOLUTION_OUTBOX_KEY = "la_licorera_17_bill_resolution_outbox_v1";

  const readBillResolutionOutbox = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(BILL_RESOLUTION_OUTBOX_KEY) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch (error) {
      return [];
    }
  };

  const writeBillResolutionOutbox = (items) => {
    try { localStorage.setItem(BILL_RESOLUTION_OUTBOX_KEY, JSON.stringify(items.slice(-100))); } catch (error) { /* cache opcional */ }
  };

  const queueBillResolution = (requestId) => {
    if (!requestId || !state.currentTable?.id) return;
    const outbox = readBillResolutionOutbox();
    if (!outbox.some((item) => item.request_id === requestId)) {
      outbox.push({
        request_id: requestId,
        table_id: state.currentTable.id,
        table_access_code: tableCode(state.currentTable),
        attempts: 0,
        next_attempt_at: 0
      });
      writeBillResolutionOutbox(outbox);
    }
    window.clearTimeout(state.billResolutionTimer);
    state.billResolutionTimer = window.setTimeout(flushBillResolutionOutbox, 40);
  };

  const flushBillResolutionOutbox = async () => {
    if (state.billResolutionBusy || !navigator.onLine || !state.sb) return;
    const now = Date.now();
    const outbox = readBillResolutionOutbox();
    const event = outbox.find((item) => Number(item.next_attempt_at || 0) <= now);
    if (!event) {
      const next = outbox.reduce((time, item) => Math.min(time, Number(item.next_attempt_at || Infinity)), Infinity);
      if (Number.isFinite(next)) state.billResolutionTimer = window.setTimeout(flushBillResolutionOutbox, Math.max(250, next - now));
      return;
    }
    state.billResolutionBusy = true;
    try {
      let saved = await dbQuiet(state.sb.rpc("resolveBill", event), null);
      if (!saved && state.currentTable?.id === event.table_id) {
        saved = await dbQuiet(
          state.sb.from("service_requests")
            .update({ status: "resolved", resolved_at: new Date().toISOString() })
            .eq("id", event.request_id)
            .select("*")
            .single(),
          null
        );
      }
      const nextOutbox = readBillResolutionOutbox().flatMap((item) => {
        if (item.request_id !== event.request_id) return [item];
        if (saved) return [];
        const attempts = Number(item.attempts || 0) + 1;
        return [{ ...item, attempts, next_attempt_at: Date.now() + Math.min(30000, 500 * Math.pow(2, Math.min(attempts, 6))) }];
      });
      writeBillResolutionOutbox(nextOutbox);
    } finally {
      state.billResolutionBusy = false;
      if (readBillResolutionOutbox().length) {
        window.clearTimeout(state.billResolutionTimer);
        state.billResolutionTimer = window.setTimeout(flushBillResolutionOutbox, 350);
      }
    }
  };

  const billDateParts = (value) => {
    const date = new Date(value || Date.now());
    return {
      date: date.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }).replace(".", ""),
      time: date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    };
  };

  const playReceiptSound = async (requestId) => {
    if (!requestId || localStorage.getItem(`receipt_sound_${requestId}`) === "1") return;
    const audio = new Audio(RECEIPT_SOUND);
    audio.volume = 1;
    try {
      await audio.play();
      localStorage.setItem(`receipt_sound_${requestId}`, "1");
    } catch (error) {
      // Browsers can block audio until the client interacts with the page.
    }
  };

  const playClientChatReceipt = async (messageId) => {
    if (!messageId) return;
    const audio = new Audio(RECEIPT_SOUND);
    audio.volume = 1;
    try {
      await audio.play();
    } catch (error) {
      // Browsers can block audio until the client interacts with the page.
    }
  };

  const playAdminChatReceipt = async () => {
    if (!state.soundEnabled) return;
    const audio = new Audio(RECEIPT_SOUND);
    audio.volume = 1;
    try {
      await audio.play();
    } catch (error) {
      // El navegador puede bloquear el sonido hasta que se active la alarma.
    }
  };

  const latestClientBill = () =>
    state.clientRequests.find(
      (request) =>
        request.request_type === "bill" &&
        request.status === "acknowledged" &&
        state.billReceiptArmedIds.has(request.id) &&
        pendingBillIds().includes(request.id) &&
        request.session_id === state.currentSession?.id &&
        request.table_id === state.currentTable?.id &&
        parseBillMessage(request.message)
    );

  const renderBillChat = () => {
    const box = $("#billChat");
    if (!box) return;
    if (box.classList.contains("is-closing")) return;
    const isLocalBill = state.localBillOpen && Boolean(state.currentTable);
    const localSession = isLocalBill ? {
      ...(state.currentSession || {}),
      id: state.currentSession?.id || state.currentTable.id,
      restaurant_tables: state.currentTable,
      session_items: state.sessionItems
    } : null;
    const request = isLocalBill
      ? {
          id: localSession.id,
          status: "current",
          created_at: new Date().toISOString(),
          table_id: state.currentTable.id,
          session_id: state.currentSession?.id || null
        }
      : latestClientBill();
    const bill = isLocalBill
      ? parseBillMessage(buildBillMessage(localSession))
      : parseBillMessage(request?.message);
    if (!request || !bill) {
      document.body.classList.remove("receipt-open");
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    if (!isLocalBill) playReceiptSound(request.id);
    const sent = billDateParts(bill.sent_at || request.acknowledged_at || request.created_at);
    box.hidden = false;
    box.classList.remove("is-closing");
    document.body.classList.add("receipt-open");
    box.innerHTML = `
      <div class="client-receipt-overlay" role="presentation">
        <article class="client-receipt-ticket" role="dialog" aria-modal="true" aria-label="${isLocalBill ? "Cuenta actual" : "Cuenta enviada"}" data-receipt-id="${escapeHTML(request.id)}">
          <div class="receipt-confetti">✓</div>
          <h2>${isLocalBill ? "Tu cuenta" : request.status === "resolved" ? "Gracias" : "Cuenta lista"}</h2>
          <p>${isLocalBill ? `Consumos registrados actualmente en ${escapeHTML(tableLabel(state.currentTable))}.` : request.status === "resolved" ? "Tu confirmación fue recibida correctamente." : "El equipo envió el recibo de tu mesa."}</p>

          <div class="receipt-dash"></div>

          <div class="receipt-ticket-grid">
            <div>
              <span>Ticket ID</span>
              <strong>${billTicketId(request)}</strong>
            </div>
            <div>
              <span>Total</span>
              <strong>${money(bill.total, bill.currency)}</strong>
            </div>
            <div>
              <span>Fecha y hora</span>
              <strong>${sent.date} | ${sent.time}</strong>
            </div>
            <div>
              <span>Mesa</span>
              <strong>${escapeHTML(bill.table || tableLabel(state.currentTable))}</strong>
            </div>
            ${bill.payer_name ? `<div><span>Responsable</span><strong>${escapeHTML(bill.payer_name)}</strong></div>` : ""}
            ${bill.waiter_name ? `<div><span>Atendido por</span><strong>${escapeHTML(bill.waiter_name)}</strong></div>` : ""}
          </div>

          <div class="receipt-method">
            <span>${icon("beer", 20)}</span>
            <div>
              <strong>${escapeHTML(bill.business_name || "Restaurante")}</strong>
              <small>${isLocalBill ? "Cuenta actualizada de tu mesa" : "Recibo enviado por administración"}</small>
            </div>
          </div>

          <div class="receipt-lines client-ticket-lines">
            ${(bill.items || [])
              .map(
                (item) => `
                  <div>
                    <span>${Number(item.quantity || 0)}x ${escapeHTML(item.name)}</span>
                    <strong>${money(item.total, bill.currency)}</strong>
                  </div>
                `
              )
              .join("") || "<small>Sin consumos registrados</small>"}
            <div><span>Subtotal</span><strong>${money(bill.subtotal, bill.currency)}</strong></div>
            ${Number(bill.discount || 0) ? `<div><span>Descuento</span><strong>-${money(bill.discount, bill.currency)}</strong></div>` : ""}
            ${Number(bill.tax || 0) ? `<div><span>Impuestos</span><strong>${money(bill.tax, bill.currency)}</strong></div>` : ""}
            ${Number(bill.service_fee || 0) ? `<div><span>Servicio</span><strong>${money(bill.service_fee, bill.currency)}</strong></div>` : ""}
          </div>

          <div class="receipt-barcode" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span><span></span>
            <small>${String(request.id || "").replace(/-/g, "").slice(0, 22)}</small>
          </div>

          ${
            isLocalBill
              ? `<button class="primary thank-btn receipt-thanks" data-close-bill>${icon("x", 16)} Cerrar</button>`
              : request.status === "resolved"
                ? `<div class="receipt-confirmed">${icon("badge-check", 17)} Confirmado</div>`
                : `<button class="primary thank-btn receipt-thanks" data-thank-bill="${request.id}">${icon("send", 16)} Gracias</button>`
          }
          <div class="receipt-cutout-row" aria-hidden="true"></div>
        </article>
      </div>
    `;
    refreshIcons();
    window.requestAnimationFrame(() => box.querySelector(".receipt-thanks")?.focus({ preventScroll: true }));
  };

  const showCurrentBill = async () => {
    if (!state.currentTable) {
      toast("Selecciona tu mesa primero.", "error");
      return;
    }
    const button = document.querySelector('[data-request="bill"]');
    button?.classList.add("is-pending");
    try {
      await hydrateSelectedTable(state.currentTable.id);
      state.localBillOpen = true;
      renderBillChat();
    } finally {
      button?.classList.remove("is-pending");
    }
  };

  const normalizeText = (text = "") =>
    String(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const escapeHTML = (value = "") =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));

  const readLocalJson = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value ?? fallback;
    } catch (error) {
      return fallback;
    }
  };

  function applyBusinessTipSettings() {
    if (!state.business || !Object.prototype.hasOwnProperty.call(state.business, "tips_enabled")) return false;
    const percentage = Math.min(100, Math.max(1, Number(state.business.tip_percentage || 10)));
    state.tipSettings = {
      enabled: state.business.tips_enabled === true,
      percentage: Number.isFinite(percentage) ? percentage : 10
    };
    try { localStorage.setItem(TIP_SETTINGS_STORAGE_KEY, JSON.stringify(state.tipSettings)); } catch (error) { /* Respaldo local opcional. */ }
    return true;
  }

  const productAcronym = (name = "") => normalizeText(name)
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

  const loadInventoryStore = () => {
    const stored = readLocalJson(INVENTORY_STORAGE_KEY, {});
    state.inventoryMeta = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const invoices = readLocalJson(INVOICE_STORAGE_KEY, []);
    state.invoiceHistory = Array.isArray(invoices) ? invoices : [];
    const movements = readLocalJson(INVENTORY_MOVEMENTS_STORAGE_KEY, []);
    state.inventoryMovements = Array.isArray(movements) ? movements : [];
    const storedTips = readLocalJson(TIP_SETTINGS_STORAGE_KEY, {});
    const storedPercentage = Math.min(100, Math.max(1, Number(storedTips?.percentage || 10)));
    state.tipSettings = { enabled: storedTips?.enabled === true, percentage: Number.isFinite(storedPercentage) ? storedPercentage : 10 };
    applyBusinessTipSettings();
    state.tipSplitPeople = Math.min(100, Math.max(1, Number(localStorage.getItem(TIP_SPLIT_STORAGE_KEY) || 1)));
    const clearedTips = readLocalJson(TIP_RESET_STORAGE_KEY, []);
    state.clearedTipInvoiceKeys = new Set(Array.isArray(clearedTips) ? clearedTips.map(String) : []);
    if (state.page === "admin") loadWalkInDrafts();
  };

  const isLocalWalkInSession = (session) => session?.sale_channel === "walk_in"
    && (session?.local_only === true || String(session?.id || "").startsWith("walk-in-"));

  function loadWalkInDrafts() {
    const stored = readLocalJson(WALK_IN_DRAFTS_STORAGE_KEY, []);
    const drafts = (Array.isArray(stored) ? stored : [])
      .filter((session) => isLocalWalkInSession(session) && session.status === "open")
      .map((session) => ({ ...session, local_only: true, restaurant_tables: null, session_items: Array.isArray(session.session_items) ? session.session_items : [] }));
    state.sessions = [
      ...drafts,
      ...state.sessions.filter((session) => !isLocalWalkInSession(session))
    ];
    drafts.forEach((session) => state.optimisticSessionStates.set(session.id, {
      mode: "upsert",
      localOnly: true,
      session
    }));
  }

  const persistWalkInDrafts = () => {
    const drafts = state.sessions
      .filter((session) => isLocalWalkInSession(session) && session.status === "open")
      .slice(0, 50);
    try {
      localStorage.setItem(WALK_IN_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
    } catch (error) {
      toast("No se pudo conservar el borrador de la venta individual en este equipo.", "error", "walk-in-storage-failed");
    }
  };

  const persistInventoryStore = () => {
    try {
      localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(state.inventoryMeta));
    } catch (error) {
      toast("No se pudo guardar el inventario en este dispositivo.", "error", "inventory-storage-failed");
    }
  };

  const persistInvoiceHistory = () => {
    try {
      localStorage.setItem(INVOICE_STORAGE_KEY, JSON.stringify(state.invoiceHistory.slice(-1000)));
    } catch (error) {
      toast("La venta se cerro, pero no se pudo guardar el historial local.", "error", "invoice-storage-failed");
    }
  };

  const persistTipSettings = () => {
    try {
      localStorage.setItem(TIP_SETTINGS_STORAGE_KEY, JSON.stringify(state.tipSettings));
    } catch (error) {
      toast("No se pudo guardar la configuración de propina en este equipo.", "error", "tip-settings-storage-failed");
    }
  };

  const tipInvoiceKey = (invoice) => String(invoice?.id || invoice?.sessionId || invoice?.number || "");

  const persistClearedTipInvoices = () => {
    try {
      localStorage.setItem(TIP_RESET_STORAGE_KEY, JSON.stringify([...state.clearedTipInvoiceKeys]));
    } catch (error) {
      toast("No se pudo reiniciar las propinas en este equipo.", "error", "tip-reset-storage-failed");
    }
  };

  const persistInventoryMovements = () => {
    try {
      const recent = [...state.inventoryMovements]
        .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
        .slice(0, 3000);
      localStorage.setItem(INVENTORY_MOVEMENTS_STORAGE_KEY, JSON.stringify(recent));
    } catch (error) { /* Historial remoto y memoria siguen disponibles. */ }
  };

  const recordLocalInventoryMovement = ({ eventId = uid(), item, delta, before, after, type, reference = "", occurredAt = new Date().toISOString(), user = "" }) => {
    const numericDelta = Number(delta || 0);
    const isNewProduct = String(type || "").toUpperCase() === "NUEVO_PRODUCTO";
    if (!item || !Number.isFinite(numericDelta) || (!numericDelta && !isNewProduct) || state.inventoryMovements.some((movement) => movement.movementId === eventId)) return null;
    const movement = {
      movementId: eventId,
      productId: item.id,
      code: inventoryFor(item).code,
      product: item.name || "Producto",
      type: type || (delta > 0 ? "ENTRADA_MANUAL" : "SALIDA_MANUAL"),
      delta: numericDelta,
      before: Number(before || 0),
      after: Number(after || 0),
      reference,
      date: occurredAt,
      user: user || state.currentUser?.full_name || state.currentUser?.username || "Sistema"
    };
    state.inventoryMovements.push(movement);
    persistInventoryMovements();
    if (state.activeAdminSection === "movements") renderInventoryMovements();
    return movement;
  };

  const inventoryFor = (item) => {
    const meta = state.inventoryMeta[item?.id] || {};
    return {
      code: String(meta.code || productAcronym(item?.name)).toUpperCase(),
      costPrice: Math.max(0, Number(meta.costPrice || 0)),
      stock: Math.max(0, Number(meta.stock || 0)),
      minStock: Math.max(0, Number(meta.minStock ?? 5)),
      unit: meta.unit || "unidad",
      updatedAt: meta.updatedAt || "",
      version: Math.max(0, Number(meta.version || 0))
    };
  };

  const inventoryStatus = (item) => {
    const inventory = inventoryFor(item);
    if (inventory.stock <= 0) return "out";
    if (inventory.stock <= inventory.minStock) return "low";
    return "ok";
  };

  const productSearchScore = (item, rawQuery = "") => {
    const query = normalizeText(rawQuery).replace(/\s+/g, "");
    if (!query) return Number(item.sort_order || 0);
    const name = normalizeText(item.name || "");
    const compactName = name.replace(/\s+/g, "");
    const words = name.split(" ").filter(Boolean);
    const code = normalizeText(inventoryFor(item).code).replace(/\s+/g, "");
    const acronym = normalizeText(productAcronym(item.name)).replace(/\s+/g, "");
    if (query === code || query === acronym) return 0;
    if (compactName === query) return 1;
    if (code.startsWith(query) || acronym.startsWith(query)) return 5;
    if (words.some((word) => word.startsWith(query))) return 10;
    if (compactName.startsWith(query)) return 15;
    if (compactName.includes(query) || code.includes(query)) return 25;
    const initialsMatch = query.split("").every((letter, index) => acronym[index] === letter);
    return initialsMatch ? 30 : Number.POSITIVE_INFINITY;
  };

  const matchingProducts = (query = "", { includeUnavailable = false } = {}) => state.items
    .filter((item) => includeUnavailable || item.is_available !== false)
    .map((item) => ({ item, score: productSearchScore(item, query) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || String(left.item.name).localeCompare(String(right.item.name), "es"))
    .map((entry) => entry.item);

  const paymentMethodLabel = (method) => ({
    cash: "Efectivo",
    transfer: "Transferencia",
    breb: "Bre-B",
    mixed: "Pago mixto"
  }[method] || "Pago");

  const openCashDrawer = async () => {
    const bridge = window.posCashDrawer;
    const status = $("#cashDrawerStatus");
    if (!bridge || typeof bridge.open !== "function") {
      if (status) status.textContent = "No se detecto un puente local compatible con el cajon.";
      toast("El cajón no está configurado en este equipo. Revisa la conexión del cajón con el punto de venta.", "error", "cash-drawer-unavailable");
      return false;
    }
    try {
      const result = await bridge.open({ source: "tienda-napoles-pos", requestedAt: new Date().toISOString() });
      if (result === false) throw new Error("El controlador rechazo la apertura.");
      if (status) status.textContent = "Orden de apertura enviada correctamente.";
      toast("Orden de apertura enviada al cajon.", "ok", "cash-drawer-opened");
      return true;
    } catch (error) {
      if (status) status.textContent = "El controlador no pudo abrir el cajon.";
      toast(String(error?.message || "No se pudo abrir el cajon."), "error", "cash-drawer-failed");
      return false;
    }
  };

  const getAppsScriptUrl = () => String(APPS_SCRIPT_CONFIG.webAppUrl || "").trim();

  const isAppsScriptConfigured = () => /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(getAppsScriptUrl());

  const setInventorySyncStatus = (message, tone = "local", iconName = "hard-drive") => {
    const badge = $("#inventorySyncStatus");
    if (!badge) return;
    badge.className = `inventory-sync-status is-${tone}`;
    badge.innerHTML = `${icon(iconName, 15)} ${escapeHTML(message)}`;
    refreshIcons();
  };

  const readAppsScriptOutbox = () => {
    const stored = readLocalJson(APPS_SCRIPT_OUTBOX_KEY, []);
    return Array.isArray(stored) ? stored : [];
  };

  const writeAppsScriptOutbox = (jobs) => {
    try { localStorage.setItem(APPS_SCRIPT_OUTBOX_KEY, JSON.stringify(jobs.slice(-2000))); } catch (error) { /* Cache operativa. */ }
  };

  const initRemoteStorage = () => {
    if (!isAppsScriptConfigured()) {
      setInventorySyncStatus("Configura el respaldo remoto", "local", "hard-drive");
      return false;
    }
    setInventorySyncStatus("Conectando respaldo remoto", "pending", "refresh-cw");
    void bootstrapRemoteStorage();
    return true;
  };

  const appsScriptRequest = async (action, payload = {}, timeoutMs = APPS_SCRIPT_TIMEOUT_MS, operationId = "") => {
    if (!isAppsScriptConfigured()) throw new Error("El respaldo remoto no esta configurado.");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(getAppsScriptUrl(), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action,
          operationId,
          authToken: state.authToken,
          origin: location.origin,
          payload
        }),
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`El respaldo remoto respondio con estado ${response.status}.`);
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch (error) {
        throw transientAppsScriptError("La respuesta del respaldo remoto todavía se está confirmando.");
      }
      return result || { ok: false, error: "Respuesta vacia del respaldo remoto." };
    } catch (error) {
      if (error?.name === "AbortError") throw transientAppsScriptError("La sincronización remota continúa en segundo plano.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const inventoryPayload = (item) => {
    const inventory = inventoryFor(item);
    return {
      productId: item.id,
      code: inventory.code,
      name: item.name || "",
      category: item.menu_categories?.name || "",
      unit: inventory.unit,
      costPrice: inventory.costPrice,
      salePrice: Number(item.price || 0),
      stock: inventory.stock,
      minStock: inventory.minStock,
      isAvailable: item.is_available !== false,
      updatedAt: inventory.updatedAt || new Date().toISOString(),
      version: inventory.version
    };
  };

  const applyRemoteInventoryItems = (items = [], { replace = false } = {}) => {
    if (!Array.isArray(items)) return;
    if (replace) {
      const remoteIds = new Set(items.map((item) => String(item?.productId || "")).filter(Boolean));
      Object.keys(state.inventoryMeta).forEach((productId) => {
        if (!remoteIds.has(String(productId))) delete state.inventoryMeta[productId];
      });
    }
    items.forEach((remote) => {
      const item = state.items.find((entry) => entry.id === remote.productId);
      if (!item) return;
      state.inventoryMeta[item.id] = {
        code: String(remote.code || productAcronym(item.name)).toUpperCase(),
        costPrice: Math.max(0, Number(remote.costPrice || 0)),
        stock: Math.max(0, Number(remote.stock || 0)),
        minStock: Math.max(0, Number(remote.minStock || 0)),
        unit: remote.unit || "unidad",
        updatedAt: remote.updatedAt || new Date().toISOString(),
        version: Number(remote.version || 0)
      };
      if (Number.isFinite(Number(remote.salePrice))) item.price = Math.max(0, Number(remote.salePrice));
      if (typeof remote.isAvailable === "boolean") item.is_available = remote.isAvailable;
    });
    persistInventoryStore();
    persistBootstrapCache();
    renderInventory();
    renderMenuManager();
  };

  const enqueueAppsScriptJob = (action, payload, dedupeKey = uid()) => {
    const jobs = readAppsScriptOutbox();
    const job = {
      id: uid(),
      action,
      payload,
      dedupeKey,
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    const existingIndex = jobs.findIndex((entry) => entry.dedupeKey === dedupeKey);
    if (existingIndex >= 0 && ["upsert_inventory", "set_inventory_stock"].includes(action)) jobs[existingIndex] = job;
    else if (existingIndex < 0) jobs.push(job);
    writeAppsScriptOutbox(jobs);
    if (isAppsScriptConfigured()) void flushAppsScriptOutbox();
    else setInventorySyncStatus(`${jobs.length} cambio${jobs.length === 1 ? "" : "s"} en cola local`, "local", "hard-drive");
  };

  const scheduleAppsScriptRetry = () => {
    clearTimeout(state.appsScriptOutboxTimer);
    state.appsScriptOutboxTimer = window.setTimeout(flushAppsScriptOutbox, 30000);
  };

  const flushAppsScriptOutbox = async () => {
    if (state.appsScriptOutboxBusy || !isAppsScriptConfigured() || !navigator.onLine) return false;
    state.appsScriptOutboxBusy = true;
    try {
      let jobs = readAppsScriptOutbox();
      while (jobs.length) {
        const job = jobs[0];
        setInventorySyncStatus(`Sincronizando ${jobs.length} pendiente${jobs.length === 1 ? "" : "s"}`, "pending", "refresh-cw");
        const result = await appsScriptRequest(job.action, job.payload, APPS_SCRIPT_TIMEOUT_MS, job.id);
        const queuedAfterRequest = readAppsScriptOutbox();
        const pendingAfterCurrent = queuedAfterRequest.filter((entry) => entry.id !== job.id);
        const pendingProductIds = new Set(pendingAfterCurrent.map((entry) =>
          entry.action === "upsert_inventory"
            ? entry.payload?.item?.productId
            : entry.action === "adjust_inventory"
              ? entry.payload?.adjustment?.productId
              : entry.action === "set_inventory_stock"
                ? entry.payload?.productId
              : ""
        ).filter(Boolean));
        const applyFreshRemoteInventory = () => {
          const remoteItems = job.action === "upsert_inventory" && result?.item
            ? [result.item]
            : result?.items || (result?.item ? [result.item] : []);
          const freshItems = remoteItems.filter((item) => !pendingProductIds.has(item.productId));
          if (freshItems.length) applyRemoteInventoryItems(freshItems);
        };
        if (!result?.ok) {
          const legacyInventoryService = job.action === "adjust_inventory"
            && /accion no permitida:\s*adjust_inventory/i.test(normalizeText(result?.error || ""));
          if (result?.retryable === false || legacyInventoryService) {
            if (result.item) applyFreshRemoteInventory();
            jobs = pendingAfterCurrent;
            writeAppsScriptOutbox(jobs);
            toast(
              legacyInventoryService
                ? `El inventario se conciliara al cerrar la mesa. Publica la actualizacion ${APPS_SCRIPT_REQUIRED_VERSION} para sincronizar cada consumo de inmediato.`
                : (result.error || "No se pudo aplicar un movimiento de inventario."),
              "error",
              legacyInventoryService ? "inventory-service-update-required" : `inventory-job-rejected:${job.id}`
            );
            continue;
          }
          const currentIndex = queuedAfterRequest.findIndex((entry) => entry.id === job.id);
          if (currentIndex < 0) {
            jobs = queuedAfterRequest;
            continue;
          }
          job.attempts = Number(job.attempts || 0) + 1;
          job.lastError = result?.error || "El respaldo remoto no respondio";
          job.lastAttemptAt = new Date().toISOString();
          jobs = queuedAfterRequest;
          jobs[currentIndex] = job;
          writeAppsScriptOutbox(jobs);
          setInventorySyncStatus(`${jobs.length} pendiente${jobs.length === 1 ? "" : "s"}; reintento automatico`, "error", "cloud-off");
          scheduleAppsScriptRetry();
          return false;
        }
        applyFreshRemoteInventory();
        jobs = pendingAfterCurrent;
        writeAppsScriptOutbox(jobs);
      }
      setInventorySyncStatus("Inventario sincronizado", "synced", "cloud-check");
      return true;
    } catch (error) {
      setInventorySyncStatus("Sin conexion; cambios protegidos localmente", "error", "cloud-off");
      scheduleAppsScriptRetry();
      return false;
    } finally {
      state.appsScriptOutboxBusy = false;
    }
  };

  const bootstrapRemoteStorage = async () => {
    if (!isAppsScriptConfigured() || !state.currentUser) return false;
    if (state.currentUser.role !== "admin") {
      void (async () => {
        await flushAppsScriptOutbox();
        if (!readAppsScriptOutbox().length) await syncInventoryWithAppsScript();
      })();
      return true;
    }
    setInventorySyncStatus("Preparando respaldo remoto", "pending", "refresh-cw");
    try {
      const result = await appsScriptRequest("bootstrap", {
        supabaseUrl: SUPABASE_CONFIG.url,
        supabaseAnonKey: SUPABASE_CONFIG.anonKey
      });
      if (!result?.ok) throw new Error(result?.error || "No fue posible inicializar el respaldo remoto.");
      if (!isAppsScriptVersionCompatible(result.version)) {
        toast(`Publica Code.gs ${APPS_SCRIPT_REQUIRED_VERSION} para activar movimientos, correcciones y reinicios completos.`, "error", "appscript-version-required");
      }
      setInventorySyncStatus("Respaldo remoto listo", "synced", "cloud-check");
      await flushAppsScriptOutbox();
      if (!readAppsScriptOutbox().length) await syncInventoryWithAppsScript();
      return true;
    } catch (error) {
      if (isTransientAppsScriptError(error)) {
        setInventorySyncStatus("Sincronización remota en segundo plano", "pending", "refresh-cw");
        return false;
      }
      setInventorySyncStatus("Respaldo pendiente de configuracion", "error", "cloud-off");
      toast(String(error?.message || "No fue posible preparar el respaldo remoto."), "error", "remote-bootstrap-failed");
      return false;
    }
  };

  const syncInventoryWithAppsScript = async () => {
    if (!isAppsScriptConfigured() || !state.currentUser) return false;
    try {
      const result = await appsScriptRequest("get_inventory");
      if (!result?.ok) throw new Error(result?.error || "No se pudo consultar el inventario.");
      if (!Array.isArray(result.items)) throw new Error("El inventario remoto devolvio una respuesta invalida.");
      applyRemoteInventoryItems(result.items, { replace: true });
      setInventorySyncStatus("Inventario sincronizado", "synced", "cloud-check");
      return true;
    } catch (error) {
      setInventorySyncStatus("Usando respaldo local", "error", "cloud-off");
      return false;
    }
  };

  const queueInventoryUpsert = (item, movement = {}) => {
    if (!item) return;
    enqueueAppsScriptJob("upsert_inventory", {
      item: { ...inventoryPayload(item), ...movement }
    }, `inventory:${item.id}`);
  };

  const applyConsumptionInventoryDelta = (item, delta, context = {}) => {
    const change = Number(delta || 0);
    if (!item || !change || !Object.prototype.hasOwnProperty.call(state.inventoryMeta, item.id)) return null;
    const current = inventoryFor(item);
    const nextStock = current.stock + change;
    if (nextStock < 0) return null;
    state.inventoryMeta[item.id] = {
      ...current,
      stock: nextStock,
      updatedAt: new Date().toISOString()
    };
    persistInventoryStore();
    const eventId = context.eventId || `consumption-stock:${uid()}`;
    recordLocalInventoryMovement({
      eventId,
      item,
      delta: change,
      before: current.stock,
      after: nextStock,
      type: context.movementType || (change < 0 ? "CONSUMO_MESA" : "DEVOLUCION_CONSUMO"),
      reference: context.reference || ""
    });
    enqueueAppsScriptJob("adjust_inventory", {
      adjustment: {
        eventId,
        productId: item.id,
        code: current.code,
        name: item.name || "Producto",
        delta: change,
        sessionId: context.sessionId || "",
        reference: context.reference || "",
        movementType: context.movementType || "",
        reversesEventId: context.reversesEventId || "",
        occurredAt: new Date().toISOString()
      }
    }, `inventory-adjust:${eventId}`);
    if (state.activeAdminSection === "inventory") renderInventory();
    return { item, delta: change, eventId };
  };

  const includesAny = (normalized, phrases = []) =>
    phrases.some((phrase) => normalized.includes(normalizeText(phrase)));

  const assistantUnderstands = (normalized, intent) =>
    includesAny(normalized, ASSISTANT_INTENTS[intent] || []);

  const sentenceCase = (text = "") => {
    const clean = String(text).trim().replace(/\s+/g, " ");
    if (!clean) return "";
    const sentence = clean.charAt(0).toUpperCase() + clean.slice(1);
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  };

  const polishGuestText = (text = "") => {
    const replacements = [
      [/\bcoctel(es)?\b/gi, (match) => match.toLowerCase().endsWith("es") ? "cócteles" : "cóctel"],
      [/\bcerbeza(s)?\b/gi, (match) => match.toLowerCase().endsWith("s") ? "cervezas" : "cerveza"],
      [/\bwhiskey\b/gi, "whisky"],
      [/\bmenu\b/gi, "menú"],
      [/\bpor favor\b/gi, "por favor"],
      [/\bq\b/gi, "que"],
      [/\bxfa\b/gi, "por favor"]
    ];
    const polished = replacements.reduce(
      (value, [pattern, replacement]) => value.replace(pattern, replacement),
      String(text).trim().replace(/\s+/g, " ")
    );
    return sentenceCase(polished);
  };

  const assistantMenuSummary = () => {
    const names = assistantOptions().slice(0, 6).map((item) => item.name);
    return names.join(", ");
  };

  const findQuantityWord = (normalized) => {
    const words = normalized.split(" ");
    const found = words.find((word) => ASSISTANT_NUMBER_WORDS[word]);
    return found ? ASSISTANT_NUMBER_WORDS[found] : null;
  };

  const assistantOptions = () => BAR_ASSISTANT_OPTIONS;

  const findAssistantItem = (message) => {
    const normalized = normalizeText(message);
    let best = null;
    assistantOptions().forEach((item) => {
      [item.name, ...(item.aliases || [])].forEach((candidate) => {
        const normalizedCandidate = normalizeText(candidate);
        const words = normalizedCandidate.split(" ").filter((word) => word.length > 2);
        const overlap = words.reduce((sum, word) => sum + (normalized.includes(word) ? 1 : 0), 0) / Math.max(words.length, 1);
        const score = normalized.includes(normalizedCandidate) ? 1 + words.length / 100 : overlap;
        if (score >= .6 && (!best || score > best.score)) best = { item, score };
      });
    });
    return best?.item || null;
  };

  const parseAssistantOrder = (message) => {
    const item = findAssistantItem(message);
    if (!item) return null;
    const normalized = normalizeText(message);
    const numericQuantity = [...normalized.matchAll(/\b(\d+)\b/g)]
      .map((match) => Number(match[1]))
      .find((value) => value >= 1 && value <= 20);
    const quantity = Math.max(1, Number(numericQuantity || findQuantityWord(normalized) || 1));
    return { item, quantity };
  };

  const assistantSay = (role, text) => {
    const thread = state.assistantThreads[state.assistantMode] || [];
    thread.push({ role, text, local: true, created_at: new Date().toISOString() });
    state.assistantThreads[state.assistantMode] = thread.slice(-40);
    state.assistantMessages = state.assistantThreads[state.assistantMode];
    renderAssistant();
  };

  const renderAssistant = () => {
    const chat = $("#assistantChat");
    const suggestions = $("#assistantSuggestions");
    if (!chat || !suggestions) return;
    const songMode = state.assistantMode === "song";
    const eyebrow = $("#assistantEyebrow");
    const title = $("#assistantTitle");
    const modeIcon = $("#assistantModeIcon");
    const input = $("#assistantInput");
    const toggle = $("#songModeToggle");
    if (eyebrow) eyebrow.textContent = songMode ? "Música para tu mesa" : "Agente de bar";
    if (title) title.innerHTML = `<span class="assistant-live-dot" aria-hidden="true"></span>${songMode ? "Pide una canción" : "Pide por chat"}`;
    if (modeIcon) modeIcon.innerHTML = icon(songMode ? "music-2" : "bot", 24);
    if (input) input.placeholder = songMode
      ? "Nombre exacto de la canción y artista"
      : "Ej: Quiero una canasta de cerveza";
    if (toggle) {
      toggle.classList.toggle("is-active", songMode);
      toggle.innerHTML = songMode ? `${icon("message-circle", 22)}<span>Volver al chat</span>` : `${icon("music-2", 22)}<span>Pedir canción</span>`;
    }
    const activeThread = (state.assistantThreads[state.assistantMode] || [])
      .filter((message) => songMode || !state.adminChatActive || message.role !== "bot");
    const serverMessages = !songMode ? state.chatMessages.map((message) => ({
      role: message.sender_type === "client" ? "user" : message.sender_type === "staff" ? "staff" : "system",
      text: message.body,
      created_at: message.created_at
    })) : [];
    const hasJoinNotice = serverMessages.some((message) => message.role === "system" && normalizeText(message.text).includes("se unio al chat"));
    const localJoinNotice = !songMode && state.adminChatActive && state.adminChatNotice && !hasJoinNotice
      ? [{ role: "system", text: state.adminChatNotice, local: true, created_at: new Date().toISOString() }]
      : [];
    const messages = [...serverMessages, ...activeThread, ...localJoinNotice].filter((message, index, values) => !message.local || !values.some((candidate) => !candidate.local && candidate.text === message.text && candidate.role === message.role));
    const visibleMessages = messages.length
      ? messages
      : [{
          role: "bot",
          text: songMode
            ? "Escribe el nombre exacto de la canción y, si lo conoces, también el artista. Enviaremos tu solicitud al equipo."
            : "Hola, soy tu agente de bar. Dime qué deseas pedir y enviaré la solicitud al mesero para que confirme contigo los detalles."
        }];
    chat.innerHTML = visibleMessages
      .map((message) => `<div class="assistant-message ${message.role}">${message.role === "staff" ? `<small>Administrador</small>` : ""}${escapeHTML(message.text)}</div>`)
      .join("");
    chat.scrollTop = chat.scrollHeight;
    if (songMode) {
      suggestions.innerHTML = `<span class="assistant-song-hint">${icon("music", 16)} Ejemplo: Nombre de la canción — Artista</span>`;
    } else {
      const suggestionTexts = ["Deseo una cerveza", "Deseo cigarrillo", "Deseo un producto diferente"];
      suggestions.innerHTML = suggestionTexts
        .map((text) => `<button type="button" class="chip" data-assistant-suggest="${escapeHTML(text)}">${escapeHTML(text)}</button>`)
        .join("");
    }
    refreshIcons();
  };

  const activateSongRequestMode = () => {
    state.assistantMode = state.assistantMode === "song" ? "bar" : "song";
    if (state.assistantMode === "song" && !state.assistantThreads.song.length) state.assistantThreads.song = [{ role: "bot", text: "Escribe el nombre exacto de la canción y el artista para solicitarla.", local: true }];
    state.assistantMessages = state.assistantThreads[state.assistantMode];
    renderAssistant();
    $(".assistant-panel")?.scrollIntoView({ block: "center", behavior: "auto" });
    window.requestAnimationFrame(() => $("#assistantInput")?.focus({ preventScroll: true }));
  };

  const prettyDateTime = (value) => new Date(value || Date.now()).toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).replace(".", "");

  const REQUEST_OUTBOX_KEY = "la_licorera_17_request_outbox_v2";

  const readRequestOutbox = () => {
    try {
      const value = JSON.parse(localStorage.getItem(REQUEST_OUTBOX_KEY) || "[]");
      const stored = Array.isArray(value) ? value : [];
      const merged = new Map([...state.requestOutboxMemory, ...stored].map((item) => [item.request_id, item]));
      return Array.from(merged.values()).filter((item) => item.request_type !== "bill");
    } catch (error) {
      return state.requestOutboxMemory.filter((item) => item.request_type !== "bill");
    }
  };

  const writeRequestOutbox = (items) => {
    state.requestOutboxMemory = items.slice(-5000);
    try {
      localStorage.setItem(REQUEST_OUTBOX_KEY, JSON.stringify(state.requestOutboxMemory));
    } catch (error) {
      // La UI permanece operativa; el intento en memoria sigue ejecutandose.
    }
  };

  const queueServiceRequest = (event) => {
    const outbox = readRequestOutbox();
    if (!outbox.some((item) => item.request_id === event.request_id)) {
      outbox.push({ ...event, attempts: 0, next_attempt_at: 0 });
      writeRequestOutbox(outbox);
    }
    window.clearTimeout(state.requestOutboxTimer);
    state.requestOutboxTimer = window.setTimeout(flushRequestOutbox, 0);
  };

  const flushRequestOutbox = async () => {
    if (state.requestOutboxBusy || !navigator.onLine) return;
    const now = Date.now();
    const outbox = readRequestOutbox();
    const due = outbox.filter((item) => Number(item.next_attempt_at || 0) <= now).slice(0, 30);
    if (!due.length) {
      const next = outbox.reduce((time, item) => Math.min(time, Number(item.next_attempt_at || Infinity)), Infinity);
      if (Number.isFinite(next)) {
        window.clearTimeout(state.requestOutboxTimer);
        state.requestOutboxTimer = window.setTimeout(flushRequestOutbox, Math.max(250, next - now));
      }
      return;
    }

    state.requestOutboxBusy = true;
    let results = null;
    try {
      const batch = await dbQuiet(
        state.sb.rpc("createServiceRequestsBatch", {
          requests: due.map(({ attempts, next_attempt_at, ...event }) => event)
        }),
        null
      );
      results = batch?.results || null;

      // Compatibilidad mientras se publica el backend por lotes.
      if (!results) {
        results = await Promise.all(due.map(async (item) => {
          let result = await dbQuiet(state.sb.rpc("createServiceRequest", item), null);
          if (result?.duplicate && result.request?.id !== item.request_id) result = null;
          if (result) return result;
          const request = await dbQuiet(
            state.sb.from("service_requests").insert({
              id: item.request_id,
              table_id: item.table_id,
              session_id: item.session_id || null,
              request_type: item.request_type,
              message: item.message || ""
            }).select("*").single(),
            null
          );
          return request ? { request, duplicate: false } : null;
        }));
      }

      const succeeded = new Set();
      (results || []).forEach((result, index) => {
        const queued = due[index];
        const request = result?.request || result;
        if (!queued || !request) return;
        succeeded.add(queued.request_id);
        state.clientRequests = [request, ...state.clientRequests.filter((item) => item.id !== queued.request_id && item.id !== request.id)];
      });

      const dueIds = new Set(due.map((item) => item.request_id));
      const nextOutbox = readRequestOutbox().flatMap((item) => {
        if (!dueIds.has(item.request_id)) return [item];
        if (succeeded.has(item.request_id)) return [];
        const attempts = Number(item.attempts || 0) + 1;
        const delay = Math.min(30000, 500 * Math.pow(2, Math.min(attempts, 6)));
        return [{ ...item, attempts, next_attempt_at: Date.now() + delay }];
      });
      writeRequestOutbox(nextOutbox);
      if (succeeded.size) state.adminBroadcastChannel?.send?.({ type: "broadcast", event: "refresh", payload: { requestIds: Array.from(succeeded) } });
      renderBillChat();
    } finally {
      state.requestOutboxBusy = false;
      if (readRequestOutbox().length) {
        window.clearTimeout(state.requestOutboxTimer);
        state.requestOutboxTimer = window.setTimeout(flushRequestOutbox, 350);
      }
    }
  };

  const createServiceNotification = async (type, message) => {
    if (!state.currentTable) return null;
    const requestId = uid();
    const tableId = state.currentTable.id;
    const sessionId = state.currentSession?.id || null;
    const request = {
      id: requestId,
      request_id: requestId,
      table_id: tableId,
      session_id: sessionId,
      request_type: type,
      table_access_code: tableCode(state.currentTable),
      message,
      status: "sending",
      created_at: new Date().toISOString()
    };
    state.clientRequests = [request, ...state.clientRequests];
    queueServiceRequest({
      request_id: requestId,
      table_id: tableId,
      session_id: sessionId,
      request_type: type,
      table_access_code: tableCode(state.currentTable),
      message
    });
    return request;
  };

  const mergeChatMessageList = (current = [], messages = []) => {
    const merged = new Map(current.map((message) => [message.id, message]));
    messages.forEach((message) => message?.id && merged.set(message.id, message));
    return Array.from(merged.values()).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))).slice(-300);
  };

  const mergeChatMessages = (messages = [], sessionId = state.currentSession?.id) => {
    if (state.page === "admin") {
      const chat = state.adminChats.get(String(sessionId || ""));
      if (chat) chat.messages = mergeChatMessageList(chat.messages, messages);
      return;
    }
    state.chatMessages = mergeChatMessageList(state.chatMessages, messages);
  };

  const chatRpcPayload = (sessionId = state.currentSession?.id, table = state.currentTable) => ({
    p_session_id: sessionId || null,
    p_table_id: table?.id || null,
    p_table_access_code: table ? tableCode(table) : "",
    p_auth_token: state.authToken || ""
  });

  const loadChatMessages = async (sessionId = state.currentSession?.id, table = state.currentTable) => {
    if (!sessionId) return false;
    const result = await dbQuiet(state.sb.rpc("listChatMessages", chatRpcPayload(sessionId, table)), null);
    const messages = Array.isArray(result) ? result : result?.messages;
    if (!Array.isArray(messages)) return false;
    const currentMessages = state.page === "client"
      ? state.chatMessages
      : state.adminChats.get(String(sessionId))?.messages || [];
    const sortedMessages = mergeChatMessageList(currentMessages, messages);
    if (state.page === "client") {
      const currentSessionId = String(sessionId);
      if (state.clientChatSoundSessionId !== currentSessionId) {
        state.clientChatSoundSessionId = currentSessionId;
        state.clientChatInitialized = false;
        state.clientStaffMessageSoundIds.clear();
      }
      const newStaffMessages = sortedMessages.filter((message) => message.sender_type === "staff" && !state.clientStaffMessageSoundIds.has(message.id));
      sortedMessages.filter((message) => message.sender_type === "staff").forEach((message) => state.clientStaffMessageSoundIds.add(message.id));
      if (state.clientChatInitialized) {
        newStaffMessages.forEach((message, index) => {
          window.setTimeout(() => void playClientChatReceipt(message.id), index * 300);
        });
      }
      state.clientChatInitialized = true;
      state.chatMessages = sortedMessages;
      const joinMessage = state.chatMessages.find((message) => message.sender_type === "system" && normalizeText(message.body).includes("se unio al chat"));
      if (joinMessage) {
        state.adminChatActive = true;
        state.adminChatNotice = joinMessage.body;
        state.assistantThreads.bar = (state.assistantThreads.bar || []).filter((message) => message.role !== "bot");
      }
      renderAssistant();
    } else {
      const chat = state.adminChats.get(String(sessionId));
      if (!chat) return false;
      const knownIds = new Set(currentMessages.map((message) => message.id));
      const incomingClientMessages = sortedMessages.filter((message) => message.sender_type === "client" && !knownIds.has(message.id));
      chat.messages = sortedMessages;
      if (chat.initialized && incomingClientMessages.length) {
        if (chat.minimized) {
          if (!chat.unreadBoundaryId) chat.unreadBoundaryId = incomingClientMessages[0].id;
          chat.unreadCount += incomingClientMessages.length;
        }
        void playAdminChatReceipt();
      }
      chat.initialized = true;
      renderAdminChat(sessionId);
    }
    return true;
  };

  const persistChatMessage = async (senderType, body, { sessionId = state.currentSession?.id, table = state.currentTable } = {}) => {
    const clean = String(body || "").trim().replace(/\s+/g, " ").slice(0, 600);
    if (!clean || !sessionId) return null;
    const messageId = uid();
    const payload = {
      ...chatRpcPayload(sessionId, table),
      p_message_id: messageId,
      p_sender_type: senderType,
      p_body: clean
    };
    mergeChatMessages([{
      id: messageId,
      session_id: sessionId,
      sender_type: senderType,
      body: clean,
      created_at: new Date().toISOString(),
      pending: true
    }], sessionId);
    if (state.page === "client") renderAssistant();
    else renderAdminChat(sessionId);
    const result = await retryQuiet(() => state.sb.rpc("sendChatMessage", payload), 3);
    const message = result?.message || result;
    if (message?.id) {
      if (state.page === "client") state.chatMessages = state.chatMessages.filter((entry) => entry.id !== messageId);
      else {
        const chat = state.adminChats.get(String(sessionId));
        if (chat) chat.messages = chat.messages.filter((entry) => entry.id !== messageId);
      }
      mergeChatMessages([message], sessionId);
      if (state.page === "client") renderAssistant();
      else renderAdminChat(sessionId);
      return message;
    }
    await loadChatMessages(sessionId, table);
    if (state.page === "client") {
      state.chatMessages = state.chatMessages.filter((entry) => entry.id !== messageId || !entry.pending);
      renderAssistant();
    } else {
      const chat = state.adminChats.get(String(sessionId));
      if (chat) chat.messages = chat.messages.filter((entry) => entry.id !== messageId || !entry.pending);
      renderAdminChat(sessionId);
    }
    return null;
  };

  const setPeerTyping = (typing, role, sessionId = "") => {
    const active = Boolean(typing);
    if (state.page === "client") state.peerTyping = active;
    const chat = state.page === "admin" ? state.adminChats.get(String(sessionId)) : null;
    if (chat) chat.peerTyping = active;
    const target = state.page === "client" ? $("#clientChatTyping") : chat?.element?.querySelector("[data-admin-chat-typing]");
    if (target) {
      target.hidden = !active;
      const label = target.querySelector("span");
      if (label) label.textContent = role === "staff" ? "El administrador esta escribiendo" : "El cliente esta escribiendo";
    }
  };

  const broadcastChatEvent = (event, payload = {}, sessionId = state.currentSession?.id) => {
    const targetSessionId = String(sessionId || "");
    const channel = state.page === "client" ? state.clientChannel : state.adminChats.get(targetSessionId)?.channel;
    return channel?.send?.({ type: "broadcast", event, payload: { sessionId: targetSessionId, ...payload } });
  };

  const broadcastTyping = (role, sessionId = state.currentSession?.id) => {
    const targetSessionId = String(sessionId || "");
    broadcastChatEvent("typing", { role, typing: true }, targetSessionId);
    if (state.page === "admin") {
      window.clearTimeout(state.adminChatTypingTimers.get(targetSessionId));
      state.adminChatTypingTimers.set(targetSessionId, window.setTimeout(() => {
        broadcastChatEvent("typing", { role, typing: false }, targetSessionId);
        state.adminChatTypingTimers.delete(targetSessionId);
      }, 900));
      return;
    }
    window.clearTimeout(state.chatTypingTimer);
    state.chatTypingTimer = window.setTimeout(() => broadcastChatEvent("typing", { role, typing: false }, targetSessionId), 900);
  };

  const renderAdminChat = (sessionId) => {
    const chat = state.adminChats.get(String(sessionId || ""));
    const target = chat?.element?.querySelector("[data-admin-chat-messages]");
    if (!chat || !target) return;
    target.innerHTML = chat.messages.length ? chat.messages.map((message) => `${message.id === chat.unreadBoundaryId ? `<div class="admin-chat-unread-divider"><span>Mensajes no leídos</span></div>` : ""}<div class="live-chat-message ${escapeHTML(message.sender_type || "system")}${message.pending ? " is-pending" : ""}"><span>${escapeHTML(message.sender_name || (message.sender_type === "staff" ? "Equipo" : message.sender_type === "client" ? "Cliente" : "Sistema"))}</span><p>${escapeHTML(message.body || "")}</p><small>${message.pending ? "Enviando..." : escapeHTML(prettyDateTime(message.created_at))}</small></div>`).join("") : emptyState("Conversacion nueva", "Los mensajes apareceran aqui en tiempo real.", "messages-square");
    const unreadBadge = chat.element.querySelector("[data-admin-chat-unread]");
    if (unreadBadge) {
      unreadBadge.hidden = !chat.unreadCount;
      unreadBadge.textContent = chat.unreadCount > 99 ? "99+" : String(chat.unreadCount);
      unreadBadge.setAttribute("aria-label", `${chat.unreadCount} mensaje${chat.unreadCount === 1 ? "" : "s"} no leído${chat.unreadCount === 1 ? "" : "s"}`);
    }
    const dot = chat.element.querySelector("[data-admin-chat-online-dot]");
    const presence = chat.element.querySelector("[data-admin-chat-presence]");
    dot?.classList.toggle("is-online", Boolean(chat.connected));
    if (presence) presence.textContent = chat.connected ? "Conectado" : "Conectando...";
    target.scrollTop = target.scrollHeight;
    refreshIcons();
  };

  const createAdminChatWindow = (chat) => {
    const dock = $("#adminChatDock");
    if (!dock) return null;
    const windowElement = document.createElement("article");
    windowElement.className = "admin-chat-window";
    windowElement.dataset.adminChatWindow = chat.sessionId;
    windowElement.innerHTML = `<header class="admin-chat-window-head" data-restore-admin-chat="${escapeHTML(chat.sessionId)}"><div><span class="eyebrow">Conversacion en vivo</span><h2><span class="admin-chat-online-dot" data-admin-chat-online-dot aria-hidden="true"></span>${escapeHTML(tableLabel(chat.table))}<span class="admin-chat-unread-badge" data-admin-chat-unread hidden>0</span></h2><small data-admin-chat-presence>Conectando...</small></div><div class="admin-chat-head-actions"><button class="icon-btn" type="button" data-minimize-admin-chat="${escapeHTML(chat.sessionId)}" aria-label="Minimizar chat" title="Minimizar"><i data-lucide="minus"></i></button><button class="icon-btn" type="button" data-finish-admin-chat="${escapeHTML(chat.sessionId)}" aria-label="Finalizar y borrar chat" title="Finalizar"><i data-lucide="x"></i></button></div></header><div class="live-chat-thread" data-admin-chat-messages></div><div class="typing-indicator" data-admin-chat-typing hidden><i></i><i></i><i></i><span>El cliente esta escribiendo</span></div><form class="admin-chat-form" data-admin-chat-form="${escapeHTML(chat.sessionId)}"><div class="admin-chat-composer"><input name="message" type="text" maxlength="600" autocomplete="off" placeholder="Escribe una respuesta..." required><button class="primary" type="submit" aria-label="Enviar"><i data-lucide="send"></i></button></div></form><button class="ghost danger-text admin-chat-finish" type="button" data-finish-admin-chat="${escapeHTML(chat.sessionId)}"><i data-lucide="log-out"></i> Finalizar y borrar chat</button>`;
    dock.prepend(windowElement);
    chat.element = windowElement;
    refreshIcons();
    return windowElement;
  };

  const setAdminChatMinimized = (sessionId, minimized) => {
    const chat = state.adminChats.get(String(sessionId || ""));
    if (!chat?.element) return;
    chat.minimized = Boolean(minimized);
    if (chat.minimized) {
      chat.unreadCount = 0;
      chat.unreadBoundaryId = "";
    } else {
      chat.unreadCount = 0;
    }
    chat.element.classList.toggle("is-minimized", chat.minimized);
    if (chat.minimized) {
      chat.element.setAttribute("role", "button");
      chat.element.setAttribute("tabindex", "0");
      chat.element.setAttribute("aria-label", `Abrir chat de ${tableLabel(chat.table)}`);
    } else {
      chat.element.removeAttribute("role");
      chat.element.removeAttribute("tabindex");
      chat.element.removeAttribute("aria-label");
    }
    const button = chat.element.querySelector("[data-minimize-admin-chat]");
    if (button) {
      button.innerHTML = icon(chat.minimized ? "maximize-2" : "minus", 18);
      button.setAttribute("aria-label", chat.minimized ? "Restaurar chat" : "Minimizar chat");
      button.title = chat.minimized ? "Restaurar" : "Minimizar";
    }
    if (!chat.minimized) {
      renderAdminChat(chat.sessionId);
      chat.element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      window.requestAnimationFrame(() => chat.element?.querySelector('input[name="message"]')?.focus({ preventScroll: true }));
    }
    refreshIcons();
  };

  const subscribeAdminChat = (chat, joinNotice) => {
    chat.channel = state.sb.channel(`table:${chat.tableId}`, { config: { broadcast: { self: false }, private: false } })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (String(payload?.sessionId) === chat.sessionId && payload?.role === "client") setPeerTyping(payload.typing, "client", chat.sessionId);
      })
      .on("broadcast", { event: "chat-refresh" }, ({ payload }) => {
        if (!payload?.sessionId || String(payload.sessionId) === chat.sessionId) void loadChatMessages(chat.sessionId, chat.table);
      })
      .subscribe((status) => {
        chat.connected = status === "SUBSCRIBED";
        renderAdminChat(chat.sessionId);
        if (chat.connected) broadcastChatEvent("admin-presence", { active: true, role: "staff", notice: joinNotice }, chat.sessionId);
      });
    window.clearInterval(chat.pollTimer);
    chat.pollTimer = window.setInterval(() => void loadChatMessages(chat.sessionId, chat.table), CHAT_SYNC_INTERVAL_MS);
  };

  const openAdminChat = async (requestIds) => {
    const ids = String(requestIds || "").split(",").filter(Boolean);
    const request = state.requests.find((entry) => ids.includes(entry.id));
    if (!request?.session_id) {
      toast("Esta solicitud aun no tiene una sesion de chat disponible.", "error", "chat-session-missing");
      return;
    }
    const table = state.tables.find((entry) => String(entry.id) === String(request.table_id));
    const sessionId = String(request.session_id);
    let chat = state.adminChats.get(sessionId);
    if (chat) {
      ids.forEach((id) => chat.requestIds.add(id));
      setAdminChatMinimized(sessionId, false);
      chat.element?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      chat.element?.querySelector('input[name="message"]')?.focus();
      await loadChatMessages(sessionId, chat.table);
      acknowledgeRequestOptimistically(ids, { status: "acknowledged", acknowledged_by_user_id: state.currentUser?.id || null, acknowledged_at: new Date().toISOString() }, "No se pudo marcar el chat como atendido.");
      return;
    }
    chat = { sessionId, tableId: request.table_id, table, requestIds: new Set(ids), messages: [], channel: null, pollTimer: null, element: null, connected: false, peerTyping: false, closing: false, confirming: false, minimized: false, initialized: false, unreadCount: 0, unreadBoundaryId: "" };
    state.adminChats.set(sessionId, chat);
    createAdminChatWindow(chat);
    renderAdminChat(sessionId);
    const joinNotice = "El administrador se unió al chat.";
    subscribeAdminChat(chat, joinNotice);
    await loadChatMessages(sessionId, table);
    const joinAlreadyRegistered = chat.messages.some((message) => message.sender_type === "system" && normalizeText(message.body).includes("se unio al chat"));
    if (!joinAlreadyRegistered) void persistChatMessage("system", joinNotice, { sessionId: request.session_id, table });
    chat.element?.querySelector('input[name="message"]')?.focus();
    acknowledgeRequestOptimistically(ids, { status: "acknowledged", acknowledged_by_user_id: state.currentUser?.id || null, acknowledged_at: new Date().toISOString() }, "No se pudo marcar el chat como atendido.");
  };

  const finishAdminChat = async (sessionId) => {
    const targetSessionId = String(sessionId || "");
    const chat = state.adminChats.get(targetSessionId);
    if (!chat || chat.closing) return;
    const closeButtons = Array.from(chat.element?.querySelectorAll("[data-finish-admin-chat]") || []);
    chat.closing = true;
    closeButtons.forEach((button) => { button.disabled = true; });
    try {
      const result = await retryQuiet(() => state.sb.rpc("closeChatSession", { p_session_id: targetSessionId, p_auth_token: state.authToken }), 3);
      if (!result) {
        toast("No se pudo finalizar el chat. Intenta nuevamente.", "error", `chat-close:${targetSessionId}`);
        return;
      }
      const relatedIds = state.requests
        .filter((request) => String(request.session_id || "") === targetSessionId && requestKind(request) === "chat")
        .map((request) => request.id);
      const requestIds = Array.from(new Set([...chat.requestIds, ...relatedIds]));
      await broadcastChatEvent("chat-closed", {}, targetSessionId);
      state.requests = state.requests.map((request) => requestIds.includes(request.id) ? { ...request, status: "resolved" } : request);
      if (chat.channel) state.sb.removeChannel(chat.channel);
      window.clearInterval(chat.pollTimer);
      window.clearTimeout(state.adminChatTypingTimers.get(targetSessionId));
      state.adminChatTypingTimers.delete(targetSessionId);
      chat.element?.remove();
      state.adminChats.delete(targetSessionId);
      toast("Chat finalizado y mensajes eliminados.", "ok", `chat-finished:${targetSessionId}`);
      if (requestIds.length) {
        void dbQuiet(state.sb.from("service_requests").update({ status: "resolved" }).in("id", requestIds), null)
          .then(() => refreshAdminNow());
      } else {
        void refreshAdminNow();
      }
    } finally {
      chat.closing = false;
      closeButtons.forEach((button) => { button.disabled = false; });
    }
  };

  const requestFinishAdminChat = async (sessionId) => {
    const targetSessionId = String(sessionId || "");
    const chat = state.adminChats.get(targetSessionId);
    if (!chat || chat.closing || chat.confirming) return;
    chat.confirming = true;
    const confirmed = await askForConfirmation({
      eyebrow: "Cerrar conversación",
      title: `¿Cerrar el chat de ${tableLabel(chat.table)}?`,
      message: "La conversación se cerrará y sus mensajes se borrarán. Confirma solo si ya terminaste de atenderla.",
      accept: "Sí, cerrar chat",
      cancel: "Seguir conversando"
    });
    chat.confirming = false;
    if (confirmed) await finishAdminChat(targetSessionId);
  };

  const describeAssistantItem = (item) =>
    `${item.name}: ${item.detail}`;

  const addAssistantOrder = async (order) => {
    if (!state.currentTable) {
      assistantSay("bot", "Primero selecciona tu mesa para poder enviar el pedido correctamente.");
      return;
    }
    await ensureOpenSession(state.currentTable.id);
    assistantSay("bot", `Perfecto. Ya envié tu solicitud de ${order.quantity} x ${order.item.name}. El mesero te atenderá para confirmar los detalles.`);
  };

  const handleAssistantMessage = async (message) => {
    const text = message.trim();
    if (!text) return;
    assistantSay("user", text);
    if (state.currentTable) {
      const session = state.currentSession || await ensureOpenSession(state.currentTable.id);
      if (session) {
        void persistChatMessage("client", text, { sessionId: session.id, table: state.currentTable }).then((saved) => {
          if (saved) broadcastChatEvent("chat-refresh");
        });
        if (!state.adminChatActive) {
          await createServiceNotification(
            "other",
            `${tableLabel(state.currentTable)} escribió en el chat: ${polishGuestText(text)}`
          );
        }
      }
    }
    if (state.adminChatActive) return;
    const normalized = normalizeText(text);
    const item = findAssistantItem(text);
    const asksCapabilities = includesAny(normalized, [
      "en que me puedes ayudar",
      "como me puedes ayudar",
      "me puedes ayudar",
      "que puedes hacer",
      "que haces",
      "hola",
      "buenas"
    ]) || normalized === "ayuda";
    const asksMenu = assistantUnderstands(normalized, "menu");
    const asksInquiry = assistantUnderstands(normalized, "inquiry");
    const asksBill = assistantUnderstands(normalized, "bill");
    const asksWaiter = assistantUnderstands(normalized, "waiter");
    const wantsOrder = assistantUnderstands(normalized, "order") || Boolean(item && !asksInquiry);

    if (asksCapabilities && !wantsOrder && !asksMenu && !asksBill && !asksWaiter) {
      assistantSay("bot", "Soy tu agente de bar. Puedes pedirme una canasta de cerveza, Ron Medellín, aguardiente, whisky, vodka, tequila, cócteles u otras bebidas. Enviaré tu solicitud al mesero para que confirme los detalles.");
      return;
    }
    if (asksMenu && !item) {
      const summary = assistantMenuSummary();
      assistantSay("bot", summary
        ? `Puedo ayudarte con opciones como ${summary}. Dime cuál deseas y la cantidad; el mesero confirmará los detalles.`
        : "Dime qué deseas pedir y enviaré la solicitud al mesero.");
      return;
    }
    const genericOrderRequest = ["quiero pedir", "quiero ordenar", "voy a pedir", "voy a ordenar"]
      .includes(normalized);
    if (wantsOrder && !item && genericOrderRequest) {
      const summary = assistantMenuSummary();
      assistantSay("bot", summary
        ? `Claro. Puedes pedir opciones como ${summary}. Escríbeme el nombre exacto de la bebida o producto y la cantidad.`
        : "Dime el nombre de la bebida o producto que deseas y lo enviaré al equipo para confirmación.");
      return;
    }
    if (item && (asksInquiry || asksMenu) && !assistantUnderstands(normalized, "order")) {
      assistantSay("bot", describeAssistantItem(item));
      return;
    }
    if (!state.currentTable) {
      assistantSay("bot", "Primero selecciona tu mesa arriba para poder enviar pedidos o avisos correctamente.");
      return;
    }
    if (asksBill) {
      await showCurrentBill();
      assistantSay("bot", "Te mostré la cuenta actual de tu mesa. Puedes consultarla nuevamente cuando quieras.");
      return;
    }
    if (asksWaiter) {
      void createRequest("waiter");
      assistantSay("bot", "Ya llamamos al mesero. Te atenderán en breve.");
      return;
    }
    const order = parseAssistantOrder(text);
    if (order) {
      assistantSay("bot", "Recibido. Estoy registrando el pedido para tu mesa.");
      void addAssistantOrder(order);
      return;
    }
    assistantSay("bot", "Entendido. Ya envié tu solicitud para que el mesero te atienda y confirme los detalles.");
  };

  const handleSongRequest = async (message) => {
    const song = String(message || "").trim().replace(/\s+/g, " ").slice(0, 180);
    if (!song) return;
    assistantSay("user", song);
    if (!state.currentTable) {
      assistantSay("bot", "Primero selecciona tu mesa para poder enviar la canción.");
      return;
    }
    const request = await createServiceNotification(
      "other",
      `${tableLabel(state.currentTable)} solicita la canción: ${song}`
    );
    if (request) assistantSay("bot", `Listo. La canción “${song}” fue solicitada al equipo.`);
  };

  const addItemToSession = async (itemId) => {
    if (!state.currentTable) {
      toast("Selecciona tu mesa primero.", "error");
      return;
    }
    const session = await ensureOpenSession(state.currentTable.id);
    if (!session) return;
    const item = state.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const payload = {
      session_id: session.id,
      table_id: state.currentTable.id,
      menu_item_id: item.id,
      item_name: item.name,
      quantity: 1,
      unit_price: item.price,
      status: "pending"
    };
    const saved = await db(state.sb.from("session_items").insert(payload).select("*").single(), null);
    if (saved) {
      toast(`${item.name} agregado a la cuenta.`);
      await loadClientSessionItems();
      renderAccount();
    }
  };

  const createRequest = (type, message = "") => {
    if (type === "bill") return showCurrentBill();
    if (!state.currentTable) {
      toast("Selecciona tu mesa primero.", "error");
      return null;
    }
    const requestId = uid();
    const tableId = state.currentTable.id;
    const sessionId = state.currentSession?.id || null;
    const now = new Date().toISOString();
    const optimisticRequest = {
      id: requestId,
      table_id: tableId,
      session_id: sessionId,
      request_type: type,
      message,
      status: "sending",
      created_at: now,
      updated_at: now
    };
    state.clientRequests = [optimisticRequest, ...state.clientRequests];
    if (type === "bill") rememberPendingBill(requestId);

    const button = document.querySelector(`[data-request="${type}"]`);
    if (button) {
      button.classList.add("is-pending");
      window.setTimeout(() => button.classList.remove("is-pending"), 260);
    }
    toast(`${REQUEST_LABELS[type]} enviada. El equipo la recibira en segundos.`, "ok", `request-sent:${type}`);
    queueServiceRequest({
      request_id: requestId,
      table_id: tableId,
      session_id: sessionId,
      request_type: type,
      table_access_code: tableCode(state.currentTable),
      message
    });
    return optimisticRequest;
  };

  const thankBill = (id) => {
    const box = $("#billChat");
    if (!id || box?.classList.contains("is-closing")) return;
    clearPendingBill(id);
    state.clientRequests = state.clientRequests.map((request) => request.id === id
      ? { ...request, status: "resolved", resolved_at: new Date().toISOString() }
      : request);
    queueBillResolution(id);
    box?.classList.add("is-closing");
    window.setTimeout(() => {
      if (!box) return;
      box.hidden = true;
      box.innerHTML = "";
      box.classList.remove("is-closing");
      document.body.classList.remove("receipt-open");
      document.querySelector('[data-request="bill"]')?.focus({ preventScroll: true });
    }, 320);
  };

  const closeCurrentBill = () => {
    const box = $("#billChat");
    if (!state.localBillOpen || box?.classList.contains("is-closing")) return;
    state.localBillOpen = false;
    box?.classList.add("is-closing");
    window.setTimeout(() => {
      if (!box) return;
      box.hidden = true;
      box.innerHTML = "";
      box.classList.remove("is-closing");
      document.body.classList.remove("receipt-open");
      document.querySelector('[data-request="bill"]')?.focus({ preventScroll: true });
    }, 320);
  };

  const bindClient = () => {
    document.addEventListener("click", async (event) => {
      const category = event.target.closest("[data-category]");
      const add = event.target.closest("[data-add-item]");
      const request = event.target.closest("[data-request]");
      const songRequest = event.target.closest("[data-song-request]");
      const thanks = event.target.closest("[data-thank-bill]");
      const closeBill = event.target.closest("[data-close-bill]");
      const change = event.target.closest("[data-action='change-table']");
      const suggestion = event.target.closest("[data-assistant-suggest]");

      if (category) {
        state.activeCategory = category.dataset.category;
        renderMenu();
      }
      if (add) await addItemToSession(add.dataset.addItem);
      if (request) await createRequest(request.dataset.request);
      if (songRequest) activateSongRequestMode();
      if (thanks) thankBill(thanks.dataset.thankBill);
      if (closeBill) closeCurrentBill();
      if (suggestion) await handleAssistantMessage(suggestion.dataset.assistantSuggest);
      if (change && !state.tableLocked) {
        clearInterval(state.clientPollTimer);
        state.clientHydrationToken += 1;
        state.localBillOpen = false;
        state.currentTable = null;
        state.currentSession = null;
        state.tableAccountStatus = "idle";
        state.tableAccountTotal = 0;
        state.qrLocked = false;
        state.tableLocked = false;
        state.sessionItems = [];
        state.clientRequests = [];
        state.sb.setTableAccess("", "");
        renderTablePicker();
        renderAccount();
        renderBillChat();
      }
    });

    document.addEventListener("change", async (event) => {
      if (event.target.id === "tableSelect") {
        state.localBillOpen = false;
        state.currentTable = state.tables.find((table) => table.id === event.target.value) || null;
        if (state.currentTable) {
          state.sb.setTableAccess(state.currentTable.id, tableCode(state.currentTable));
          void flushBillResolutionOutbox();
          state.currentSession = null;
          state.sessionItems = [];
          state.clientRequests = [];
          state.clientSnapshotSignature = "";
          state.tableAccountStatus = "checking";
          state.tableAccountTotal = 0;
          state.tableLocked = false;
          renderAccount();
          renderBillChat();
          renderTablePicker();
          void hydrateSelectedTable(state.currentTable.id);
        }
        renderTablePicker();
        renderAccount();
        renderBillChat();
      }
    });

    $("#assistantForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = event.currentTarget.message;
      const message = input.value;
      input.value = "";
      if (state.assistantMode === "song") await handleSongRequest(message);
      else await handleAssistantMessage(message);
    });
    $("#assistantInput")?.addEventListener("input", () => {
      if (state.currentSession && state.assistantMode === "bar") broadcastTyping("client");
    });
  };

  const subscribeClient = () => {
    if (!state.currentSession) return;
    const sessionId = String(state.currentSession.id);
    if (state.clientChatSoundSessionId !== sessionId) {
      state.clientChatSoundSessionId = sessionId;
      state.clientChatInitialized = false;
      state.clientStaffMessageSoundIds.clear();
    }
    clearInterval(state.clientPollTimer);
    if (state.clientChannel) state.sb.removeChannel(state.clientChannel);
    clearInterval(state.chatPollTimer);
    const refresh = async () => {
      if (state.clientSyncBusy || !state.currentSession) return;
      state.clientSyncBusy = true;
      try {
        if (await loadClientSnapshot()) {
          renderAccount();
          renderBillChat();
        }
        await loadChatMessages();
      } finally {
        state.clientSyncBusy = false;
      }
    };
    state.clientChannel = state.sb
      .channel(`table:${state.currentTable.id}`, { config: { broadcast: { self: false }, private: false } })
      .on("broadcast", { event: "refresh" }, refresh)
      .on("broadcast", { event: "chat-refresh" }, () => void loadChatMessages())
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (String(payload?.sessionId) === String(state.currentSession?.id) && payload?.role === "staff") setPeerTyping(payload.typing, "staff");
      })
      .on("broadcast", { event: "admin-presence" }, ({ payload }) => {
        if (payload?.active) {
          state.adminChatActive = true;
          state.adminChatNotice = payload.notice || "El administrador se unió al chat.";
          state.assistantThreads.bar = (state.assistantThreads.bar || []).filter((message) => message.role !== "bot");
          state.assistantMessages = state.assistantThreads[state.assistantMode] || [];
          renderAssistant();
        }
      })
      .on("broadcast", { event: "chat-closed" }, () => {
        state.chatMessages = [];
        state.clientChatInitialized = false;
        state.clientStaffMessageSoundIds.clear();
        state.assistantThreads.bar = [];
        state.adminChatActive = false;
        state.adminChatNotice = "";
        assistantSay("bot", "La conversacion fue finalizada. Puedes iniciar una nueva cuando lo necesites.");
      })
      .subscribe();
    state.clientPollTimer = setInterval(refresh, SYNC_INTERVAL_MS);
    state.chatPollTimer = setInterval(() => void loadChatMessages(), CHAT_SYNC_INTERVAL_MS);
    void loadChatMessages();
  };

  const initClient = async () => {
    setLoading(true);
    const nativeScanValue = tableValueFromUrl();
    if (nativeScanValue && localStorage.getItem("la_licorera_17_admin_token")) {
      const adminUrl = new URL("admin.html", location.href);
      adminUrl.searchParams.set("scan", nativeScanValue);
      adminUrl.hash = "service";
      location.replace(adminUrl.href);
      return;
    }
    await loadBootstrap();
    renderBrand();
    state.currentTable = findTableFromUrl();
    if (state.currentTable) {
      const adminLink = $(".admin-link");
      if (adminLink) {
        const adminUrl = new URL("admin.html", location.href);
        adminUrl.searchParams.set("scan", tableCode(state.currentTable));
        adminUrl.hash = "service";
        adminLink.href = adminUrl.href;
        adminLink.title = "Atender esta mesa desde el panel";
      }
      state.sb.setTableAccess(state.currentTable.id, tableCode(state.currentTable));
      state.tableAccountStatus = "checking";
      void flushBillResolutionOutbox();
    }
    renderTablePicker();
    renderMenu();
    renderAccount();
    renderBillChat();
    renderAssistant();
    bindClient();
    state.adminBroadcastChannel = state.sb.channel("admin", { config: { broadcast: { self: false }, private: false } }).subscribe();
    subscribeClient();
    setLoading(false);
    // La pantalla queda usable tras el bootstrap; la cuenta se hidrata en segundo plano.
    if (state.currentTable) {
      void hydrateSelectedTable(state.currentTable.id);
    }
  };

  const mergeOptimisticRequests = (requests = []) => requests.map((request) => {
    const optimistic = state.optimisticRequestStates.get(request.id);
    return optimistic ? { ...request, ...optimistic } : request;
  });

  const sessionItemMatches = (serverItem, expectedItem) =>
    serverItem && expectedItem &&
    String(serverItem.id) === String(expectedItem.id) &&
    String(serverItem.item_name || "") === String(expectedItem.item_name || "") &&
    Number(serverItem.quantity || 0) === Number(expectedItem.quantity || 0) &&
    Number(serverItem.unit_price || 0) === Number(expectedItem.unit_price || 0) &&
    String(serverItem.notes || "") === String(expectedItem.notes || "") &&
    String(serverItem.status || "") === String(expectedItem.status || "");

  const mergeOptimisticSessions = (serverSessions = []) => {
    const merged = new Map(serverSessions.map((session) => [session.id, session]));
    state.optimisticSessionStates.forEach((overlay, sessionId) => {
      const serverSession = merged.get(sessionId);
      if (overlay.mode === "remove") {
        merged.delete(sessionId);
        if (!serverSession) state.optimisticSessionStates.delete(sessionId);
        return;
      }
      const expectedItems = overlay.expectedItems || (overlay.expectedItem ? [overlay.expectedItem] : []);
      const expectedItemConfirmed = !expectedItems.length || expectedItems.every((expectedItem) =>
        (serverSession?.session_items || []).some((item) => sessionItemMatches(item, expectedItem))
      );
      const expectedSessionConfirmed = !overlay.expectedSession || (
        String(serverSession?.payer_name || "") === String(overlay.expectedSession.payer_name || "") &&
        String(serverSession?.assigned_waiter_id || "") === String(overlay.expectedSession.assigned_waiter_id || "")
      );
      if (serverSession && expectedItemConfirmed && expectedSessionConfirmed) {
        state.optimisticSessionStates.delete(sessionId);
        merged.set(sessionId, serverSession);
      } else {
        merged.set(sessionId, overlay.session);
      }
    });
    return Array.from(merged.values());
  };

  const isSongRequest = (request) => request.request_type === "other"
    && normalizeText(request.message || "").includes("solicita la cancion");

  const requestKind = (request) => {
    if (isSongRequest(request)) return "song";
    return request.request_type === "other" && String(request.message || "").trim() ? "chat" : request.request_type;
  };

  const activeRequests = () => state.requests.filter((request) => request.status === "pending");

  const hasOpenAdminChatForRequest = (request) => {
    if (requestKind(request) !== "chat") return false;
    const sessionId = String(request.session_id || "");
    if (sessionId && state.adminChats.has(sessionId)) return true;
    return Array.from(state.adminChats.values()).some((chat) => String(chat.tableId) === String(request.table_id));
  };

  const requestSignature = () => activeRequests().map((request) => request.id).join("|");

  const updateAlarmButton = () => {
    const button = $("#enableSound");
    if (!button) return;
    button.classList.toggle("sound-active", state.soundEnabled);
    button.classList.toggle("needs-sound", !state.soundEnabled);
    button.innerHTML = state.soundEnabled
      ? `${icon("volume-2", 18)} Alarma activa`
      : `${icon("volume-x", 18)} Activar alarma`;
    const hint = $("#soundHint");
    if (hint) {
      hint.textContent = state.soundEnabled
        ? (state.soundPrimed
          ? "Alarma y avisos por voz activos en este equipo."
          : "Alarma guardada. Se reanuda con el proximo gesto en esta pantalla.")
        : "Activa el sonido para escuchar la alarma y el motivo de cada solicitud.";
    }
    refreshIcons();
  };

  const getAlarmAudio = () => {
    const audio = $("#alarmAudio");
    if (!audio) return null;
    audio.volume = 1;
    return audio;
  };

  const requestTableName = (request) => tableLabel(
    request.restaurant_tables || state.tables.find((table) => String(table.id) === String(request.table_id))
  );

  const requestVoiceText = (request) => {
    const table = requestTableName(request);
    const message = String(request.message || "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (request.request_type === "waiter") return `${table} solicita al mesero.`;
    if (request.request_type === "bill") return `${table} solicita la cuenta.`;
    if (!message) return `${table} necesita ayuda.`;
    if (isSongRequest(request)) {
      const song = message.includes(":") ? message.split(":").slice(1).join(":").trim() : message;
      return `${table} solicita la canción ${song.replace(/[.!?]+$/, "")}.`;
    }
    const order = message.match(/solicita\s+atenci[oó]n\s+para\s+pedir\s+([\d.,]+)\s*x\s+(.+?)(?:\.\s*Mensaje\s+del\s+cliente:|$)/i);
    const clientMessage = message.match(/Mensaje\s+del\s+cliente:\s*(.+)$/i);
    if (order) {
      const extra = clientMessage?.[1]?.trim();
      return `${table} está pidiendo ${order[1]} unidades de ${order[2].trim()}.${extra ? ` El cliente dice: ${extra}.` : ""}`;
    }
    if (normalizeText(message).startsWith(normalizeText(table))) return `${message}.`;
    return `${table} informa: ${message}.`;
  };

  const speakAlertRequests = (requests) => new Promise((resolve) => {
    if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function" || !requests.length) {
      resolve();
      return;
    }
    const speech = requests.map(requestVoiceText).join(" ").slice(0, 900);
    const utterance = new SpeechSynthesisUtterance(speech);
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /^es[-_]CO$/i.test(voice.lang))
      || voices.find((voice) => /^es/i.test(voice.lang))
      || null;
    utterance.lang = utterance.voice?.lang || "es-CO";
    utterance.rate = 0.94;
    utterance.pitch = 1;
    utterance.volume = 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      state.speechFinish = null;
      resolve();
    };
    state.speechFinish = finish;
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
    window.setTimeout(finish, Math.min(22000, Math.max(6000, speech.length * 85)));
  });

  const playAlarmToneOnce = () => new Promise((resolve) => {
    const audio = getAlarmAudio();
    if (!audio) {
      resolve();
      return;
    }
    window.clearTimeout(state.alarmStopTimer);
    audio.pause();
    audio.loop = false;
    audio.currentTime = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", finish);
      audio.pause();
      audio.currentTime = 0;
      state.alarmToneFinish = null;
      resolve();
    };
    state.alarmToneFinish = finish;
    audio.addEventListener("ended", finish, { once: true });
    state.alarmStopTimer = window.setTimeout(finish, 5500);
    audio.play().catch(() => {
      state.soundPrimed = false;
      updateAlarmButton();
      finish();
    });
  });

  const drainAlertAnnouncements = async () => {
    if (state.alertAnnouncementBusy || !state.soundEnabled) return;
    state.alertAnnouncementBusy = true;
    try {
      while (state.alertAnnouncementQueue.length && state.soundEnabled) {
        const activeIds = new Set(activeRequests().map((request) => request.id));
        const batch = state.alertAnnouncementQueue.splice(0).filter((request) => activeIds.has(request.id));
        if (!batch.length) continue;
        await playAlarmToneOnce();
        const voiceBatch = batch.filter((request) => !hasOpenAdminChatForRequest(request));
        if (state.soundEnabled && voiceBatch.length) await speakAlertRequests(voiceBatch);
      }
    } finally {
      state.alertAnnouncementBusy = false;
      if (state.alertAnnouncementQueue.length && state.soundEnabled) void drainAlertAnnouncements();
    }
  };

  const playAlarm = (requests = activeRequests()) => {
    if (!state.soundEnabled) return;
    const unseen = requests.filter((request) => !state.announcedRequestIds.has(request.id));
    if (!unseen.length) return;
    unseen.forEach((request) => state.announcedRequestIds.add(request.id));
    state.alertAnnouncementQueue.push(...unseen);
    void drainAlertAnnouncements();
  };

  const stopAlarm = () => {
    window.clearTimeout(state.alarmStopTimer);
    state.alertAnnouncementQueue = [];
    state.alarmToneFinish?.();
    state.speechFinish?.();
    window.speechSynthesis?.cancel();
    const audio = getAlarmAudio();
    if (!audio) return;
    audio.pause();
    audio.loop = false;
    audio.currentTime = 0;
  };

  const disableAlarm = () => {
    stopAlarm();
    state.soundEnabled = false;
    state.soundPrimed = false;
    localStorage.removeItem("waiter_alarm_enabled");
    updateAlarmButton();
    toast("Alarma desactivada en este equipo.", "ok", "alarm-disabled");
  };

  const confirmDisableAlarm = () => {
    const dialog = $("#alarmConfirmDialog");
    if (!dialog) return Promise.resolve(false);
    dialog.returnValue = "";
    dialog.showModal();
    refreshIcons();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  };

  const askForConfirmation = ({ eyebrow = "Confirmación", title = "¿Continuar?", message = "", accept = "Sí, continuar", cancel = "Cancelar" } = {}) => {
    const dialog = $("#actionConfirmDialog");
    if (!dialog) return Promise.resolve(false);
    $("#actionConfirmEyebrow").textContent = eyebrow;
    $("#actionConfirmTitle").textContent = title;
    $("#actionConfirmMessage").textContent = message;
    $("#actionConfirmAccept").textContent = accept;
    $("#actionConfirmCancel").textContent = cancel;
    dialog.returnValue = "";
    dialog.showModal();
    refreshIcons();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  };

  const unlockAlarm = async ({ silent = false } = {}) => {
    const audio = getAlarmAudio();
    if (!audio) {
      if (!silent) toast("No se encontro el sonido de alarma.", "error", "alarm-audio-missing");
      return;
    }

    try {
      state.soundEnabled = true;
      state.soundPrimed = true;
      localStorage.setItem("waiter_alarm_enabled", "1");
      updateAlarmButton();
      audio.currentTime = 0;
      audio.loop = false;
      await audio.play();
      if (!silent) toast("Alarma activada.", "ok", "alarm-enabled");

      window.setTimeout(() => {
        audio.pause();
        audio.currentTime = 0;
        if (activeRequests().length) playAlarm(activeRequests());
      }, activeRequests().length ? 450 : 1100);
    } catch (error) {
      state.soundEnabled = false;
      state.soundPrimed = false;
      localStorage.removeItem("waiter_alarm_enabled");
      updateAlarmButton();
      if (!silent) toast("El navegador bloqueo el audio. Toca Activar alarma otra vez.", "error", "alarm-permission");
    }
  };

  const armAlarmOnFirstGesture = () => {
    const prime = async (fromMouseMove = false) => {
      if (state.soundPrimed || state.soundPriming) return;
      if (fromMouseMove) {
        if (state.mousePrimeAttempted) return;
        state.mousePrimeAttempted = true;
      }
      state.soundPriming = true;
      try {
        await unlockAlarm({ silent: true });
      } finally {
        state.soundPriming = false;
      }
    };
    // Algunos navegadores aceptan mousemove; click, toque y teclado son el respaldo garantizado.
    document.addEventListener("mousemove", () => prime(true), { passive: true });
    ["pointerdown", "touchstart", "keydown"].forEach((eventName) => {
      document.addEventListener(eventName, () => prime(false), { once: true, passive: true });
    });
  };

  const startAlarmLoop = () => {
    clearInterval(state.alarmTimer);
    state.alarmTimer = setInterval(() => {
      if (!activeRequests().length) {
        const audio = getAlarmAudio();
        if (audio) {
          audio.pause();
          audio.loop = false;
          audio.currentTime = 0;
        }
      }
    }, 12000);
  };

  const refreshCoreData = async () => {
    if (state.coreRefreshBusy) return true;
    state.coreRefreshBusy = true;
    try {
      const [businessLoaded, coreLoaded] = await Promise.all([loadBusiness(), loadCore()]);
      applyBusinessTipSettings();
      if (!state.outdoorTableDraftDirty) state.outdoorTableDraftIds = null;
      persistBootstrapCache();
      renderBrand();
      syncTipFeatureVisibility();
      if (state.page === "admin") {
        renderTables();
        renderServiceTables();
        renderTableManager();
        renderMenuManager();
        renderInventory();
        if (state.activeAdminSection === "brand" && !state.outdoorTableDraftDirty) renderBusinessForm();
      } else {
        renderTablePicker();
        renderMenu();
      }
      return businessLoaded || coreLoaded;
    } finally {
      state.coreRefreshBusy = false;
    }
  };

  const refreshAdminNow = async () => {
    if (state.adminSyncBusy) return false;
    state.adminSyncBusy = true;
    try {
      const changed = await loadAdminData();
      if (changed) renderAdminLive();
      return changed;
    } finally {
      state.adminSyncBusy = false;
    }
  };

  const startAdminPolling = () => {
    clearInterval(state.adminPollTimer);
    state.adminPollTimer = setInterval(refreshAdminNow, SYNC_INTERVAL_MS);
  };

  const loadAdminData = async () => {
    const snapshot = await dbQuiet(state.sb.rpc("getAdminSnapshot", { auth_token: state.authToken }), null);
    if (!snapshot) {
      const [requests, sessions] = await Promise.all([
        db(
          state.sb.from("service_requests").select("*, restaurant_tables(table_number, table_name)")
            .in("status", ["pending", "acknowledged"]).order("created_at", { ascending: false }),
          []
        ),
        db(
          state.sb.from("table_sessions").select("*, restaurant_tables(table_number, table_name), session_items(*)")
            .eq("status", "open").order("opened_at", { ascending: false }),
          []
        )
      ]);
      state.requests = mergeOptimisticRequests(requests || []);
      state.sessions = mergeOptimisticSessions(sessions || []);
      return true;
    }
    const requests = mergeOptimisticRequests(snapshot.requests || []);
    const sessions = mergeOptimisticSessions(snapshot.sessions || []);
    const signature = JSON.stringify([
      requests.map((request) => [request.id, request.status, request.updated_at]),
      sessions.map((session) => [
        session.id,
        session.status,
        session.updated_at,
        ...(session.session_items || []).map((item) => [item.id, item.status, item.quantity, item.updated_at])
      ])
    ]);
    if (signature === state.adminSnapshotSignature) return false;
    state.adminSnapshotSignature = signature;
    state.requests = requests;
    state.sessions = sessions;
    return true;
  };

  const updateNavRequestBadge = () => {
    const badge = $("#navRequestBadge");
    if (!badge) return;
    const count = activeRequests().length;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.setAttribute("aria-label", `${count} solicitud${count === 1 ? "" : "es"} pendiente${count === 1 ? "" : "s"}`);
    if (count > state.lastRequestBadgeCount) {
      badge.classList.remove("is-inflating");
      void badge.offsetWidth;
      badge.classList.add("is-inflating");
      window.setTimeout(() => badge.classList.remove("is-inflating"), 650);
    }
    state.lastRequestBadgeCount = count;
  };

  const renderAdminShell = () => {
    renderBrand();
    syncTipFeatureVisibility();
    const tableSessions = state.sessions.filter((session) => !isLocalWalkInSession(session));
    const totals = {
      tables: normalTables().filter((table) => table.is_active).length,
      alerts: activeRequests().length,
      open: tableSessions.length,
      sales: tableSessions.reduce((sum, session) => sum + sessionTotal(session), 0)
    };
    $("#metricTables").textContent = totals.tables;
    $("#metricAlerts").textContent = totals.alerts;
    $("#metricOpen").textContent = totals.open;
    $("#metricSales").textContent = money(totals.sales);
    updateNavRequestBadge();
  };

  const integerMoney = (value) => Math.max(0, Math.round(Number(value || 0)));

  const tipsEnabled = () => state.tipSettings?.enabled === true
    && Number(state.tipSettings?.percentage) >= 1
    && Number(state.tipSettings?.percentage) <= 100;

  const tipAmountFor = (baseTotal, percentage = state.tipSettings?.percentage) =>
    integerMoney(Number(baseTotal || 0) * Number(percentage || 0) / 100);

  const localDateKey = (value) => {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  const syncTipFeatureVisibility = () => {
    const enabled = tipsEnabled();
    $$('[data-tip-feature]').forEach((element) => { element.hidden = !enabled; });
  };

  const sessionTotals = (session) => {
    const subtotal = (session?.session_items || [])
      .filter((item) => item.status !== "cancelled")
      .reduce((sum, item) => sum + integerMoney(item.unit_price) * Math.max(0, Number(item.quantity || 0)), 0);
    const total = integerMoney(subtotal);
    return { subtotal: total, discount: 0, tax: 0, serviceFee: 0, total };
  };

  const sessionTotal = (session) => sessionTotals(session).total;

  const newestSessionItems = (session) => [...(session?.session_items || [])]
    .filter((item) => item.status !== "cancelled")
    .sort((left, right) => {
      const leftTime = new Date(left.created_at || left.updated_at || 0).getTime();
      const rightTime = new Date(right.created_at || right.updated_at || 0).getTime();
      return rightTime - leftTime;
    });

  const tablesSignature = () =>
    JSON.stringify({
      tables: state.tables.map((table) => [
        table.id,
        table.table_number,
        table.table_name,
        table.qr_code,
        table.is_active,
        table.is_outdoor
      ]),
      sessions: state.sessions.map((session) => [
        session.id,
        session.table_id,
        session.status,
        sessionTotal(session),
        (session.session_items || []).length
      ]),
      requests: activeRequests().map((request) => [request.id, request.table_id, request.request_type, request.status]),
      filters: [state.dashboardTableZoneFilter, state.serviceTableZoneFilter]
    });

  const groupedActiveRequests = () => {
    const groups = new Map();
    activeRequests().forEach((request) => {
      const kind = requestKind(request);
      const key = `${request.table_id}:${request.session_id || "no-session"}:${kind}`;
      if (!groups.has(key)) {
        groups.set(key, { ...request, kind, request_ids: [], count: 0, latest_message: request.message || "" });
      }
      const group = groups.get(key);
      group.request_ids.push(request.id);
      group.count += 1;
    });
    return Array.from(groups.values());
  };

  const renderAlerts = () => {
    const box = $("#alertsPanel");
    if (!box) return;
    const alerts = groupedActiveRequests();
    const visibleAlerts = state.alertFilter === "all"
      ? alerts
      : alerts.filter((request) => request.kind === state.alertFilter);
    const renderSignature = `${state.alertFilter}:${visibleAlerts.map((request) => `${request.id}:${request.count}:${request.latest_message}`).join("|")}`;
    box.classList.toggle("has-alerts", alerts.length > 0);
    const alertCards = visibleAlerts
      .map(
        (request) => `
              <article class="alert-card alert-${request.kind}" data-alert-card="${request.id}">
                <div class="alert-icon">
                  ${
                    request.kind === "song"
                      ? icon("music-2", 22)
                      : REQUEST_IMAGES[request.request_type]
                        ? `<img class="alert-image" src="${REQUEST_IMAGES[request.request_type]}" alt="">`
                        : icon(REQUEST_ICONS[request.request_type] || "bell", 22)
                  }
                </div>
                <div>
                  <span>${request.kind === "song" ? "Canción solicitada" : request.kind === "chat" ? "Chat / pedido" : (REQUEST_LABELS[request.request_type] || request.request_type)}</span>
                  <h3><mark class="alert-table-name">${escapeHTML(tableLabel(request.restaurant_tables))}</mark></h3>
                  ${request.message && !parseBillMessage(request.message) ? `<p>${escapeHTML(request.message)}</p>` : ""}
                  <p>${prettyDateTime(request.created_at)}</p>
                </div>
                ${request.count > 1 ? `<strong class="alert-count" aria-label="${request.count} llamados">${request.count}</strong>` : ""}
                ${
                  request.request_type === "bill"
                    ? `<button class="primary" data-send-bill="${request.request_ids.join(",")}">${icon("send", 17)} Enviar cuenta</button>`
                    : request.kind === "chat"
                      ? `<button class="primary" data-open-chat="${request.request_ids.join(",")}">${icon("messages-square", 17)} Abrir chat</button>`
                      : `<button class="primary" data-accept-request="${request.request_ids.join(",")}">${icon("check", 17)} Aceptar</button>`
                }
              </article>
            `
      )
      .join("");

    $("#floatingAlerts")?.remove();
    if (renderSignature !== state.alertRenderSignature) {
      state.alertRenderSignature = renderSignature;
      box.innerHTML = visibleAlerts.length
        ? alertCards
        : emptyState("Sin solicitudes en este filtro", "Las nuevas solicitudes se acumularan aqui.", "bell");
    }

    const signature = requestSignature();
    if (signature && signature !== state.lastAlertSignature) {
      state.lastAlertSignature = signature;
      playAlarm(activeRequests());
    }
    refreshIcons();
  };

  const compactTableTiles = (zoneFilter = "all", searchValue = "") => {
    const tables = normalTables()
      .filter((table) => table.is_active !== false)
      .filter((table) => tableMatchesZone(table, zoneFilter));
    return filterTablesBySmartSearch(tables, searchValue).map((table) => {
      const session = state.sessions.find((entry) => entry.table_id === table.id && entry.status === "open");
      const pending = state.requests.filter((request) => request.table_id === table.id && request.status === "pending").length;
      const occupied = Boolean(session);
      return `<button class="compact-table-tile ${occupied ? "occupied" : "free"} ${isOutdoorTable(table) ? "outdoor" : "indoor"} ${pending ? "needs-attention" : ""}" type="button" data-open-table="${escapeHTML(table.id)}" title="Agregar consumo en ${escapeHTML(tableLabel(table))}"><span class="table-furniture-icon">${icon("armchair", 23)}</span><strong>M${escapeHTML(table.table_number)}</strong>${occupied ? `<small>${money(sessionTotal(session))}</small>` : "<small>Libre</small>"}${pending ? `<em>${pending}</em>` : ""}</button>`;
    }).join("");
  };

  const renderTables = () => {
    const box = $("#tablesGrid");
    if (!box) return;
    state.tableRenderSignature = tablesSignature();
    box.classList.add("compact-tables-grid");
    const filter = state.dashboardTableZoneFilter;
    const searchValue = state.dashboardTableSearch;
    const select = $("#dashboardTableZoneFilter");
    const search = $("#dashboardTableSearch");
    if (select) select.value = filter;
    if (search && search.value !== searchValue) search.value = searchValue;
    box.innerHTML = compactTableTiles(filter, searchValue) || emptyState("Sin mesas", searchValue ? "No hay una mesa que coincida con la búsqueda." : (filter === "all" ? "Crea las mesas del negocio para comenzar." : "No hay mesas en esta ubicación."), "layout-grid");
    refreshIcons();
  };

  const renderServiceTables = () => {
    const box = $("#waiterTablesGrid");
    if (!box) return;
    const filter = state.serviceTableZoneFilter;
    const searchValue = state.serviceTableSearch;
    const select = $("#serviceTableZoneFilter");
    const search = $("#serviceTableSearch");
    if (select) select.value = filter;
    if (search && search.value !== searchValue) search.value = searchValue;
    box.innerHTML = compactTableTiles(filter, searchValue) || emptyState("Sin mesas", searchValue ? "No hay una mesa que coincida con la búsqueda." : (filter === "all" ? "Crea una mesa activa para atenderla." : "No hay mesas en esta ubicación."), "armchair");
    renderServicePoints();
    refreshIcons();
  };

  const renderServicePoints = () => {
    const box = $("#servicePointsGrid");
    if (!box) return;
    const otherZone = state.activeServiceZone === "bar" ? "planter" : "bar";
    const hasActivePoints = state.tables.some((table) => table.is_active !== false && servicePointKind(table) === state.activeServiceZone);
    const hasOtherPoints = state.tables.some((table) => table.is_active !== false && servicePointKind(table) === otherZone);
    if (!hasActivePoints && hasOtherPoints) {
      state.activeServiceZone = otherZone;
      localStorage.setItem(SERVICE_ZONE_STORAGE_KEY, state.activeServiceZone);
    }
    $$('[data-service-zone]').forEach((button) => {
      const active = button.dataset.serviceZone === state.activeServiceZone;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    const points = state.tables
      .filter((table) => table.is_active !== false && servicePointKind(table) === state.activeServiceZone)
      .sort((left, right) => Number(left.table_number || 0) - Number(right.table_number || 0));
    const kindLabel = state.activeServiceZone === "bar" ? "barra" : "matera";
    box.innerHTML = points.length ? points.map((table) => {
      const session = state.sessions.find((entry) => String(entry.table_id) === String(table.id) && entry.status === "open");
      const occupied = Boolean(session);
      return `<article class="service-point-tile ${occupied ? "occupied" : "free"}">
        <button type="button" data-open-table="${escapeHTML(table.id)}" title="Atender ${escapeHTML(tableLabel(table))}">
          ${icon(state.activeServiceZone === "bar" ? "wine" : "flower-2", 22)}
          <span><strong>${escapeHTML(tableLabel(table))}</strong><small>${occupied ? money(sessionTotal(session)) : "Libre"}</small></span>
        </button>
        ${state.currentUser?.role === "admin" ? `<button class="icon-btn danger" type="button" data-delete-service-point="${escapeHTML(table.id)}" aria-label="Eliminar ${escapeHTML(tableLabel(table))}">${icon("trash-2", 15)}</button>` : ""}
      </article>`;
    }).join("") : emptyState(`Sin ${kindLabel}s`, `Agrega un puesto de ${kindLabel} para atender clientes aquí.`, state.activeServiceZone === "bar" ? "wine" : "flower-2");
    const addButton = $("#addServicePoint");
    if (addButton) addButton.innerHTML = `${icon("plus", 17)} Agregar ${kindLabel}`;
    refreshIcons();
  };

  const addServicePoint = () => {
    if (state.currentUser?.role !== "admin") return;
    const kind = state.activeServiceZone;
    const sameKind = state.tables.filter((table) => servicePointKind(table) === kind);
    const sequence = sameKind.reduce((largest, table) => {
      const match = String(table.table_name || "").match(/(\d+)$/);
      return Math.max(largest, Number(match?.[1] || 0));
    }, 0) + 1;
    const id = uid();
    const tableNumber = state.tables.reduce((largest, table) => Math.max(largest, Number(table.table_number || 0)), 0) + 1;
    const label = kind === "bar" ? `Barra ${sequence}` : `Matera ${sequence}`;
    const point = { id, table_number: tableNumber, table_name: label, qr_code: `interno-${kind}-${id.slice(0, 8)}`, qr_image_url: null, is_active: true };
    const original = [...state.tables];
    state.tables = [...state.tables, point].sort((left, right) => Number(left.table_number || 0) - Number(right.table_number || 0));
    persistBootstrapCache();
    renderServicePoints();
    toast(`${label} lista para atender.`, "ok", `service-point:${id}`);
    void (async () => {
      const saved = await retryQuiet(() => state.sb.from("restaurant_tables").insert(point).select("*").single(), 4);
      if (saved) {
        state.tables = state.tables.map((table) => table.id === id ? saved : table);
        persistBootstrapCache();
        return;
      }
      state.tables = original;
      persistBootstrapCache();
      renderServicePoints();
      toast(`No se pudo guardar ${label}. Se retiró del listado.`, "error", `service-point-failed:${id}`);
    })();
  };

  const renderOutdoorTableConfigurator = () => {
    const selector = $("#outdoorTableSelector");
    const from = $("#outdoorTableFrom");
    const to = $("#outdoorTableTo");
    if (!selector || !from || !to) return;
    const tables = normalTables()
      .filter((table) => table.is_active !== false)
      .sort((left, right) => Number(left.table_number || 0) - Number(right.table_number || 0));
    const validIds = new Set(tables.map((table) => String(table.id)));
    if (!state.outdoorTableDraftDirty || !(state.outdoorTableDraftIds instanceof Set)) {
      state.outdoorTableDraftIds = new Set(tables.filter(isOutdoorTable).map((table) => String(table.id)));
    } else {
      state.outdoorTableDraftIds = new Set([...state.outdoorTableDraftIds].filter((id) => validIds.has(String(id))));
    }
    const options = tables.map((table) => `<option value="${escapeHTML(table.id)}">M${escapeHTML(table.table_number)} · ${escapeHTML(table.table_name || "Mesa")}</option>`).join("");
    const previousFrom = from.value;
    const previousTo = to.value;
    from.innerHTML = options || '<option value="">Sin mesas</option>';
    to.innerHTML = options || '<option value="">Sin mesas</option>';
    if (validIds.has(previousFrom)) from.value = previousFrom;
    if (validIds.has(previousTo)) to.value = previousTo;
    else if (tables.length) to.value = String(tables[tables.length - 1].id);
    selector.innerHTML = tables.length
      ? tables.map((table) => `
          <label class="outdoor-table-option">
            <input type="checkbox" data-outdoor-table="${escapeHTML(table.id)}" ${state.outdoorTableDraftIds.has(String(table.id)) ? "checked" : ""}>
            <span>${icon("armchair", 16)} M${escapeHTML(table.table_number)}</span>
          </label>`).join("")
      : emptyState("Sin mesas", "Crea una mesa para poder asignar su ubicación.", "armchair");
    const status = $("#tableZoneSettingStatus");
    if (status) {
      const count = state.outdoorTableDraftIds.size;
      status.textContent = count
        ? `${count} mesa${count === 1 ? "" : "s"} marcada${count === 1 ? "" : "s"} como afuera. Las demás se consideran de adentro.`
        : "Todas las mesas están configuradas como mesas de adentro.";
    }
    refreshIcons();
  };

  const runRefreshAction = async (button, action, successMessage) => {
    if (!button || button.disabled) return false;
    const markup = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `${icon("loader-circle", 17)} Actualizando...`;
    refreshIcons();
    try {
      const refreshed = await action();
      if (refreshed) toast(successMessage, "ok");
      else toast("No fue posible completar la actualización. La información visible se conservó.", "error", `refresh-failed:${button.id}`);
      return Boolean(refreshed);
    } catch (error) {
      console.error(error);
      toast("No fue posible completar la actualización. La información visible se conservó.", "error", `refresh-failed:${button.id}`);
      return false;
    } finally {
      button.disabled = false;
      button.innerHTML = markup;
      refreshIcons();
    }
  };

  const renderBusinessForm = () => {
    const form = $("#businessForm");
    if (!form) return;
    form.business_name.value = state.business?.business_name || "";
    form.subtitle.value = state.business?.subtitle || "";
    form.accent_color.value = state.business?.accent_color || "#f05a28";
    form.currency.value = DEFAULT_CURRENCY;
    form.tips_enabled.checked = tipsEnabled();
    form.tip_percentage.value = String(state.tipSettings?.percentage || 10);
    form.tip_percentage.readOnly = tipsEnabled();
    form.tip_percentage.closest(".tip-percentage-field")?.classList.toggle("is-locked", tipsEnabled());
    const tipStatus = $("#tipSettingStatus");
    if (tipStatus) tipStatus.textContent = tipsEnabled()
      ? `Activa: ${state.tipSettings.percentage}% de propina voluntaria. Apágala para cambiar el porcentaje.`
      : "Configura el porcentaje y enciende el switch para aplicarlo.";
    form.logo_url.value = state.business?.logo_url || "";
    form.cover_url.value = state.business?.cover_url || "";
    ["logo_url", "cover_url"].forEach((field) => {
      const status = $(`[data-upload-status="${field}"]`);
      const box = $(`[data-upload-box="${field}"]`);
      const hasImage = Boolean(form[field]?.value);
      if (status) status.textContent = hasImage ? "Imagen cargada" : "Seleccionar imagen";
      box?.classList.toggle("has-file", hasImage);
    });
    renderOutdoorTableConfigurator();
  };

  const renderTableManager = () => {
    const list = $("#tableManagerList");
    if (!list) return;
    const qrTables = normalTables();
    const validIds = new Set(qrTables.map((table) => String(table.id)));
    state.selectedTableQrIds = new Set(
      [...state.selectedTableQrIds].filter((id) => validIds.has(String(id)))
    );
    const query = normalizeText($("#tableManagerSearch")?.value || "");
    const renderSignature = JSON.stringify({
      query,
      selected: [...state.selectedTableQrIds].sort(),
      tables: qrTables.map((table) => [table.id, table.table_number, table.table_name, table.is_active, table.qr_code, table.qr_image_url])
    });
    if (renderSignature === state.tableManagerRenderSignature) return;
    state.tableManagerRenderSignature = renderSignature;
    const visibleTables = qrTables.filter((table) => !query || normalizeText(`${table.table_number} ${table.table_name || ""}`).includes(query));
    list.innerHTML = visibleTables.length
      ? visibleTables
          .map(
            (table) => `
              <div class="manager-row table-manager-row${state.selectedTableQrIds.has(String(table.id)) ? " is-selected" : ""}">
                <label class="qr-table-checkbox" title="Seleccionar ${escapeHTML(tableLabel(table))}">
                  <input type="checkbox" data-select-table-qr="${table.id}" ${state.selectedTableQrIds.has(String(table.id)) ? "checked" : ""}>
                  <span>${icon("check", 16)}</span>
                </label>
                <div class="qr-mini" data-table-qr="${table.id}"></div>
                <div class="table-manager-copy">
                  <strong>${escapeHTML(tableLabel(table))}</strong>
                  <span>${qrTextForTable(table)}</span>
                </div>
                <div class="row-actions">
                  <button class="icon-btn" data-edit-table="${table.id}" title="Editar" aria-label="Editar mesa">${icon("pencil", 17)}</button>
                  <button class="icon-btn" data-download-qr="${table.id}" title="Descargar" aria-label="Descargar QR en PDF de 9 por 9 centimetros">${icon("file-down", 17)}</button>
                  <button class="icon-btn" data-regenerate-qr="${table.id}" title="Regenerar" aria-label="Rehacer QR">${icon("refresh-cw", 17)}</button>
                  <button class="icon-btn danger" data-delete-table="${table.id}" title="Eliminar" aria-label="Eliminar mesa">${icon("trash-2", 17)}</button>
                </div>
              </div>
            `
          )
          .join("")
      : emptyState(qrTables.length ? "Sin coincidencias" : "Sin mesas", qrTables.length ? "Prueba con otro numero o nombre." : "Agrega una mesa para generar su QR.", "qr-code");
    renderQrBatchControls();
    refreshIcons();
    renderGeneratedTableQrs();
  };

  const renderQrBatchControls = () => {
    const count = state.selectedTableQrIds.size;
    const countLabel = $("#qrSelectionCount");
    const downloadButton = $("#downloadSelectedQrs");
    const selectAllButton = $("#selectAllTableQrs");
    const clearButton = $("#clearTableQrs");
    if (countLabel) countLabel.textContent = `${count} ${count === 1 ? "seleccionada" : "seleccionadas"}`;
    if (downloadButton) {
      downloadButton.disabled = count === 0;
      downloadButton.innerHTML = `${icon("file-down", 18)} Descargar PDF${count ? ` (${count})` : ""}`;
    }
    const qrTableCount = normalTables().length;
    if (selectAllButton) selectAllButton.disabled = !qrTableCount || count === qrTableCount;
    if (clearButton) clearButton.disabled = count === 0;
    refreshIcons();
  };

  const setAllQrSelections = (selected) => {
    const ids = normalTables().map((table) => String(table.id));
    state.selectedTableQrIds = selected ? new Set(ids) : new Set();
    $$('[data-select-table-qr]').forEach((checkbox) => {
      checkbox.checked = selected;
      checkbox.closest(".table-manager-row")?.classList.toggle("is-selected", selected);
    });
    renderQrBatchControls();
  };

  const normalizeTableLookup = (value = "") =>
    normalizeText(value).replace(/mesa/g, "").replace(/\s+/g, "");

  const waiterTableSearchScore = (table, query) => {
    if (!query) return Number(table.table_number || 0);
    const tableNumber = String(table.table_number || "").replace(/\s+/g, "");
    const tableName = normalizeTableLookup(table.table_name || "");
    const fullLabel = normalizeTableLookup(`${table.table_name || ""} mesa ${table.table_number || ""}`);
    if (query === tableNumber) return 0;
    if (query === tableName || query === fullLabel) return 1;
    if (tableNumber.startsWith(query)) return 10 + tableNumber.length;
    if (tableName.startsWith(query) || fullLabel.startsWith(query)) return 20;
    if (tableNumber.includes(query)) return 30 + tableNumber.length;
    if (tableName.includes(query) || fullLabel.includes(query)) return 40;
    return Number.POSITIVE_INFINITY;
  };

  const renderWaiterTableSelect = (searchValue) => {
    const combobox = $("#waiterTableCombobox");
    const options = $("#waiterTableOptions");
    if (!combobox || !options) return;
    const search = $("#waiterTableSearch");
    const status = $("#waiterTableSearchStatus");
    const query = normalizeTableLookup(searchValue === undefined ? search?.value : searchValue);
    const scoredTables = normalTables()
      .filter((table) => table.is_active !== false)
      .map((table) => ({ table, score: waiterTableSearchScore(table, query) }))
      .filter((entry) => Number.isFinite(entry.score));
    const exactMatches = query ? scoredTables.filter((entry) => entry.score <= 1) : [];
    const activeTables = (exactMatches.length ? exactMatches : scoredTables)
      .sort((a, b) => a.score - b.score || Number(a.table.table_number || 0) - Number(b.table.table_number || 0))
      .map((entry) => entry.table);
    const allActiveCount = normalTables().filter((table) => table.is_active !== false).length;
    const autoSelectedTable = query && (exactMatches.length === 1 || activeTables.length === 1)
      ? (exactMatches[0]?.table || activeTables[0])
      : null;
    combobox.dataset.selectedId = autoSelectedTable?.id || "";
    combobox.dataset.activeIndex = autoSelectedTable ? String(activeTables.indexOf(autoSelectedTable)) : "-1";
    options.innerHTML = activeTables.length
      ? activeTables.map((table, index) => {
          const defaultName = `Mesa ${table.table_number}`;
          const name = String(table.table_name || "").trim();
          const hasCustomName = name && name.toLowerCase() !== defaultName.toLowerCase();
          const label = hasCustomName ? name : defaultName;
          const selected = table.id === autoSelectedTable?.id;
          return `
            <button type="button" id="waiter-table-option-${index}" class="smart-table-option${selected ? " is-selected" : ""}"
              data-waiter-table="${escapeHTML(table.id)}" role="option" aria-selected="${selected}">
              <span class="smart-table-option-icon">${icon("map-pin", 18)}</span>
              <span class="smart-table-option-copy">
                <strong>${escapeHTML(label)}</strong>
                <small>${escapeHTML(hasCustomName ? defaultName : `Numero ${table.table_number}`)}</small>
              </span>
              ${selected ? icon("check", 18) : ""}
            </button>`;
        }).join("")
      : `<div class="smart-table-empty">${allActiveCount ? "No encontramos esa mesa" : "No hay mesas activas"}</div>`;
    search?.setAttribute("aria-activedescendant", autoSelectedTable ? `waiter-table-option-${activeTables.indexOf(autoSelectedTable)}` : "");
    if (status) {
      status.classList.toggle("no-results", Boolean(query && !activeTables.length));
      status.textContent = !allActiveCount
        ? "No hay mesas activas."
        : query
          ? activeTables.length
            ? autoSelectedTable
              ? `${tableLabel(autoSelectedTable)} seleccionada. Presiona Enter para abrirla.`
              : `${activeTables.length} mesas coinciden. Toca la que necesitas.`
            : `Ninguna mesa coincide con "${String(searchValue === undefined ? search?.value || "" : searchValue).trim()}".`
          : `${allActiveCount} mesas disponibles.`;
    }
    refreshIcons();
  };

  const showWaiterTableOptions = () => {
    const combobox = $("#waiterTableCombobox");
    const options = $("#waiterTableOptions");
    const search = $("#waiterTableSearch");
    if (!combobox || !options || !search) return;
    options.hidden = false;
    combobox.classList.add("is-open");
    search.setAttribute("aria-expanded", "true");
  };

  const closeWaiterTableOptions = () => {
    const combobox = $("#waiterTableCombobox");
    const options = $("#waiterTableOptions");
    const search = $("#waiterTableSearch");
    if (!combobox || !options || !search) return;
    options.hidden = true;
    combobox.classList.remove("is-open");
    search.setAttribute("aria-expanded", "false");
  };

  const setWaiterTableActiveIndex = (requestedIndex) => {
    const combobox = $("#waiterTableCombobox");
    const options = $("#waiterTableOptions");
    const search = $("#waiterTableSearch");
    const buttons = $$('[data-waiter-table]', options);
    if (!combobox || !search || !buttons.length) return null;
    const index = (requestedIndex + buttons.length) % buttons.length;
    buttons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    const selectedButton = buttons[index];
    combobox.dataset.activeIndex = String(index);
    combobox.dataset.selectedId = selectedButton.dataset.waiterTable || "";
    search.setAttribute("aria-activedescendant", selectedButton.id);
    selectedButton.scrollIntoView({ block: "nearest" });
    return selectedButton;
  };

  const openWaiterTableChoice = async (tableId) => {
    const combobox = $("#waiterTableCombobox");
    if (!tableId || !combobox || combobox.dataset.busy === "true") return;
    combobox.dataset.busy = "true";
    $$('[data-waiter-table]', combobox).forEach((button) => { button.disabled = true; });
    closeWaiterTableOptions();
    try {
      await openScannedTable(tableId);
    } finally {
      const search = $("#waiterTableSearch");
      if (search) search.value = "";
      combobox.dataset.busy = "false";
      renderWaiterTableSelect();
    }
  };

  const openCompactTable = async (tableId) => {
    await openScannedTable(tableId);
  };

  const createWalkInSale = async () => {
    const button = $("#newWalkInSale");
    if (button) button.disabled = true;
    try {
      const existing = state.sessions.find((session) => isLocalWalkInSession(session) && session.status === "open");
      if (existing) {
        openPaymentDialog(existing.id);
        return;
      }
      const openedAt = new Date().toISOString();
      const session = {
        id: uid(),
        local_only: true,
        table_id: null,
        status: "open",
        sale_channel: "walk_in",
        payer_name: "Cliente individual",
        assigned_waiter_id: state.currentUser?.id || null,
        assigned_waiter: state.currentUser,
        restaurant_tables: null,
        session_items: [],
        opened_at: openedAt,
        created_at: openedAt,
        updated_at: openedAt
      };
      state.sessions = [session, ...state.sessions.filter((entry) => entry.id !== session.id)];
      state.optimisticSessionStates.set(session.id, { mode: "upsert", localOnly: true, session });
      persistWalkInDrafts();
      renderAdminLive();
      openPaymentDialog(session.id);
    } finally {
      if (button) button.disabled = false;
    }
  };

  const renderConsumptionProductOptions = (searchValue = "") => {
    const options = $("#consumptionProductOptions");
    const combobox = $("#consumptionProductCombobox");
    const hint = $("#consumptionProductHint");
    if (!options || !combobox) return;
    const products = matchingProducts(searchValue).slice(0, 30);
    state.productPickerMatches = products;
    combobox.dataset.activeIndex = products.length === 1 ? "0" : "-1";
    options.innerHTML = products.length
      ? products.map((item, index) => {
          const inventory = inventoryFor(item);
          const tracked = Object.prototype.hasOwnProperty.call(state.inventoryMeta, item.id);
          const out = tracked && inventory.stock <= 0;
          return `<button type="button" class="product-combobox-option${products.length === 1 ? " is-selected" : ""}" role="option"
            id="consumption-product-${index}" data-consumption-product="${escapeHTML(item.id)}" aria-selected="${products.length === 1}" ${out ? "disabled" : ""}>
            <span class="product-option-code">${escapeHTML(inventory.code)}</span>
            <span><strong>${escapeHTML(item.name)}</strong><small>${money(item.price)} · ${tracked ? `${inventory.stock.toLocaleString("es-CO", { maximumFractionDigits: 2 })} ${escapeHTML(inventory.unit)}` : "Sin stock configurado"}</small></span>
            <em class="${out ? "is-out" : ""}">${out ? "Agotado" : icon("check", 16)}</em>
          </button>`;
        }).join("")
      : `<div class="product-combobox-empty">No hay coincidencias. Puedes escribir el nombre como consumo personalizado.</div>`;
    if (hint) hint.textContent = products.length
      ? `${products.length} producto${products.length === 1 ? "" : "s"}. Busca por nombre o iniciales, por ejemplo CN.`
      : "Sin coincidencias: el nombre escrito puede guardarse como consumo personalizado.";
    refreshIcons();
  };

  const showConsumptionProductOptions = () => {
    const options = $("#consumptionProductOptions");
    const combobox = $("#consumptionProductCombobox");
    const input = $("#consumptionProductSearch");
    if (!options || !combobox || !input) return;
    options.hidden = false;
    combobox.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
  };

  const closeConsumptionProductOptions = () => {
    const options = $("#consumptionProductOptions");
    const combobox = $("#consumptionProductCombobox");
    const input = $("#consumptionProductSearch");
    if (!options || !combobox || !input) return;
    options.hidden = true;
    combobox.classList.remove("is-open");
    input.setAttribute("aria-expanded", "false");
  };

  const selectConsumptionProduct = (id) => {
    const item = state.items.find((entry) => entry.id === id);
    const form = $("#consumptionForm");
    const search = $("#consumptionProductSearch");
    if (!item || !form || !search) return;
    form.menu_item_id.value = item.id;
    form.item_name.value = item.name || "";
    setCurrencyInputValue(form.unit_price, Number(item.price || 0));
    form.quantity.value = "";
    search.value = `${inventoryFor(item).code} · ${item.name}`;
    closeConsumptionProductOptions();
    $("#consumptionProductHint") && ($("#consumptionProductHint").textContent = `${item.name} seleccionado · escribe la cantidad y presiona Enter.`);
    window.requestAnimationFrame(() => {
      form.quantity.focus({ preventScroll: true });
    });
  };

  const setConsumptionProductActiveIndex = (requestedIndex) => {
    const options = $("#consumptionProductOptions");
    const input = $("#consumptionProductSearch");
    const buttons = $$('[data-consumption-product]:not(:disabled)', options);
    if (!buttons.length || !input) return null;
    const index = (requestedIndex + buttons.length) % buttons.length;
    buttons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    $("#consumptionProductCombobox").dataset.activeIndex = String(index);
    input.setAttribute("aria-activedescendant", buttons[index].id);
    buttons[index].scrollIntoView({ block: "nearest" });
    return buttons[index];
  };

  const renderMenuManager = () => {
    const categorySelects = $$(".js-category-select");
    categorySelects.forEach((select) => {
      const excludedInventoryCategories = new Set(["entrada", "entradas", "plato fuerte", "platos fuertes", "postre", "postres"]);
      const categories = select.closest("#inventoryForm")
        ? state.categories.filter((category) => !excludedInventoryCategories.has(normalizeText(category.name)))
        : state.categories;
      select.innerHTML = `
        <option value="">Elegir categoria</option>
        ${categories.map((category) => `<option value="${escapeHTML(category.id)}">${escapeHTML(category.name)}</option>`).join("")}
      `;
    });

    renderConsumptionProductOptions($("#consumptionProductSearch")?.value || "");

    const categoryList = $("#categoryList");
    if (categoryList) {
      categoryList.innerHTML = state.categories.length
        ? state.categories
            .map(
              (category) => `
                <div class="manager-row category-manager-row">
                  <div class="category-token">${icon("tag", 16)}</div>
                  <div>
                    <strong>${escapeHTML(category.name)}</strong>
                    <span>Orden ${category.sort_order || 0} · ${category.is_active ? "Visible" : "Oculta"}</span>
                  </div>
                  <div class="row-actions">
                    <button class="icon-btn" data-edit-category="${category.id}" aria-label="Editar categoria">${icon("pencil", 17)}</button>
                    <button class="icon-btn danger" data-delete-category="${category.id}" aria-label="Eliminar categoria">${icon("trash-2", 17)}</button>
                  </div>
                </div>
              `
            )
            .join("")
        : emptyState("Sin categorias", "Crea categorias para ordenar el menu.", "tags");
    }

    const itemList = $("#itemList");
    if (itemList) {
      itemList.innerHTML = state.items.length
        ? state.items
            .map(
              (item) => `
                <div class="manager-row item-row product-manager-row">
                  <div class="product-thumb">
                    ${
                      item.image_url
                        ? `<img src="${escapeHTML(item.image_url)}" alt="${escapeHTML(item.name)}">`
                        : icon("utensils", 20)
                    }
                  </div>
                  <div class="product-manager-copy">
                    <strong>${escapeHTML(item.name)}</strong>
                    <span>${escapeHTML(item.description || "Sin descripcion")}</span>
                    <div class="product-badges">
                      <em>${item.menu_categories?.name || "Sin categoria"}</em>
                      <em class="${item.is_available ? "is-on" : "is-off"}">${item.is_available ? "Disponible" : "Oculto"}</em>
                    </div>
                  </div>
                  <strong class="product-price">${money(item.price)}</strong>
                  <div class="row-actions">
                    <button class="icon-btn" data-edit-item="${item.id}" aria-label="Editar producto">${icon("pencil", 17)}</button>
                    <button class="icon-btn danger" data-delete-item="${item.id}" aria-label="Eliminar producto">${icon("trash-2", 17)}</button>
                  </div>
                </div>
              `
            )
            .join("")
        : emptyState("Sin productos", "Agrega platos, bebidas o servicios.", "chef-hat");
    }
    refreshIcons();
  };

  const inventorySummary = () => state.items.reduce((summary, item) => {
    const inventory = inventoryFor(item);
    summary.units += inventory.stock;
    summary.costValue += inventory.stock * inventory.costPrice;
    summary.saleValue += inventory.stock * Number(item.price || 0);
    const status = inventoryStatus(item);
    if (status === "low") summary.low += 1;
    if (status === "out") summary.out += 1;
    return summary;
  }, { units: 0, costValue: 0, saleValue: 0, low: 0, out: 0 });

  const renderInventoryLiveCalculation = () => {
    const form = $("#inventoryForm");
    const box = $("#inventoryLiveCalculation");
    if (!form || !box) return;
    const cost = currencyInputNumber(form.cost_price);
    const sale = currencyInputNumber(form.sale_price);
    const stock = Math.max(0, Number(form.stock.value || 0));
    const profit = sale - cost;
    const margin = sale > 0 ? (profit / sale) * 100 : 0;
    box.innerHTML = `
      <span><small>Utilidad por unidad</small><strong>${money(profit)}</strong></span>
      <span><small>Margen estimado</small><strong>${margin.toLocaleString("es-CO", { maximumFractionDigits: 1 })}%</strong></span>
      <span><small>Valor del inventario</small><strong>${money(cost * stock)}</strong></span>
      <span><small>Venta potencial</small><strong>${money(sale * stock)}</strong></span>`;
  };

  const renderInventoryCategoryFilter = () => {
    const select = $("#inventoryCategoryFilter");
    if (!select) return;
    const categories = [...state.categories]
      .filter((category) => category?.id && state.items.some((item) => String(item.category_id || "") === String(category.id)))
      .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || String(left.name || "").localeCompare(String(right.name || ""), "es"));
    const validIds = new Set(categories.map((category) => String(category.id)));
    const hasUncategorized = state.items.some((item) => !item.category_id);
    if (state.inventoryCategoryFilter !== "all"
      && state.inventoryCategoryFilter !== "uncategorized"
      && !validIds.has(String(state.inventoryCategoryFilter))) {
      state.inventoryCategoryFilter = "all";
    }
    if (state.inventoryCategoryFilter === "uncategorized" && !hasUncategorized) state.inventoryCategoryFilter = "all";
    select.innerHTML = [
      '<option value="all">Todas</option>',
      ...categories.map((category) => `<option value="${escapeHTML(category.id)}">${escapeHTML(category.name || "Sin categoría")}</option>`),
      ...(hasUncategorized ? ['<option value="uncategorized">Sin categoría</option>'] : [])
    ].join("");
    select.value = state.inventoryCategoryFilter;
  };

  const renderInventory = () => {
    const metrics = $("#inventoryMetrics");
    const list = $("#inventoryList");
    if (!metrics || !list) return;
    const summary = inventorySummary();
    metrics.innerHTML = `
      <article><span>${icon("package-check", 19)} Unidades</span><strong>${summary.units.toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong><small>Existencia total registrada</small></article>
      <article><span>${icon("circle-dollar-sign", 19)} Inversion</span><strong>${money(summary.costValue)}</strong><small>Inventario registrado</small></article>
      <article><span>${icon("trending-up", 19)} Venta potencial</span><strong>${money(summary.saleValue)}</strong><small>Estimado al vender todo</small></article>
      <article class="${summary.low || summary.out ? "inventory-alert-metric" : ""}"><span>${icon("triangle-alert", 19)} Alertas</span><strong>${summary.low + summary.out}</strong><small>${summary.out} agotados · ${summary.low} por reponer</small></article>`;

    renderInventoryCategoryFilter();
    const query = state.inventorySearch;
    const products = matchingProducts(query, { includeUnavailable: true })
      .filter((item) => state.inventoryStatusFilter === "all" || inventoryStatus(item) === state.inventoryStatusFilter)
      .filter((item) => state.inventoryCategoryFilter === "all"
        || (state.inventoryCategoryFilter === "uncategorized" ? !item.category_id : String(item.category_id || "") === String(state.inventoryCategoryFilter)));
    list.innerHTML = products.length
      ? products.map((item) => {
          const inventory = inventoryFor(item);
          const status = inventoryStatus(item);
          const statusLabel = status === "out" ? "Agotado" : status === "low" ? "Stock bajo" : "Disponible";
          const profit = Number(item.price || 0) - inventory.costPrice;
          const margin = Number(item.price || 0) > 0 ? profit / Number(item.price) * 100 : 0;
          return `
            <article class="inventory-row inventory-${status}">
              <div class="inventory-product-identity">
                <span class="inventory-code">${escapeHTML(inventory.code)}</span>
                <div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.menu_categories?.name || "Sin categoria")} · ${escapeHTML(inventory.unit)}</small></div>
              </div>
              <div class="inventory-stock-block">
                <small>Existencia</small>
                <strong>${inventory.stock.toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong>
                <span class="inventory-status">${statusLabel}</span>
              </div>
              <div class="inventory-numbers">
                <span><small>Costo</small><strong>${money(inventory.costPrice)}</strong></span>
                <span><small>Venta</small><strong>${money(item.price)}</strong></span>
                <span class="inventory-profit"><small>Utilidad</small><strong>${money(profit)}</strong><em>${margin.toLocaleString("es-CO", { maximumFractionDigits: 1 })}% margen</em></span>
              </div>
              <div class="inventory-row-actions">
                <button class="ghost small inventory-adjust-trigger" type="button" data-inventory-adjust="${escapeHTML(item.id)}">${icon("package-plus", 16)} Unidades</button>
                <button class="icon-btn" type="button" data-edit-inventory="${escapeHTML(item.id)}" aria-label="Editar ${escapeHTML(item.name)}">${icon("pencil", 17)}</button>
                <button class="icon-btn danger" type="button" data-delete-item="${escapeHTML(item.id)}" aria-label="Eliminar ${escapeHTML(item.name)}">${icon("trash-2", 17)}</button>
              </div>
            </article>`;
        }).join("")
      : emptyState("Sin coincidencias", query ? `No encontramos productos para “${escapeHTML(query)}”. Prueba el nombre o sus iniciales.` : "Agrega el primer producto al inventario.", "search-x");
    renderInventoryLiveCalculation();
    refreshIcons();
  };

  const movementKind = (movement) => Number(movement.delta ?? movement.quantityChange ?? 0) >= 0 ? "entry" : "exit";

  const renderInventoryMovements = (appendIds = null) => {
    const list = $("#inventoryMovementList");
    const summary = $("#movementSummary");
    if (!list || !summary) return;
    const query = normalizeText(state.movementSearch);
    const movements = [...state.inventoryMovements]
      .filter((movement) => state.movementTypeFilter === "all" || movementKind(movement) === state.movementTypeFilter)
      .filter((movement) => !query || normalizeText([movement.product, movement.code, movement.type, movement.reference, movement.user].join(" ")).includes(query))
      .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
    const entries = movements.filter((movement) => movementKind(movement) === "entry").reduce((sum, movement) => sum + Number(movement.delta || 0), 0);
    const exits = movements.filter((movement) => movementKind(movement) === "exit").reduce((sum, movement) => sum + Math.abs(Number(movement.delta || 0)), 0);
    summary.innerHTML = `<article class="movement-kpi entry">${icon("arrow-down-to-line", 19)}<span><small>Unidades ingresadas</small><strong>+${entries.toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong></span></article><article class="movement-kpi exit">${icon("arrow-up-from-line", 19)}<span><small>Unidades retiradas</small><strong>-${exits.toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong></span></article><article class="movement-kpi">${icon("list-checks", 19)}<span><small>Movimientos visibles</small><strong>${movements.length}</strong></span></article>`;
    const append = appendIds instanceof Set && Boolean(list.querySelector(".movement-row"));
    const visibleRows = append ? movements.filter((movement) => appendIds.has(String(movement.movementId))) : movements;
    const markup = visibleRows.length ? visibleRows.map((movement) => {
      const delta = Number(movement.delta ?? movement.quantityChange ?? 0);
      const kind = delta >= 0 ? "entry" : "exit";
      return `<article class="movement-row ${kind}"><span class="movement-direction">${icon(kind === "entry" ? "arrow-down-left" : "arrow-up-right", 20)}</span><div class="movement-product"><strong>${escapeHTML(movement.product || "Producto")}</strong><small>${escapeHTML(movement.code || "")}${movement.reference ? ` · ${escapeHTML(movement.reference)}` : ""}</small></div><div><small>Movimiento</small><strong>${escapeHTML(String(movement.type || (kind === "entry" ? "ENTRADA" : "SALIDA")).replaceAll("_", " "))}</strong></div><div><small>Existencia</small><strong>${Number(movement.before || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 })} → ${Number(movement.after || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong></div><strong class="movement-delta">${delta > 0 ? "+" : ""}${delta.toLocaleString("es-CO", { maximumFractionDigits: 2 })}</strong><div class="movement-audit"><span><strong>${escapeHTML(movement.user || "Sistema")}</strong><small>${escapeHTML(prettyDateTime(movement.date))}</small></span><button class="icon-btn danger" type="button" data-delete-movement="${escapeHTML(movement.movementId)}" aria-label="Eliminar movimiento y restaurar existencias">${icon("trash-2", 16)}</button></div></article>`;
    }).join("") : "";
    if (append) {
      if (markup) list.insertAdjacentHTML("beforeend", markup);
    } else {
      list.innerHTML = markup || emptyState("Sin movimientos", query ? "No hay coincidencias para este filtro." : "Las entradas y salidas apareceran aqui con su responsable.", "arrow-left-right");
    }
    const more = $("#loadMoreMovements");
    if (more) more.hidden = !state.movementNextBeforeRow;
    refreshIcons();
  };

  const pendingInventoryMovementIds = () => {
    const ids = new Set();
    readAppsScriptOutbox().forEach((job) => {
      if (job.action === "adjust_inventory" && job.payload?.adjustment?.eventId) {
        ids.add(String(job.payload.adjustment.eventId));
      }
      if (job.action === "upsert_inventory" && job.payload?.item?.movementEventId) {
        ids.add(String(job.payload.item.movementEventId));
      }
      if (job.action === "record_sale" && job.payload?.invoice) {
        const invoice = job.payload.invoice;
        const saleId = String(invoice.id || invoice.sessionId || "");
        (invoice.items || []).forEach((line) => {
          if (saleId && line.menu_item_id) ids.add(`SALE-${saleId}-${line.menu_item_id}`);
        });
      }
    });
    return ids;
  };

  const loadInventoryMovements = async () => {
    if (!isAppsScriptConfigured() || !state.currentUser) return false;
    const requestId = ++state.movementRequestId;
    state.movementNextBeforeRow = null;
    const more = $("#loadMoreMovements");
    if (more) more.hidden = true;
    try {
      const result = await appsScriptRequest("get_inventory_movements", { limit: 800 });
      if (!result?.ok || !Array.isArray(result.movements)) throw new Error(result?.error || "El historial remoto devolvió una respuesta inválida.");
      if (requestId !== state.movementRequestId) return false;
      const pendingIds = pendingInventoryMovementIds();
      const merged = new Map(state.inventoryMovements
        .filter((movement) => pendingIds.has(String(movement.movementId || "")))
        .map((movement) => [movement.movementId, movement]));
      result.movements.forEach((movement) => merged.set(movement.movementId, movement));
      state.inventoryMovements = Array.from(merged.values()).slice(-3000);
      state.movementNextBeforeRow = result.hasMore ? Number(result.nextBeforeRow) || null : null;
      persistInventoryMovements();
      if (state.activeAdminSection === "movements") renderInventoryMovements();
      return true;
    } catch (error) {
      if (requestId !== state.movementRequestId) return false;
      if (state.activeAdminSection === "movements") renderInventoryMovements();
      return false;
    }
  };

  const loadMoreInventoryMovements = async () => {
    if (state.movementLoadingMore || !state.movementNextBeforeRow || !isAppsScriptConfigured()) return false;
    const button = $("#loadMoreMovements");
    const beforeRow = state.movementNextBeforeRow;
    const requestId = state.movementRequestId;
    state.movementLoadingMore = true;
    if (button) {
      button.disabled = true;
      button.textContent = "Cargando movimientos...";
    }
    try {
      const result = await appsScriptRequest("get_inventory_movements", { limit: 800, beforeRow });
      if (!result?.ok || !Array.isArray(result.movements)) throw new Error(result?.error || "No se pudieron cargar más movimientos.");
      if (requestId !== state.movementRequestId) return false;
      const previousOldestDate = state.inventoryMovements.reduce((oldest, movement) => {
        const date = String(movement.date || "");
        return !oldest || date < oldest ? date : oldest;
      }, "");
      const knownIds = new Set(state.inventoryMovements.map((movement) => String(movement.movementId)));
      const additions = result.movements.filter((movement) => !knownIds.has(String(movement.movementId)));
      state.inventoryMovements.push(...additions);
      state.movementNextBeforeRow = result.hasMore ? Number(result.nextBeforeRow) || null : null;
      persistInventoryMovements();
      if (state.activeAdminSection === "movements") {
        const appendInOrder = additions.every((movement) => String(movement.date || "") <= previousOldestDate);
        renderInventoryMovements(appendInOrder ? new Set(additions.map((movement) => String(movement.movementId))) : null);
      }
      return true;
    } catch (error) {
      if (requestId === state.movementRequestId) toast(String(error?.message || error), "error", "more-movements-failed");
      return false;
    } finally {
      state.movementLoadingMore = false;
      if (button) {
        button.disabled = false;
        button.textContent = "Ver más movimientos";
      }
    }
  };

  const resetInventoryForm = ({ open = false } = {}) => {
    const form = $("#inventoryForm");
    if (!form) return;
    form.reset();
    form.product_id.value = "";
    form.stock.value = "";
    form.min_stock.value = 5;
    form.unit.value = "unidad";
    form.is_available.checked = true;
    $("#inventoryFormTitle") && ($("#inventoryFormTitle").textContent = "Agregar producto");
    renderInventoryLiveCalculation();
    if (open) {
      $("#inventoryDialog")?.showModal();
      window.setTimeout(() => form.product_name.focus({ preventScroll: true }), 0);
    }
  };

  const editInventoryProduct = (id) => {
    const item = state.items.find((entry) => entry.id === id);
    const form = $("#inventoryForm");
    if (!item || !form) return;
    const inventory = inventoryFor(item);
    form.product_id.value = item.id;
    form.product_name.value = item.name || "";
    form.product_code.value = inventory.code;
    form.category_id.value = item.category_id || "";
    form.new_category.value = "";
    setCurrencyInputValue(form.cost_price, inventory.costPrice);
    setCurrencyInputValue(form.sale_price, Number(item.price || 0));
    form.stock.value = inventory.stock;
    form.min_stock.value = inventory.minStock;
    form.unit.value = inventory.unit;
    form.is_available.checked = item.is_available !== false;
    $("#inventoryFormTitle") && ($("#inventoryFormTitle").textContent = `Editar ${item.name}`);
    renderInventoryLiveCalculation();
    $("#inventoryDialog")?.showModal();
    window.setTimeout(() => form.product_name.focus({ preventScroll: true }), 0);
  };

  const saveInventoryProduct = async (form) => {
    const name = form.product_name.value.trim();
    const costPrice = currencyInputNumber(form.cost_price);
    const salePrice = currencyInputNumber(form.sale_price);
    const stock = Number(form.stock.value || 0);
    const minStock = Number(form.min_stock.value || 0);
    if (!name || ![costPrice, salePrice, stock, minStock].every(Number.isFinite) || [costPrice, salePrice, stock, minStock].some((value) => value < 0)) {
      toast("Revisa nombre, precios y existencias antes de guardar.", "error", "invalid-inventory-product");
      return;
    }
    const id = form.product_id.value;
    if (!id && costPrice === salePrice) {
      const dialog = $("#zeroProfitDialog");
      if (!dialog) return;
      dialog.returnValue = "";
      dialog.showModal();
      refreshIcons();
      const confirmed = await new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
      if (!confirmed) return;
    }
    const previousInventory = id ? inventoryFor(state.items.find((item) => item.id === id)) : null;
    let categoryId = form.category_id.value;
    const newCategory = form.new_category.value.trim();
    if (!categoryId && newCategory) {
      const category = await db(state.sb.from("menu_categories").insert({ name: newCategory, is_active: true }).select("*").single(), null);
      if (!category) return;
      state.categories = [...state.categories, category];
      categoryId = category.id;
    }
    const payload = {
      category_id: categoryId || null,
      name,
      price: salePrice,
      description: state.items.find((item) => item.id === id)?.description || "",
      image_url: state.items.find((item) => item.id === id)?.image_url || "",
      is_available: form.is_available.checked,
      sort_order: state.items.find((item) => item.id === id)?.sort_order || 0
    };
    const saved = await db(id
      ? state.sb.from("menu_items").update(payload).eq("id", id).select("*").single()
      : state.sb.from("menu_items").insert(payload).select("*").single(), null);
    if (!saved) return;
    const category = state.categories.find((entry) => entry.id === categoryId);
    const hydrated = { ...saved, menu_categories: category ? { name: category.name } : null };
    state.items = id
      ? state.items.map((item) => item.id === id ? hydrated : item)
      : [...state.items, hydrated];
    state.inventoryMeta[saved.id] = {
      code: (form.product_code.value.trim() || productAcronym(name)).toUpperCase(),
      costPrice,
      stock,
      minStock,
      unit: form.unit.value || "unidad",
      updatedAt: new Date().toISOString()
    };
    const beforeStock = Number(previousInventory?.stock || 0);
    const stockDelta = stock - beforeStock;
    const movementEventId = (!id || stockDelta) ? `product:${saved.id}:${Date.now()}` : "";
    if (movementEventId) {
      recordLocalInventoryMovement({
        eventId: movementEventId,
        item: hydrated,
        delta: stockDelta,
        before: beforeStock,
        after: stock,
        type: id ? (stockDelta > 0 ? "ENTRADA_EDICION" : "SALIDA_EDICION") : "NUEVO_PRODUCTO",
        reference: id ? "Edicion de producto" : "Registro inicial"
      });
    }
    persistInventoryStore();
    persistBootstrapCache();
    queueInventoryUpsert(hydrated, movementEventId ? {
      movementEventId,
      movementType: id ? (stockDelta > 0 ? "ENTRADA_EDICION" : "SALIDA_EDICION") : "NUEVO_PRODUCTO",
      movementReference: id ? "Edicion de producto" : "Registro inicial"
    } : {});
    resetInventoryForm();
    $("#inventoryDialog")?.close();
    renderMenuManager();
    renderInventory();
    toast(id ? "Producto e inventario actualizados." : "Producto agregado al inventario.");
  };

  const renderInventoryAdjustmentPreview = () => {
    const form = $("#inventoryAdjustForm");
    const target = $("#inventoryAdjustResult");
    if (!form || !target) return;
    const item = state.items.find((entry) => entry.id === form.product_id.value);
    if (!item) return;
    const current = inventoryFor(item).stock;
    const quantity = Math.max(0, Number(form.quantity.value || 0));
    const subtract = form.operation.value === "subtract";
    const next = subtract ? current - quantity : current + quantity;
    target.classList.toggle("is-invalid", next < 0);
    target.innerHTML = `<span>Quedará en</span><strong>${Math.max(0, next).toLocaleString("es-CO", { maximumFractionDigits: 2 })} ${escapeHTML(inventoryFor(item).unit)}${next === 1 ? "" : "s"}</strong>${next < 0 ? "<small>No puedes retirar más de lo disponible.</small>" : "<small>Este ajuste no se agrega a Movimientos.</small>"}`;
  };

  const openInventoryAdjustment = (id) => {
    const item = state.items.find((entry) => entry.id === id);
    const form = $("#inventoryAdjustForm");
    if (!item || !form) return;
    const current = inventoryFor(item);
    form.reset();
    form.product_id.value = item.id;
    form.operation.value = "add";
    form.quantity.value = "1";
    $("#inventoryAdjustTitle").textContent = item.name;
    $("#inventoryAdjustCurrent").textContent = `Existencia actual: ${current.stock.toLocaleString("es-CO", { maximumFractionDigits: 2 })} ${current.unit}${current.stock === 1 ? "" : "s"}.`;
    renderInventoryAdjustmentPreview();
    $("#inventoryAdjustDialog")?.showModal();
    window.setTimeout(() => form.quantity.select(), 0);
    refreshIcons();
  };

  const saveInventoryAdjustment = (form) => {
    const id = form.product_id.value;
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    const current = inventoryFor(item);
    const quantity = Number(form.quantity.value || 0);
    const delta = form.operation.value === "subtract" ? -quantity : quantity;
    const nextStock = current.stock + delta;
    if (!Number.isFinite(quantity) || quantity <= 0 || nextStock < 0) {
      toast(nextStock < 0 ? "No puedes retirar más unidades de las disponibles." : "Escribe una cantidad mayor que cero.", "error", `invalid-stock-adjustment:${id}`);
      return;
    }
    state.inventoryMeta[id] = {
      ...current,
      code: current.code,
      stock: nextStock,
      updatedAt: new Date().toISOString()
    };
    persistInventoryStore();
    enqueueAppsScriptJob("set_inventory_stock", {
      productId: item.id,
      stock: nextStock,
      updatedAt: state.inventoryMeta[id].updatedAt,
      version: current.version
    }, `inventory-stock:${item.id}`);
    $("#inventoryAdjustDialog")?.close();
    renderInventory();
    toast(`Existencia de ${item.name} actualizada a ${nextStock.toLocaleString("es-CO", { maximumFractionDigits: 2 })}.`, "ok", `stock-adjusted:${id}:${nextStock}`);
  };

  const dateInputValue = (date) => {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return "";
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const shiftedDate = (date, days) => {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    next.setDate(next.getDate() + days);
    return next;
  };

  const incomeRangeDates = (preset = "month") => {
    const today = new Date(`${incomeRecordDateKey(new Date())}T12:00:00`);
    let from = today;
    let to = today;
    if (preset === "yesterday") from = to = shiftedDate(today, -1);
    if (preset === "7days") from = shiftedDate(today, -6);
    if (preset === "15days") from = shiftedDate(today, -14);
    if (preset === "30days") from = shiftedDate(today, -29);
    if (preset === "month") from = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    if (preset === "year") from = new Date(today.getFullYear(), 0, 1, 12);
    return { dateFrom: dateInputValue(from), dateTo: dateInputValue(to) };
  };

  const markIncomeRangePreset = () => {
    $$('[data-income-range]').forEach((button) => {
      const active = button.dataset.incomeRange === state.incomeRangePreset;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const apply = $("#incomeFilterForm button[type='submit']");
    if (apply) apply.hidden = state.incomeRangePreset !== "custom";
  };

  const initializeIncomeFilters = () => {
    const from = $("#incomeDateFrom");
    const to = $("#incomeDateTo");
    if (!from || !to) return;
    if (!from.value || !to.value) {
      const range = incomeRangeDates(state.incomeRangePreset);
      from.value = range.dateFrom;
      to.value = range.dateTo;
    }
    markIncomeRangePreset();
  };

  const setIncomeRange = (preset, refresh = true) => {
    const range = incomeRangeDates(preset);
    const from = $("#incomeDateFrom");
    const to = $("#incomeDateTo");
    if (!from || !to) return;
    state.incomeRangePreset = preset;
    from.value = range.dateFrom;
    to.value = range.dateTo;
    markIncomeRangePreset();
    if (refresh) void loadIncomeReport();
  };

  const incomeFiltersFromForm = () => {
    initializeIncomeFilters();
    return {
      dateFrom: $("#incomeDateFrom")?.value || dateInputValue(new Date()),
      dateTo: $("#incomeDateTo")?.value || dateInputValue(new Date()),
      paymentMethod: $("#incomePaymentMethod")?.value || "all",
      query: $("#incomeSearch")?.value.trim() || "",
      limit: 300
    };
  };

  const incomePaymentLabel = (method) => ({
    cash: "Efectivo",
    transfer: "Transferencia",
    breb: "Bre-B",
    mixed: "Mixto"
  }[method] || "Otro");

  const incomeRecordDateKey = (value) => {
    const text = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return text.slice(0, 10);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  };

  const incomeTotalsFromRecords = (records = []) => {
    const totals = records.reduce((summary, record) => {
      summary.income += Number(record.total || 0);
      summary.sales += 1;
      summary.subtotal += Number(record.subtotal || 0);
      summary.discount += Number(record.discount || 0);
      summary.tax += Number(record.tax || 0);
      summary.service += Number(record.service || 0);
      summary.cost += Number(record.cost || 0);
      summary.profit += Number(record.profit || 0);
      (record.payments || []).forEach((payment) => {
        const method = ["cash", "transfer", "breb"].includes(payment.method) ? payment.method : "other";
        summary[method] += Number(payment.amount || 0);
      });
      return summary;
    }, { income: 0, sales: 0, subtotal: 0, discount: 0, tax: 0, service: 0, cost: 0, profit: 0, cash: 0, transfer: 0, breb: 0, other: 0 });
    totals.averageTicket = totals.sales ? totals.income / totals.sales : 0;
    return totals;
  };

  const localIncomeRecords = (filters) => {
    const query = normalizeText(filters.query || "");
    return state.invoiceHistory.map((invoice) => {
      const items = (invoice.items || []).map((line) => {
        const quantity = Number(line.quantity || 0);
        const unitPrice = Number(line.unit_price || 0);
        const unitCost = Number(line.unit_cost ?? state.inventoryMeta[line.menu_item_id]?.costPrice ?? 0);
        return {
          lineId: line.id || "",
          menuItemId: line.menu_item_id || null,
          name: line.item_name || "Producto",
          quantity,
          unitPrice,
          total: quantity * unitPrice,
          cost: quantity * unitCost,
          profit: quantity * (unitPrice - unitCost)
        };
      });
      const cost = items.reduce((sum, item) => sum + item.cost, 0);
      const total = Number(invoice.totals?.total || 0);
      const payments = (invoice.payments || []).map((payment) => ({ method: payment.method, amount: Number(payment.amount || 0), reference: invoice.reference || "" }));
      return {
        saleId: invoice.id || invoice.sessionId,
        invoice: invoice.number || "Factura",
        sessionId: invoice.sessionId || "",
        table: invoice.table || "Mesa",
        date: invoice.createdAt || new Date().toISOString(),
        payer: invoice.payerName || "",
        waiter: invoice.waiterName || "",
        subtotal: Number(invoice.totals?.subtotal || 0),
        discount: Number(invoice.totals?.discount || 0),
        tax: Number(invoice.totals?.tax || 0),
        service: Number(invoice.totals?.serviceFee || 0),
        total,
        cost,
        profit: total - cost,
        reference: invoice.reference || "",
        isMixed: invoice.paymentMethod === "mixed" || payments.length > 1,
        payments,
        items
      };
    }).filter((record) => {
      const dateKey = incomeRecordDateKey(record.date);
      if (dateKey < filters.dateFrom || dateKey > filters.dateTo) return false;
      if (filters.paymentMethod === "mixed" && !record.isMixed) return false;
      if (!["all", "mixed"].includes(filters.paymentMethod) && !record.payments.some((payment) => payment.method === filters.paymentMethod)) return false;
      const haystack = normalizeText([record.invoice, record.table, record.payer, record.waiter, record.reference, record.items.map((item) => item.name).join(" ")].join(" "));
      return !query || haystack.includes(query);
    }).sort((left, right) => String(right.date).localeCompare(String(left.date)));
  };

  const localIncomeReport = (filters, error = "") => {
    const records = localIncomeRecords(filters);
    return {
      filters,
      totals: incomeTotalsFromRecords(records),
      records,
      recordKeys: records.map((record) => record.saleId),
      totalRecords: records.length,
      truncated: false,
      localOnly: true,
      error
    };
  };

  const incomeReportIdentityKeys = (report = {}) => new Set([
    ...(report.recordKeys || []),
    ...(report.sessionKeys || []),
    ...(report.records || []).flatMap((record) => [record.saleId, record.sessionId])
  ].map(String).filter(Boolean));

  const recoveredInvoiceFromClosedSession = (session) => {
    const localInvoice = state.invoiceHistory.find((invoice) => String(invoice.sessionId || "") === String(session.id || ""));
    if (localInvoice) return localInvoice;
    const items = (session.session_items || [])
      .filter((item) => item.status !== "cancelled")
      .map((item) => ({
        id: item.id,
        menu_item_id: item.menu_item_id || null,
        item_name: item.item_name || "Producto",
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || 0),
        unit_cost: Number(state.inventoryMeta[item.menu_item_id]?.costPrice || 0),
        status: item.status
      }));
    const tableNumber = session.restaurant_tables?.table_number;
    const tableName = session.restaurant_tables?.table_name;
    const table = tableName || (tableNumber ? `Mesa ${tableNumber}` : "Venta individual");
    const createdAt = session.closed_at || session.updated_at || new Date().toISOString();
    const method = ["cash", "transfer", "breb"].includes(String(session.payment_method || "").toLowerCase())
      ? String(session.payment_method).toLowerCase()
      : "other";
    const total = Number(session.total || 0);
    return {
      id: String(session.id),
      number: `REC-${String(createdAt).slice(0, 10).replaceAll("-", "")}-${tableNumber || String(session.id).slice(0, 6).toUpperCase()}`,
      sessionId: String(session.id),
      tableId: session.table_id || null,
      table,
      saleChannel: session.sale_channel || "table",
      soldByUserId: session.assigned_waiter_id || null,
      createdAt,
      payerName: session.payer_name || "",
      waiterName: state.users.find((user) => String(user.id) === String(session.assigned_waiter_id || ""))?.full_name || "",
      paymentMethod: method,
      payments: [{ method, amount: total }],
      reference: "RECUPERADA DESDE MOVIMIENTOS",
      inventoryAdjustedOnConsumption: true,
      totals: {
        subtotal: Number(session.subtotal || items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)),
        discount: Number(session.discount || 0),
        tax: Number(session.tax || 0),
        serviceFee: Number(session.service_fee || 0),
        total
      },
      items
    };
  };

  const queueIncomeRecoveryFromMovements = async (remoteReport) => {
    if (!await loadInventoryMovements()) return 0;
    const deletedSessions = new Set(state.inventoryMovements
      .filter((movement) => String(movement.type || "").toUpperCase() === "VENTA_ELIMINADA")
      .map((movement) => String(movement.sessionId || ""))
      .filter(Boolean));
    const sessionIds = new Set(state.inventoryMovements
      .map((movement) => String(movement.sessionId || ""))
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && !deletedSessions.has(id)));
    state.invoiceHistory.forEach((invoice) => {
      const id = String(invoice.sessionId || "");
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && !deletedSessions.has(id)) sessionIds.add(id);
    });
    if (!sessionIds.size) return 0;

    const closedSessions = [];
    const ids = Array.from(sessionIds).slice(-500);
    for (let index = 0; index < ids.length; index += 50) {
      const { data, error } = await state.sb
        .from("table_sessions")
        .select("*, restaurant_tables(table_number, table_name), session_items(*)")
        .eq("status", "closed")
        .gt("total", 0)
        .in("id", ids.slice(index, index + 50));
      if (error) throw error;
      closedSessions.push(...(data || []));
    }

    const remoteKeys = incomeReportIdentityKeys(remoteReport);
    const jobs = readAppsScriptOutbox();
    let queued = 0;
    const reportFilters = remoteReport.filters || {};
    closedSessions.forEach((session) => {
      const dateKey = incomeRecordDateKey(session.closed_at || session.updated_at);
      if (dateKey < reportFilters.dateFrom || dateKey > reportFilters.dateTo) return;
      if (remoteKeys.has(String(session.id))) return;
      const invoice = recoveredInvoiceFromClosedSession(session);
      const saleId = String(invoice.id || invoice.sessionId || "");
      if (!saleId || remoteKeys.has(saleId)) return;
      const alreadyQueued = jobs.some((job) => job.action === "record_sale"
        && String(job.payload?.invoice?.sessionId || "") === String(invoice.sessionId));
      if (alreadyQueued) return;
      if (!state.invoiceHistory.some((entry) => String(entry.sessionId || "") === String(invoice.sessionId))) {
        state.invoiceHistory.push(invoice);
      }
      jobs.push({
        id: uid(),
        action: "record_sale",
        payload: { invoice },
        dedupeKey: `sale:${invoice.sessionId}`,
        attempts: 0,
        createdAt: new Date().toISOString()
      });
      queued += 1;
    });
    if (queued) {
      persistInvoiceHistory();
      writeAppsScriptOutbox(jobs);
    }
    return queued;
  };

  const mergeIncomeReport = (remote, filters) => {
    const remoteKeys = new Set(remote.recordKeys || (remote.records || []).map((record) => record.saleId));
    const pendingSaleIds = new Set(readAppsScriptOutbox()
      .filter((job) => job.action === "record_sale")
      .map((job) => String(job.payload?.invoice?.id || job.payload?.invoice?.sessionId || ""))
      .filter(Boolean));
    const pending = localIncomeRecords(filters)
      .filter((record) => pendingSaleIds.has(String(record.saleId || "")) && !remoteKeys.has(record.saleId));
    const pendingTotals = incomeTotalsFromRecords(pending);
    const totals = { ...(remote.totals || {}) };
    Object.keys(pendingTotals).forEach((key) => { totals[key] = Number(totals[key] || 0) + (key === "averageTicket" ? 0 : Number(pendingTotals[key] || 0)); });
    totals.averageTicket = totals.sales ? totals.income / totals.sales : 0;
    return {
      ...remote,
      filters,
      totals,
      records: [...pending, ...(remote.records || [])].sort((left, right) => String(right.date).localeCompare(String(left.date))),
      totalRecords: Number(remote.totalRecords || 0) + pending.length,
      pendingCount: pending.length,
      localOnly: false
    };
  };

  const setIncomeReportStatus = (message, tone = "ready", iconName = "badge-check") => {
    const target = $("#incomeReportStatus");
    if (!target) return;
    target.className = `income-report-status is-${tone}`;
    target.innerHTML = `${icon(iconName, 15)} ${escapeHTML(message)}`;
    refreshIcons();
  };

  const renderAdminAi = () => {
    const chat = $("#adminAiChat");
    const suggestions = $("#adminAiSuggestions");
    if (!chat || !suggestions) return;
    const renderSignature = JSON.stringify(state.adminAiMessages);
    if (renderSignature === state.adminAiRenderSignature) return;
    state.adminAiRenderSignature = renderSignature;
    suggestions.innerHTML = ["¿Cuanto se vendio hoy?", "¿Que producto se vendio mas?", "¿Quien realizo las ventas?", "¿Que productos tienen stock bajo?"]
      .map((question) => `<button class="chip" type="button" data-admin-ai-question="${escapeHTML(question)}">${escapeHTML(question)}</button>`).join("");
    const messages = state.adminAiMessages.length ? state.adminAiMessages : [{ role: "bot", text: "Puedo cruzar el informe de ingresos, el inventario y los movimientos visibles. Preguntame por productos, cantidades, responsables, ventas o existencias." }];
    chat.innerHTML = messages.map((message) => `<div class="admin-ai-message ${message.role}">${message.role === "bot" ? icon("sparkles", 17) : ""}<p>${escapeHTML(message.text)}</p></div>`).join("");
    chat.scrollTop = chat.scrollHeight;
    refreshIcons();
  };

  const askAdminAi = async (question) => {
    const clean = String(question || "").trim();
    if (!clean) return;
    state.adminAiMessages.push({ role: "user", text: clean });
    renderAdminAi();
    if (!state.incomeReport) await loadIncomeReport();
    const normalized = normalizeText(clean);
    const mentionsEntries = includesAny(normalized, [
      "ingreso al inventario", "se ingreso", "ingresaron", "entrada", "entraron",
      "agrego al inventario", "sumo unidades", "movimiento"
    ]);
    if (mentionsEntries) await loadInventoryMovements();
    const records = state.incomeReport?.records || localIncomeRecords(incomeFiltersFromForm());
    const product = state.items
      .filter((item) => normalized.includes(normalizeText(item.name)))
      .sort((left, right) => String(right.name).length - String(left.name).length)[0] || null;
    const mentionsInventory = includesAny(normalized, ["inventario", "existencia", "stock", "queda", "quedan"]);
    let answer = "No encontre una coincidencia exacta. Prueba incluyendo el nombre del producto y palabras como vendio, ingreso, responsable, utilidad o stock.";
    if (mentionsInventory && product) {
      const inventory = inventoryFor(product);
      answer = `${product.name} tiene ${inventory.stock.toLocaleString("es-CO", { maximumFractionDigits: 2 })} ${inventory.unit}${inventory.stock === 1 ? "" : "s"}. Su minimo es ${inventory.minStock} y su valor estimado a costo es ${money(inventory.stock * inventory.costPrice)}.`;
    } else if (mentionsInventory) {
      const low = state.items.filter((item) => inventoryStatus(item) !== "ok");
      answer = low.length ? `Hay ${low.length} productos por revisar: ${low.slice(0, 8).map((item) => `${item.name} (${inventoryFor(item).stock})`).join(", ")}.` : "No hay productos agotados ni por debajo del stock minimo.";
    } else if (mentionsEntries) {
      const matching = state.inventoryMovements.filter((movement) => (!product || movement.productId === product.id) && Number(movement.delta || 0) > 0);
      const units = matching.reduce((sum, movement) => sum + Number(movement.delta || 0), 0);
      answer = `${product ? product.name : "El inventario"} registra ${units.toLocaleString("es-CO", { maximumFractionDigits: 2 })} unidades de entrada en ${matching.length} movimiento${matching.length === 1 ? "" : "s"}.`;
    } else if (includesAny(normalized, ["quien", "responsable", "vendio"]) && product) {
      const sellers = new Map();
      records.forEach((record) => {
        const quantity = (record.items || []).filter((item) => normalizeText(item.name).includes(normalizeText(product.name))).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        if (quantity) sellers.set(record.waiter || "Sin asignar", Number(sellers.get(record.waiter || "Sin asignar") || 0) + quantity);
      });
      answer = sellers.size ? `${product.name} fue vendido por ${Array.from(sellers).map(([name, quantity]) => `${name}: ${quantity} unidad${quantity === 1 ? "" : "es"}`).join("; ")}.` : `No encontre ventas de ${product.name} en el rango seleccionado.`;
    } else if (product && includesAny(normalized, ["vendio", "vendieron", "unidades", "cuanto"])) {
      const lines = records.flatMap((record) => (record.items || []).filter((item) => normalizeText(item.name).includes(normalizeText(product.name))));
      const quantity = lines.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const total = lines.reduce((sum, item) => sum + Number(item.total || 0), 0);
      answer = `En el rango actual se vendieron ${quantity.toLocaleString("es-CO", { maximumFractionDigits: 2 })} unidades de ${product.name}, por ${money(total)}.`;
    } else if (includesAny(normalized, ["producto", "mas vendido", "vendio mas"])) {
      const totals = new Map();
      records.flatMap((record) => record.items || []).forEach((item) => totals.set(item.name, Number(totals.get(item.name) || 0) + Number(item.quantity || 0)));
      const top = Array.from(totals).sort((a, b) => b[1] - a[1])[0];
      answer = top ? `El producto mas vendido en el rango actual es ${top[0]}, con ${top[1].toLocaleString("es-CO", { maximumFractionDigits: 2 })} unidades.` : "No hay productos vendidos en el rango seleccionado.";
    } else if (includesAny(normalized, ["utilidad", "ganancia"])) {
      answer = `La ganancia aproximada del periodo es ${money(state.incomeReport?.totals?.profit || 0)}, sobre ventas de ${money(state.incomeReport?.totals?.income || 0)}.`;
    } else if (includesAny(normalized, ["quien", "responsable", "vendedor", "mesero"])) {
      const sellers = new Map();
      records.forEach((record) => sellers.set(record.waiter || "Sin asignar", Number(sellers.get(record.waiter || "Sin asignar") || 0) + Number(record.total || 0)));
      answer = sellers.size ? Array.from(sellers).sort((a, b) => b[1] - a[1]).map(([name, total]) => `${name}: ${money(total)}`).join("; ") : "No hay ventas con responsable en el rango seleccionado.";
    } else if (includesAny(normalized, ["venta", "vendio", "ingreso", "facturo", "cuanto"])) {
      const totals = state.incomeReport?.totals || {};
      answer = `En el periodo seleccionado se registraron ${Number(totals.sales || 0)} ventas por ${money(totals.income || 0)}. El promedio por venta fue ${money(totals.averageTicket || 0)}.`;
    }
    state.adminAiMessages.push({ role: "bot", text: answer });
    state.adminAiMessages = state.adminAiMessages.slice(-30);
    renderAdminAi();
  };

  const formatIncomeDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "Sin fecha");
    return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };

  const renderIncomeReport = ({ appendFrom = 0 } = {}) => {
    const kpis = $("#incomeKpis");
    const payments = $("#incomePaymentBreakdown");
    const recordsTarget = $("#incomeRecords");
    const summaryTarget = $("#incomeFilterSummary");
    if (!kpis || !payments || !recordsTarget) return;
    const report = state.incomeReport;
    if (!report) {
      const more = $("#loadMoreIncome");
      if (more) more.hidden = true;
      kpis.innerHTML = Array.from({ length: 3 }, () => '<article class="income-kpi is-loading"><span></span><strong></strong><small></small></article>').join("");
      payments.innerHTML = "";
      if (summaryTarget) summaryTarget.innerHTML = "";
      recordsTarget.innerHTML = emptyState("Preparando contabilidad", "Estamos consultando las ventas cerradas.", "loader-circle");
      setIncomeReportStatus("Consultando ingresos", "loading", "loader-circle");
      return;
    }
    const totals = report.totals || {};
    const margin = Number(totals.income || 0) > 0 ? Number(totals.profit || 0) / Number(totals.income) * 100 : 0;
    const infoButton = (label, explanation) => `<button class="income-kpi-info" type="button" aria-label="Qué significa ${escapeHTML(label)}" data-tooltip="${escapeHTML(explanation)}">${icon("info", 15)}</button>`;
    kpis.innerHTML = state.incomeLoading
      ? Array.from({ length: 3 }, () => '<article class="income-kpi is-loading"><span></span><strong></strong><small></small></article>').join("")
      : `
        <article class="income-kpi is-primary">${infoButton("Dinero vendido", "Todo el dinero cobrado en las ventas de este periodo.")}<span>${icon("circle-dollar-sign", 19)} Dinero vendido</span><strong>${money(totals.income)}</strong><small>Total vendido en el periodo seleccionado</small></article>
        <article class="income-kpi is-profit">${infoButton("Ganancia aproximada", "Lo que queda al restar del dinero vendido el costo de los productos.")}<span>${icon("trending-up", 19)} Ganancia aproximada</span><strong>${money(totals.profit)}</strong><small>${margin.toLocaleString("es-CO", { maximumFractionDigits: 1 })}% del dinero vendido</small></article>
        <article class="income-kpi">${infoButton("Costo de los productos", "Lo que el negocio pagó por los productos que ya vendió.")}<span>${icon("package-search", 19)} Costo de los productos</span><strong>${money(totals.cost)}</strong><small>Valor de compra de lo que se vendió</small></article>`;
    payments.innerHTML = [
      ["cash", "banknote", "Efectivo"],
      ["transfer", "landmark", "Transferencia"],
      ["breb", "scan-line", "Bre-B"]
    ].map(([key, iconName, label]) => `<article><span>${icon(iconName, 18)} ${label}</span><strong>${money(totals[key])}</strong><small><b>${Number(totals.income || 0) ? (Number(totals[key] || 0) / Number(totals.income) * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 }) : "0"}% del total</b></small></article>`).join("");
    const filters = report.filters || incomeFiltersFromForm();
    if (summaryTarget) {
      const methodText = filters.paymentMethod === "all" ? "todos los medios" : incomePaymentLabel(filters.paymentMethod);
      summaryTarget.innerHTML = `${icon("calendar-range", 15)} <strong>${escapeHTML(filters.dateFrom)}</strong> a <strong>${escapeHTML(filters.dateTo)}</strong> · ${escapeHTML(methodText)}${filters.query ? ` · Búsqueda: “${escapeHTML(filters.query)}”` : ""}`;
    }
    const recordRows = report.records?.length
      ? report.records.slice(appendFrom).map((record) => {
          const paymentBadges = (record.payments || []).map((payment) => `<span>${escapeHTML(incomePaymentLabel(payment.method))} <strong>${money(payment.amount)}</strong></span>`).join("");
          const itemRows = (record.items || []).map((item) => `<li><span>${Number(item.quantity || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 })} × ${escapeHTML(item.name)}</span><strong>${money(item.total)}</strong></li>`).join("");
          return `<article class="income-record">
            <div class="income-record-main">
              <div class="income-record-invoice"><span>${escapeHTML(record.invoice || "Factura")}</span><small>${escapeHTML(formatIncomeDate(record.date))}</small><div class="income-record-actions"><button class="icon-btn" type="button" data-edit-income="${escapeHTML(record.saleId)}" aria-label="Editar venta">${icon("pencil", 15)}</button><button class="icon-btn danger" type="button" data-delete-income="${escapeHTML(record.saleId)}" aria-label="Eliminar venta completa">${icon("trash-2", 15)}</button></div></div>
              <div><small>Mesa / responsable</small><strong>${escapeHTML(record.table || "Mesa")}</strong><span>${escapeHTML(record.payer || "Sin responsable")}</span></div>
              <div><small>Atendido por</small><strong>${escapeHTML(record.waiter || "Sin asignar")}</strong><span>${escapeHTML(record.reference || "Sin referencia")}</span></div>
              <div class="income-record-total"><small>Total</small><strong>${money(record.total)}</strong><span class="income-record-profit">Ganancia ${money(record.profit)}</span></div>
            </div>
            <div class="income-payment-badges">${paymentBadges || "<span>Medio no registrado</span>"}</div>
            <details>
              <summary>${icon("list-collapse", 15)} Ver productos y desglose</summary>
              <div class="income-record-detail">
                <ul>${itemRows || "<li><span>Sin detalle de productos</span></li>"}</ul>
                <dl class="income-total-only"><div><dt>Total pagado</dt><dd>${money(record.total)}</dd></div></dl>
              </div>
            </details>
          </article>`;
        }).join("")
      : emptyState("Sin ingresos en este rango", "Prueba otro periodo, medio de pago o término de búsqueda.", "receipt-text");
    if (appendFrom && report.records?.length) recordsTarget.insertAdjacentHTML("beforeend", recordRows);
    else recordsTarget.innerHTML = recordRows;
    const more = $("#loadMoreIncome");
    if (more) more.hidden = !report.hasMore || !report.nextCursor;
    const pendingText = report.pendingCount ? ` · ${report.pendingCount} pendiente${report.pendingCount === 1 ? "" : "s"} de respaldo` : "";
    const limitedText = report.hasMore ? ` · mostrando ${Number(report.records?.length || 0).toLocaleString("es-CO")} de ${Number(report.totalRecords || 0).toLocaleString("es-CO")}` : "";
    setIncomeReportStatus(`${Number(report.totalRecords || 0).toLocaleString("es-CO")} factura${Number(report.totalRecords || 0) === 1 ? "" : "s"}${pendingText}${limitedText}`, report.localOnly ? "warning" : "ready", report.localOnly ? "hard-drive" : "badge-check");
    refreshIcons();
  };

  const scheduleIncomeRecovery = (remoteReport) => {
    if (state.activeAdminSection !== "income" || remoteReport.filters?.query || remoteReport.filters?.paymentMethod !== "all") return;
    state.incomeRecoveryReport = remoteReport;
    const recoveryKey = (report) => `${report.filters.dateFrom}:${report.filters.dateTo}`;
    if (state.incomeRecoveryPromise || state.incomeRecoveredRanges.has(recoveryKey(remoteReport))) return;
    const waitForIncomeIdle = () => new Promise((resolve) => {
      const check = () => {
        if (state.activeAdminSection !== "income") return resolve(false);
        const currentFilters = incomeFiltersFromForm();
        if (currentFilters.query || currentFilters.paymentMethod !== "all") return resolve(false);
        if (currentFilters.dateFrom !== state.incomeRecoveryReport.filters.dateFrom || currentFilters.dateTo !== state.incomeRecoveryReport.filters.dateTo) return resolve(false);
        if (state.incomeLoading || Date.now() - state.incomeLastRequestAt < 600) {
          window.setTimeout(check, 300);
          return;
        }
        resolve(true);
      };
      window.setTimeout(check, 600);
    });
    state.incomeRecoveryPromise = waitForIncomeIdle()
      .then(async (ready) => {
        if (!ready) return;
        const report = state.incomeRecoveryReport;
        const key = recoveryKey(report);
        if (state.incomeRecoveredRanges.has(key)) return;
        state.incomeRecoveredRanges.add(key);
        const recovered = await queueIncomeRecoveryFromMovements(report);
        if (!recovered) return;
        const synced = await flushAppsScriptOutbox();
        if (synced && !readAppsScriptOutbox().length && state.activeAdminSection === "income") {
          await loadIncomeReport();
        }
      })
      .catch((error) => console.warn("No se pudo conciliar ingresos cerrados desde movimientos.", error))
      .finally(() => {
        state.incomeRecoveryPromise = null;
        const report = state.incomeRecoveryReport;
        if (!report || state.incomeRecoveredRanges.has(recoveryKey(report)) || state.activeAdminSection !== "income") return;
        const filters = incomeFiltersFromForm();
        if (!filters.query && filters.paymentMethod === "all" && filters.dateFrom === report.filters.dateFrom && filters.dateTo === report.filters.dateTo) scheduleIncomeRecovery(report);
      });
  };

  const loadIncomeReport = async () => {
    if (!$("#income") || state.currentUser?.role !== "admin") return false;
    const filters = incomeFiltersFromForm();
    if (filters.dateFrom > filters.dateTo) {
      toast("La fecha inicial no puede ser posterior a la fecha final.", "error", "invalid-income-range");
      return false;
    }
    const requestId = ++state.incomeRequestId;
    state.incomeRequestKey = JSON.stringify(filters);
    state.incomeLastRequestAt = Date.now();
    state.incomeLoading = true;
    state.incomeReport = null;
    renderIncomeReport();
    if (!navigator.onLine || !isAppsScriptConfigured()) {
      state.incomeReport = localIncomeReport(filters);
      renderIncomeReport();
    }
    setIncomeReportStatus("Actualizando informe", "loading", "loader-circle");
    try {
      if (!isAppsScriptConfigured()) throw new Error("El historial remoto no está configurado.");
      const result = await appsScriptRequest("get_income_report", { filters }, APPS_SCRIPT_TIMEOUT_MS);
      if (!result?.ok) throw new Error(result?.error || "No se pudo consultar el historial.");
      if (requestId !== state.incomeRequestId) return false;
      state.incomeLoading = false;
      state.incomeReport = mergeIncomeReport(result, filters);
      renderIncomeReport();
      scheduleIncomeRecovery(result);
      return true;
    } catch (error) {
      if (requestId !== state.incomeRequestId) return false;
      state.incomeLoading = false;
      state.incomeReport = localIncomeReport(filters, String(error?.message || error));
      renderIncomeReport();
      setIncomeReportStatus("Mostrando ventas disponibles en esta caja", "warning", "hard-drive");
      return false;
    } finally {
      if (requestId === state.incomeRequestId) state.incomeLoading = false;
    }
  };

  const loadMoreIncomeReport = async () => {
    const report = state.incomeReport;
    if (state.incomeLoading || state.incomeLoadingMore || !report?.hasMore || !report.nextCursor) return false;
    const button = $("#loadMoreIncome");
    const requestId = state.incomeRequestId;
    state.incomeLoadingMore = true;
    if (button) {
      button.disabled = true;
      button.textContent = "Cargando ventas...";
    }
    try {
      const result = await appsScriptRequest("get_income_report", {
        filters: { ...report.filters, limit: 300, cursor: report.nextCursor }
      }, APPS_SCRIPT_TIMEOUT_MS);
      if (!result?.ok || !Array.isArray(result.records) || (result.hasMore && !result.nextCursor)) {
        throw new Error(result?.error || "No se pudieron cargar más ventas.");
      }
      if (requestId !== state.incomeRequestId || state.incomeReport !== report) return false;
      const knownIds = new Set(report.records.map((record) => String(record.saleId)));
      const additions = result.records.filter((record) => !knownIds.has(String(record.saleId)));
      const appendFrom = report.records.length;
      state.incomeReport = {
        ...report,
        records: [...report.records, ...additions],
        hasMore: result.hasMore === true,
        nextCursor: result.nextCursor || null,
        truncated: result.hasMore === true
      };
      renderIncomeReport({ appendFrom });
      return true;
    } catch (error) {
      if (requestId === state.incomeRequestId) toast(String(error?.message || error), "error", "more-income-failed");
      return false;
    } finally {
      state.incomeLoadingMore = false;
      if (button) {
        button.disabled = false;
        button.textContent = "Ver más ventas";
      }
    }
  };

  const waitForRemoteQueue = async () => {
    const deadline = Date.now() + 30000;
    while (state.appsScriptOutboxBusy && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (state.appsScriptOutboxBusy) throw new Error("Hay cambios anteriores que todavía se están guardando. Intenta nuevamente en unos segundos.");
    if (!readAppsScriptOutbox().length) return;
    const synced = await flushAppsScriptOutbox();
    if (!synced || readAppsScriptOutbox().length) throw new Error("No fue posible terminar de guardar los cambios anteriores.");
  };

  const requireCurrentAppsScriptVersion = async () => {
    if (!isAppsScriptConfigured()) throw new Error("El respaldo remoto no está configurado.");
    const status = await appsScriptRequest("status", {}, 12000);
    if (!status?.ok || !isAppsScriptVersionCompatible(status.version)) {
      throw new Error(`Publica Code.gs ${APPS_SCRIPT_REQUIRED_VERSION} antes de modificar el historial de movimientos.`);
    }
    return true;
  };

  const resetSectionData = async (section) => {
    if (state.currentUser?.role !== "admin") return;
    const settings = {
      inventory: {
        eyebrow: "Reiniciar inventario",
        title: "¿Eliminar todo el inventario?",
        message: "Se eliminarán todos los productos y sus existencias. Ingresos y movimientos conservarán su información.",
        action: "clear_inventory",
        success: "Inventario eliminado. Ya puedes empezar desde cero."
      },
      movements: {
        eyebrow: "Reiniciar movimientos",
        title: "¿Eliminar todos los movimientos?",
        message: "Se borrará todo el historial de entradas y salidas y cada cambio se revertirá en las existencias.",
        action: "clear_inventory_movements",
        success: "Movimientos eliminados y existencias restauradas."
      },
      income: {
        eyebrow: "Reiniciar ingresos",
        title: "¿Eliminar todos los ingresos?",
        message: "Se borrarán todas las ventas, pagos y totales históricos. El inventario actual no cambiará.",
        action: "clear_income",
        success: "Ingresos eliminados. Todos los valores quedaron en cero."
      }
    }[section];
    if (!settings) return;

    if (section === "inventory") {
      const hasOpenProductAccounts = state.sessions.some((session) => session.status === "open" && (session.session_items || []).some((item) => item.status !== "cancelled" && item.menu_item_id));
      if (hasOpenProductAccounts) {
        toast("Cobra o elimina los productos de las cuentas abiertas antes de reiniciar el inventario.", "error", "inventory-reset-open-accounts");
        return;
      }
    }

    const confirmed = await askForConfirmation({
      eyebrow: settings.eyebrow,
      title: settings.title,
      message: settings.message,
      accept: "Sí, eliminar todo",
      cancel: "Conservar información"
    });
    if (!confirmed) return;

    if (section === "movements") {
      try {
        await requireCurrentAppsScriptVersion();
      } catch (error) {
        toast(String(error?.message || error), "error", "movement-version-required");
        return;
      }
    }

    const button = $(`[data-reset-section="${section}"]`);
    const buttonMarkup = button?.innerHTML || "";
    if (button) {
      button.disabled = true;
      button.classList.add("is-resetting");
      button.innerHTML = `${icon("loader-circle", 17)} Eliminando...`;
    }

    const snapshot = {
      items: state.items.map((item) => ({ ...item })),
      inventoryMeta: JSON.parse(JSON.stringify(state.inventoryMeta)),
      inventoryMovements: state.inventoryMovements.map((movement) => ({ ...movement })),
      movementNextBeforeRow: state.movementNextBeforeRow,
      invoiceHistory: state.invoiceHistory.map((invoice) => ({ ...invoice })),
      incomeReport: state.incomeReport,
      lastPaidReceipt: state.lastPaidReceipt
    };

    try {
      if (section === "inventory") {
        state.items = [];
        state.inventoryMeta = {};
        state.inventorySearch = "";
        state.inventoryStatusFilter = "all";
        state.productPickerMatches = [];
        if ($("#inventorySearch")) $("#inventorySearch").value = "";
        if ($("#inventoryStatusFilter")) $("#inventoryStatusFilter").value = "all";
        persistInventoryStore();
        persistBootstrapCache();
        resetInventoryForm();
        $("#inventoryDialog")?.close();
        renderInventory();
        renderMenuManager();
      }
      if (section === "movements") {
        state.movementRequestId += 1;
        state.inventoryMovements = [];
        state.movementNextBeforeRow = null;
        state.movementSearch = "";
        state.movementTypeFilter = "all";
        if ($("#movementSearch")) $("#movementSearch").value = "";
        if ($("#movementTypeFilter")) $("#movementTypeFilter").value = "all";
        persistInventoryMovements();
        renderInventoryMovements();
      }
      if (section === "income") {
        state.incomeRequestId += 1;
        state.incomeLoading = false;
        state.invoiceHistory = [];
        state.lastPaidReceipt = null;
        persistInvoiceHistory();
        state.incomeReport = localIncomeReport(incomeFiltersFromForm());
        $("#incomeEditDialog")?.close();
        $("#deleteIncomeDialog")?.close();
        $("#receiptResultDialog")?.close();
        renderIncomeReport();
      }

      await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!isAppsScriptConfigured()) throw new Error("El respaldo remoto no está configurado.");
      await waitForRemoteQueue();
      const result = await appsScriptRequest(settings.action, {}, 40000);
      if (!result?.ok || result.cleared !== true) throw new Error(result?.error || "No fue posible completar el reinicio.");
      if (section === "movements" && !Array.isArray(result.items)) {
        throw new Error(`Publica Code.gs ${APPS_SCRIPT_REQUIRED_VERSION} para eliminar movimientos restaurando el inventario.`);
      }
      if (section === "inventory") {
        state.items = [];
        state.inventoryMeta = {};
        persistInventoryStore();
        persistBootstrapCache();
        renderInventory();
        renderMenuManager();
        setInventorySyncStatus("Inventario vacío y sincronizado", "synced", "cloud-check");
      }
      if (section === "movements") {
        state.inventoryMovements = [];
        persistInventoryMovements();
        applyRemoteInventoryItems(result.items);
        renderInventoryMovements();
      }
      if (section === "income") {
        state.invoiceHistory = [];
        state.lastPaidReceipt = null;
        persistInvoiceHistory();
        state.incomeReport = localIncomeReport(incomeFiltersFromForm());
        renderIncomeReport();
        setIncomeReportStatus("0 facturas", "ready", "badge-check");
      }
      toast(settings.success, "ok", `reset-complete:${section}`);
    } catch (error) {
      if (section === "inventory") {
        state.items = snapshot.items;
        state.inventoryMeta = snapshot.inventoryMeta;
        persistInventoryStore();
        persistBootstrapCache();
        renderInventory();
        renderMenuManager();
      }
      if (section === "movements") {
        state.inventoryMovements = snapshot.inventoryMovements;
        state.movementNextBeforeRow = snapshot.movementNextBeforeRow;
        persistInventoryMovements();
        renderInventoryMovements();
      }
      if (section === "income") {
        state.invoiceHistory = snapshot.invoiceHistory;
        state.incomeReport = snapshot.incomeReport;
        state.lastPaidReceipt = snapshot.lastPaidReceipt;
        persistInvoiceHistory();
        renderIncomeReport();
      }
      toast(String(error?.message || "No fue posible eliminar la información."), "error", `reset-failed:${section}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove("is-resetting");
        button.innerHTML = buttonMarkup;
      }
      refreshIcons();
    }
  };

  const dateTimeLocalValue = (value) => {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  };

  const openIncomeEdit = (saleId) => {
    const record = state.incomeReport?.records?.find((entry) => String(entry.saleId) === String(saleId));
    const form = $("#incomeEditForm");
    if (!record || !form) return;
    form.sale_id.value = record.saleId;
    form.table.value = record.table || "Venta individual";
    form.payer.value = record.payer || "";
    form.waiter.value = record.waiter || state.currentUser?.full_name || "";
    form.date.value = dateTimeLocalValue(record.date);
    form.payment_method.value = record.isMixed ? "mixed" : (record.payments?.[0]?.method || "cash");
    form.reference.value = record.reference || "";
    const lines = $("#incomeEditLines");
    lines.innerHTML = `<div class="income-edit-lines-head"><strong>Productos facturados</strong><small>Edita producto, cantidad o precio, o usa la canasta para retirar un articulo cobrado.</small></div>${(record.items || []).map((item, index) => `<div class="income-edit-line" data-income-line="${index}" data-line-id="${escapeHTML(item.lineId || item.id || "")}" data-menu-item-id="${escapeHTML(item.menuItemId || item.menu_item_id || "")}"><label>Producto<input data-line-field="name" value="${escapeHTML(item.name || "Producto")}" maxlength="100" required></label><label>Cantidad<input data-line-field="quantity" type="number" min="1" step="1" value="${Number(item.quantity || 0)}" required></label><label>Precio<input data-line-field="price" type="text" value="${formattedCurrencyInput(item.unitPrice || item.unit_price || 0)}" inputmode="numeric" data-currency-input required></label><button class="icon-btn danger income-line-delete" type="button" data-remove-income-line aria-label="Eliminar ${escapeHTML(item.name || "producto")}">${icon("trash-2", 17)}</button></div>`).join("")}`;
    bindCurrencyInputs(lines);
    $("#incomeEditDialog")?.showModal();
    refreshIcons();
  };

  const openDeleteIncomeDialog = (saleId) => {
    const record = state.incomeReport?.records?.find((entry) => String(entry.saleId) === String(saleId));
    const form = $("#deleteIncomeForm");
    if (!record || !form) return;
    form.sale_id.value = record.saleId;
    $("#deleteIncomeTitle").textContent = "¿Eliminar esta venta?";
    $("#deleteIncomeMessage").textContent = `Se borrará la venta completa de ${money(record.total)} y las unidades de sus productos volverán al inventario.`;
    $("#deleteIncomeDialog")?.showModal();
    refreshIcons();
  };

  const deleteIncomeSale = async (form) => {
    const saleId = form.sale_id.value;
    const record = state.incomeReport?.records?.find((entry) => String(entry.saleId) === String(saleId));
    if (!record) return;
    const reportBefore = state.incomeReport;
    const invoicesBefore = [...state.invoiceHistory];
    const inventoryBefore = JSON.parse(JSON.stringify(state.inventoryMeta));
    const outboxBefore = readAppsScriptOutbox();
    const remainingRecords = (reportBefore.records || []).filter((entry) => String(entry.saleId) !== String(saleId));
    const updatedTotals = { ...(reportBefore.totals || {}) };
    updatedTotals.income = Math.max(0, Number(updatedTotals.income || 0) - Number(record.total || 0));
    updatedTotals.sales = Math.max(0, Number(updatedTotals.sales || 0) - 1);
    updatedTotals.subtotal = Math.max(0, Number(updatedTotals.subtotal || 0) - Number(record.subtotal || 0));
    updatedTotals.discount = Math.max(0, Number(updatedTotals.discount || 0) - Number(record.discount || 0));
    updatedTotals.tax = Math.max(0, Number(updatedTotals.tax || 0) - Number(record.tax || 0));
    updatedTotals.service = Math.max(0, Number(updatedTotals.service || 0) - Number(record.service || 0));
    updatedTotals.cost = Math.max(0, Number(updatedTotals.cost || 0) - Number(record.cost || 0));
    updatedTotals.profit = Number(updatedTotals.profit || 0) - Number(record.profit || 0);
    (record.payments || []).forEach((payment) => {
      const method = ["cash", "transfer", "breb"].includes(payment.method) ? payment.method : "other";
      updatedTotals[method] = Math.max(0, Number(updatedTotals[method] || 0) - Number(payment.amount || 0));
    });
    updatedTotals.averageTicket = updatedTotals.sales ? updatedTotals.income / updatedTotals.sales : 0;
    state.incomeReport = { ...reportBefore, records: remainingRecords, totals: updatedTotals, totalRecords: Math.max(0, Number(reportBefore.totalRecords || 0) - 1), recordKeys: (reportBefore.recordKeys || []).filter((key) => String(key) !== String(saleId)) };
    state.invoiceHistory = state.invoiceHistory.filter((invoice) => String(invoice.id || invoice.sessionId) !== String(saleId));
    (record.items || []).forEach((line) => {
      const productId = line.menuItemId || line.menu_item_id;
      const item = state.items.find((entry) => String(entry.id) === String(productId));
      if (!item || !Object.prototype.hasOwnProperty.call(state.inventoryMeta, item.id)) return;
      const current = inventoryFor(item);
      state.inventoryMeta[item.id] = { ...current, stock: current.stock + Number(line.quantity || 0), updatedAt: new Date().toISOString() };
    });
    const hadPendingSale = outboxBefore.some((job) => job.action === "record_sale" && String(job.payload?.invoice?.id || job.payload?.invoice?.sessionId) === String(saleId));
    writeAppsScriptOutbox(outboxBefore.filter((job) => !(job.action === "record_sale" && String(job.payload?.invoice?.id || job.payload?.invoice?.sessionId) === String(saleId))));
    persistInvoiceHistory();
    persistInventoryStore();
    $("#deleteIncomeDialog")?.close();
    renderIncomeReport();
    renderInventory();
    try {
      if (!hadPendingSale || isAppsScriptConfigured()) {
        const result = await appsScriptRequest("delete_sale", { saleId }, 40000);
        if (!result?.ok) throw new Error(result?.error || "No se pudo eliminar la venta.");
        if (Array.isArray(result?.items)) applyRemoteInventoryItems(result.items);
      }
      toast("Venta eliminada y existencias restauradas.", "ok", `income-deleted:${saleId}`);
    } catch (error) {
      state.incomeReport = reportBefore;
      state.invoiceHistory = invoicesBefore;
      state.inventoryMeta = inventoryBefore;
      writeAppsScriptOutbox(outboxBefore);
      persistInvoiceHistory();
      persistInventoryStore();
      renderIncomeReport();
      renderInventory();
      toast(String(error?.message || error), "error", `income-delete-failed:${saleId}`);
    }
  };

  const saveIncomeEdit = async (form) => {
    const record = state.incomeReport?.records?.find((entry) => String(entry.saleId) === String(form.sale_id.value));
    if (!record) return;
    const items = $$('[data-income-line]', form).map((row) => ({
      id: row.dataset.lineId || uid(),
      menu_item_id: row.dataset.menuItemId || null,
      item_name: row.querySelector('[data-line-field="name"]')?.value.trim() || "",
      quantity: Number(row.querySelector('[data-line-field="quantity"]')?.value || 0),
      unit_price: currencyInputNumber(row.querySelector('[data-line-field="price"]')),
      unit_cost: Number(record.items?.[Number(row.dataset.incomeLine)]?.cost || 0) / Math.max(1, Number(record.items?.[Number(row.dataset.incomeLine)]?.quantity || 1))
    })).filter((item) => item.item_name && item.quantity > 0);
    if (!items.length || items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.unit_price < 0)) {
      toast("La venta debe conservar al menos un producto con cantidad y precio validos.", "error", "invalid-income-edit");
      return;
    }
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const total = subtotal;
    const selectedPaymentMethod = form.payment_method.value;
    const existingPaymentTotal = (record.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const correctedPayments = selectedPaymentMethod === "mixed" && record.payments?.length > 1
      ? record.payments.map((payment, index, payments) => ({
          method: payment.method,
          amount: index === payments.length - 1
            ? total - payments.slice(0, -1).reduce((sum, entry) => sum + Math.round(total * Number(entry.amount || 0) / Math.max(1, existingPaymentTotal)), 0)
            : Math.round(total * Number(payment.amount || 0) / Math.max(1, existingPaymentTotal))
        }))
      : [{ method: selectedPaymentMethod === "mixed" ? "cash" : selectedPaymentMethod, amount: total }];
    const correctedDate = new Date(form.date.value);
    if (Number.isNaN(correctedDate.getTime())) {
      toast("Selecciona una fecha y hora validas para la venta.", "error", "invalid-income-date");
      return;
    }
    const corrected = {
      id: record.saleId,
      number: record.invoice,
      sessionId: record.sessionId,
      table: form.table.value.trim(),
      createdAt: correctedDate.toISOString(),
      payerName: form.payer.value.trim(),
      waiterName: form.waiter.value.trim(),
      paymentMethod: selectedPaymentMethod,
      payments: correctedPayments,
      reference: form.reference.value.trim(),
      totals: { subtotal, discount: 0, tax: 0, serviceFee: 0, total },
      items
    };
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const result = await appsScriptRequest("edit_sale", { invoice: corrected }, 40000);
      if (!result?.ok) throw new Error(result?.error || "No se pudo corregir la venta.");
      const localIndex = state.invoiceHistory.findIndex((invoice) => String(invoice.id || invoice.sessionId) === String(record.saleId));
      if (localIndex >= 0) {
        state.invoiceHistory[localIndex] = { ...state.invoiceHistory[localIndex], ...corrected };
        persistInvoiceHistory();
      }
      $("#incomeEditDialog")?.close();
      state.incomeReport = null;
      await loadIncomeReport();
      toast("Venta corregida. El cambio quedo registrado en auditoria.", "ok", `income-edited:${record.saleId}`);
    } catch (error) {
      toast(String(error?.message || error), "error", `income-edit-failed:${record.saleId}`);
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  const exportIncomeCsv = () => {
    const records = state.incomeReport?.records || [];
    if (!records.length) {
      toast("No hay ingresos para exportar con estos filtros.", "error", "empty-income-export");
      return;
    }
    const safeCsv = (value) => {
      let text = String(value ?? "");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [["Factura", "Fecha", "Mesa", "Responsable", "Mesero", "Medios de pago", "Subtotal", "Descuento", "Impuestos", "Servicio", "Costo", "Ganancia", "Total", "Referencia"]];
    records.forEach((record) => rows.push([
      record.invoice, record.date, record.table, record.payer, record.waiter,
      (record.payments || []).map((payment) => `${incomePaymentLabel(payment.method)}: ${payment.amount}`).join(" + "),
      record.subtotal, record.discount, record.tax, record.service, record.cost, record.profit, record.total, record.reference
    ]));
    const blob = new Blob(["\ufeff", rows.map((row) => row.map(safeCsv).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ingresos-${state.incomeReport.filters?.dateFrom || "inicio"}-${state.incomeReport.filters?.dateTo || "hoy"}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const renderGeneratedTableQrs = () => {
    $$("[data-table-qr]").forEach((target) => {
      const table = state.tables.find((entry) => entry.id === target.dataset.tableQr);
      if (!table) return;
      renderQrImage(target, qrTextForTable(table), `QR ${tableLabel(table)}`);
    });
  };

  const renderTableFormQr = () => {
    const form = $("#tableForm");
    const preview = $("#qrPreview");
    const link = $("#qrPreviewLink");
    if (!form || !preview || !link) return;
    const number = Number(form.table_number.value);
    const current = state.tables.find((table) => table.id === form.table_id.value);
    const table = current || (number ? { table_number: number, qr_code: `mesa-${number}` } : null);
    if (!table) {
      preview.innerHTML = `${icon("qr-code", 28)}`;
      link.textContent = "Define el numero de mesa para generar el enlace exacto.";
      refreshIcons();
      return;
    }
    const url = qrTextForTable(table);
    link.textContent = url;
    renderQrImage(preview, url, `QR ${tableLabel(table)}`);
  };

  const accountDateParts = (session) => {
    const opened = new Date(session.opened_at || session.created_at);
    return {
      date: opened.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }),
      time: opened.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    };
  };

  const renderAccountDetail = () => {
    const dialog = $("#accountDetailDialog");
    const target = $("#accountDetailContent");
    if (!dialog || !target || !state.activeAccountDetailId) return;
    const session = state.sessions.find((entry) => entry.id === state.activeAccountDetailId);
    if (!session) {
      if (dialog.open) dialog.close();
      state.activeAccountDetailId = "";
      return;
    }
    const items = newestSessionItems(session);
    const total = sessionTotal(session);
    const suggestedTip = tipsEnabled() && items.length ? tipAmountFor(total) : 0;
    const suggestedTotal = total + suggestedTip;
    const opened = accountDateParts(session);
    const billRequest = state.requests.find((request) => request.session_id === session.id && request.request_type === "bill");
    target.innerHTML = `
      <div class="section-head account-detail-head">
        <div><span class="eyebrow">Cuenta abierta</span><h2>Desglose de ${escapeHTML(sessionLabel(session))}</h2><p>#${sessionReference(session)} · ${opened.date}, ${opened.time}</p></div>
        <button class="icon-btn" type="button" data-close-dialog aria-label="Cerrar desglose">${icon("x", 18)}</button>
      </div>
      <div class="account-detail-overview">
        <div><small>Total actual</small><strong>${money(total)}</strong></div>
        <div><small>Consumos</small><strong>${items.length}</strong></div>
        <div><small>Negocio</small><strong>${escapeHTML(state.business?.business_name || "Restaurante")}</strong></div>
        <div><small>Responsable</small><strong>${escapeHTML(session.payer_name || "Por definir")}</strong></div>
        <div><small>Mesero</small><strong>${escapeHTML(session.assigned_waiter?.full_name || "Sin asignar")}</strong></div>
      </div>
      <div class="account-detail-breakdown">
        <div class="account-detail-breakdown-head"><strong>Productos y desglose</strong><span>${items.length} ${items.length === 1 ? "consumo" : "consumos"}</span></div>
        <div class="account-detail-lines">
          ${items.map((item) => `
            <div class="account-detail-line">
              <div><strong>${escapeHTML(item.item_name)}</strong><span>${Number(item.quantity || 0)} × ${money(item.unit_price)}</span><small>${escapeHTML(item.created_by_user?.full_name || "Cliente")}${item.created_at ? ` · ${new Date(item.created_at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}${item.notes ? ` · ${escapeHTML(item.notes)}` : ""}</small></div>
              <strong>${money(Number(item.unit_price) * Number(item.quantity))}</strong>
              <button class="icon-btn" type="button" data-edit-consumption="${item.id}" data-session-id="${session.id}" aria-label="Editar consumo">${icon("pencil", 15)}</button>
              <button class="icon-btn danger" type="button" data-delete-consumption="${item.id}" data-session-id="${session.id}" aria-label="Eliminar consumo">${icon("trash-2", 15)}</button>
            </div>`).join("") || `<div class="invoice-empty">${icon("clipboard-list", 18)} Sin consumos registrados</div>`}
        </div>
        ${suggestedTip ? `<div class="account-detail-tip"><span><small>Propina voluntaria (${state.tipSettings.percentage}%)</small><strong>${money(suggestedTip)}</strong></span><span><small>Total sugerido con propina</small><strong>${money(suggestedTotal)}</strong></span></div>` : ""}
        <div class="account-detail-total"><span>Total del consumo</span><strong>${money(total)}</strong></div>
      </div>
      <div class="invoice-actions account-detail-actions">
        ${items.length ? `<button class="ghost small" type="button" data-add-manual="${session.id}">${icon("plus", 15)} Consumo</button>` : `<button class="ghost small danger-text" type="button" data-close-session="${session.id}">${icon("door-open", 15)} Liberar mesa</button>`}
        ${session.sale_channel === "walk_in" || !session.table_id ? "" : `<button class="ghost small" type="button" data-move-session="${session.id}">${icon("replace", 15)} Cambiar mesa</button>`}
        ${items.length ? `<button class="ghost small" type="button" data-print-session="${session.id}">${icon("printer", 15)} Imprimir pre-cuenta</button>` : ""}
        ${billRequest ? `<button class="ghost small" type="button" data-send-bill="${billRequest.id}">${icon("send", 15)} ${billRequest.status === "acknowledged" ? "Reenviar" : "Enviar cuenta"}</button>` : ""}
        ${items.length ? `<button class="primary small invoice-close" type="button" data-charge-session="${session.id}">${icon("badge-dollar-sign", 18)} Cobrar y facturar</button>` : ""}
      </div>`;
    refreshIcons();
  };

  const openAccountDetailDialog = (sessionId) => {
    const dialog = $("#accountDetailDialog");
    if (!dialog) return;
    state.activeAccountDetailId = String(sessionId || "");
    renderAccountDetail();
    if (!dialog.open) dialog.showModal();
  };

  const renderAccounts = () => {
    const box = $("#accountsPanel");
    if (!box) return;
    const accountSessions = state.sessions.filter((session) => !isLocalWalkInSession(session));
    const renderSignature = JSON.stringify([
      state.business?.tax_rate,
      state.business?.service_fee,
      state.tipSettings?.enabled,
      state.tipSettings?.percentage,
      accountSessions.map((session) => [
        session.id,
        session.status,
        session.payer_name,
        session.assigned_waiter_id,
        session.assigned_waiter?.full_name,
        (session.session_items || []).map((item) => [
          item.id, item.item_name, item.quantity, item.unit_price, item.notes, item.status, item.updated_at
        ])
      ])
    ]);
    if (renderSignature === state.accountsRenderSignature) return;
    state.accountsRenderSignature = renderSignature;
    box.innerHTML = accountSessions.length
      ? accountSessions
          .map((session) => {
            const items = newestSessionItems(session);
            const total = sessionTotal(session);
            const suggestedTip = tipsEnabled() && items.length ? tipAmountFor(total) : 0;
            const opened = accountDateParts(session);
            return `
              <article class="account-summary-card ${items.length ? "" : "is-empty"}" data-account-session="${session.id}">
                <div class="account-summary-head"><div><span>${escapeHTML(sessionLabel(session))}</span><small>#${sessionReference(session)}</small></div><span class="account-summary-status">${items.length ? `${items.length} ${items.length === 1 ? "consumo" : "consumos"}` : "Cuenta en $0"}</span></div>
                <div class="account-summary-total"><small>Total actual</small><strong>${money(total)}</strong></div>
                ${suggestedTip ? `<div class="account-summary-tip"><span>Propina voluntaria (${state.tipSettings.percentage}%)</span><strong>${money(suggestedTip)}</strong><small>Total sugerido: ${money(total + suggestedTip)}</small></div>` : ""}
                <div class="account-summary-meta"><span>${icon("user-round", 15)} ${escapeHTML(session.payer_name || "Por definir")}</span><span>${icon("contact", 15)} ${escapeHTML(session.assigned_waiter?.full_name || "Sin asignar")}</span><span>${icon("clock-3", 15)} ${opened.date} · ${opened.time}</span></div>
                <div class="account-summary-actions">
                  <button class="ghost" type="button" data-view-account="${session.id}">${icon("list-collapse", 16)} Ver desglose</button>
                  ${items.length ? `<button class="primary" type="button" data-charge-session="${session.id}">${icon("badge-dollar-sign", 16)} Cobrar</button>` : `<button class="ghost danger-text" type="button" data-close-session="${session.id}">${icon("door-open", 16)} Liberar mesa</button>`}
                </div>
              </article>
            `;
          })
          .join("")
      : emptyState("No hay cuentas abiertas", "Las mesas con consumos apareceran aqui.", "receipt-text");
    if (state.activeAccountDetailId) renderAccountDetail();
    refreshIcons();
  };

  const renderTips = () => {
    syncTipFeatureVisibility();
    if (!tipsEnabled()) return;
    const kpis = $("#tipsKpis");
    const recordsBox = $("#tipsRecords");
    const peopleInput = $("#tipSplitPeople");
    const splitResult = $("#tipSplitResult");
    const resetButton = $("#resetTips");
    if (!kpis || !recordsBox || !peopleInput || !splitResult) return;
    if (resetButton) resetButton.hidden = state.currentUser?.role !== "admin";
    const tipInvoices = state.invoiceHistory
      .filter((invoice) => Number(invoice.tipAmount ?? invoice.totals?.tip ?? 0) > 0 && !state.clearedTipInvoiceKeys.has(tipInvoiceKey(invoice)))
      .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    const todayKey = localDateKey();
    const todayInvoices = tipInvoices.filter((invoice) => localDateKey(invoice.createdAt) === todayKey);
    const todayTotal = todayInvoices.reduce((sum, invoice) => sum + Number(invoice.tipAmount ?? invoice.totals?.tip ?? 0), 0);
    const people = Math.min(100, Math.max(1, Number(state.tipSplitPeople || 1)));
    state.tipSplitPeople = people;
    peopleInput.value = String(people);
    kpis.innerHTML = `
      <article><span>${icon("hand-coins", 20)} Total de hoy</span><strong>${money(todayTotal)}</strong><small>${todayInvoices.length} ${todayInvoices.length === 1 ? "cuenta con propina" : "cuentas con propina"}</small></article>
      <article><span>${icon("percent", 20)} Porcentaje activo</span><strong>${state.tipSettings.percentage}%</strong><small>Aplicado solo cuando el cliente lo acepta</small></article>
      <article><span>${icon("users-round", 20)} Por persona</span><strong>${money(todayTotal / people)}</strong><small>Dividido entre ${people} ${people === 1 ? "persona" : "personas"}</small></article>`;
    splitResult.innerHTML = `<span>A cada persona le corresponde</span><strong>${money(todayTotal / people)}</strong><small>${money(todayTotal)} ÷ ${people}</small>`;
    recordsBox.innerHTML = tipInvoices.length
      ? tipInvoices.map((invoice) => {
          const date = new Date(invoice.createdAt || Date.now());
          const tip = Number(invoice.tipAmount ?? invoice.totals?.tip ?? 0);
          const chargedTotal = Number(invoice.totals?.total || 0);
          const baseTotal = Number(invoice.baseTotal ?? invoice.totals?.baseTotal ?? chargedTotal - tip);
          return `<article class="tip-record">
            <span class="tip-record-icon">${icon("receipt-text", 18)}</span>
            <div><strong>${escapeHTML(invoice.table || "Venta")}</strong><span>${escapeHTML(invoice.number || "Factura")}</span><small>${date.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}</small><small>${escapeHTML(invoice.waiterName || "Equipo")} · Consumo ${money(baseTotal)} · Cobrado ${money(chargedTotal)}</small></div>
            <strong>+${money(tip)}</strong>
          </article>`;
        }).join("")
      : emptyState("Aún no hay propinas facturadas", "Cuando cobres una cuenta con propina aparecerá aquí con todos sus detalles.", "hand-coins");
    refreshIcons();
  };

  const resetTips = () => {
    if (state.currentUser?.role !== "admin") return;
    state.invoiceHistory
      .filter((invoice) => Number(invoice.tipAmount ?? invoice.totals?.tip ?? 0) > 0)
      .forEach((invoice) => state.clearedTipInvoiceKeys.add(tipInvoiceKey(invoice)));
    persistClearedTipInvoices();
    renderTips();
    toast("La sección de propinas quedó en $0.", "ok", "tips-reset");
  };

  const renderAdmin = () => {
    renderAdminShell();
    renderAlerts();
    renderTables();
    renderBusinessForm();
    renderTableManager();
    renderWaiterTableSelect();
    renderServiceTables();
    renderMenuManager();
    renderInventory();
    renderInventoryMovements();
    renderIncomeReport();
    renderAccounts();
    renderTips();
    renderAdminAi();
  };

  const renderAdminLive = () => {
    renderAdminShell();
    renderAlerts();
    if (state.activeAdminSection === "dashboard" && tablesSignature() !== state.tableRenderSignature) renderTables();
    if (state.activeAdminSection === "service") renderServiceTables();
    if (state.activeAdminSection === "accounts") renderAccounts();
    if (state.activeAdminSection === "tips") renderTips();
  };

  const updateTipSettingsFromForm = (form, { toggleChanged = false, renderForm = true } = {}) => {
    if (!form?.tips_enabled || !form?.tip_percentage) return false;
    const percentage = Number(form.tip_percentage.value);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
      if (toggleChanged) form.tips_enabled.checked = false;
      toast("El porcentaje de propina debe ser un número entero entre 1 y 100.", "error", "invalid-tip-percentage");
      form.tip_percentage.focus({ preventScroll: true });
      return false;
    }
    state.tipSettings = { enabled: form.tips_enabled.checked, percentage };
    persistTipSettings();
    state.accountsRenderSignature = "";
    if (renderForm) renderBusinessForm();
    syncTipFeatureVisibility();
    renderAccounts();
    if (state.activeAccountDetailId) renderAccountDetail();
    if (state.activeAdminSection === "tips") {
      if (tipsEnabled()) renderTips();
      else {
        history.replaceState(null, "", "#accounts");
        showAdminSection("accounts");
      }
    }
    return true;
  };

  const saveTipSettingsRemotely = async (settings = state.tipSettings) => {
    const saved = await retryQuiet(
      () => state.sb.from("business_settings").update({
        tips_enabled: settings.enabled === true,
        tip_percentage: Number(settings.percentage || 10)
      }).eq("is_primary", true).select("*").maybeSingle(),
      4
    );
    if (!saved) return false;
    state.business = saved;
    applyBusinessTipSettings();
    persistBootstrapCache();
    return true;
  };

  const saveOutdoorTableZonesRemotely = async (selectedIds) => {
    const outdoorIds = new Set([...selectedIds].map(String));
    const savedByRpc = await dbQuiet(
      state.sb.rpc("save_table_zones", {
        auth_token: state.authToken,
        outdoor_table_ids: [...outdoorIds]
      }),
      null
    );
    if (savedByRpc?.ok) return savedByRpc;

    const tables = normalTables();
    const saveGroup = async (isOutdoor) => {
      const ids = tables
        .filter((table) => outdoorIds.has(String(table.id)) === isOutdoor)
        .map((table) => table.id);
      if (!ids.length) return [];
      const saved = await retryQuiet(
        () => state.sb.from("restaurant_tables")
          .update({ is_outdoor: isOutdoor })
          .in("id", ids)
          .select("id,is_outdoor"),
        4
      );
      return Array.isArray(saved) && saved.length === ids.length ? saved : null;
    };

    const [outdoorTables, indoorTables] = await Promise.all([
      saveGroup(true),
      saveGroup(false)
    ]);
    if (!outdoorTables || !indoorTables) return null;
    return { ok: true, tables: [...outdoorTables, ...indoorTables] };
  };

  const deleteInventoryMovement = async (movementId) => {
    if (state.currentUser?.role !== "admin") return;
    const movement = state.inventoryMovements.find((entry) => String(entry.movementId) === String(movementId));
    if (!movement) return;
    const delta = Number(movement.delta ?? movement.quantityChange ?? 0);
    const restoredChange = -delta;
    const confirmed = await askForConfirmation({
      eyebrow: "Eliminar movimiento",
      title: `¿Eliminar el movimiento de ${movement.product || "este producto"}?`,
      message: `El historial se eliminará y el inventario se ajustará ${restoredChange >= 0 ? "+" : ""}${restoredChange.toLocaleString("es-CO", { maximumFractionDigits: 2 })} unidades para restaurar el cambio.`,
      accept: "Sí, eliminar y restaurar",
      cancel: "Conservar movimiento"
    });
    if (!confirmed) return;
    const button = $(`[data-delete-movement="${CSS.escape(String(movementId))}"]`);
    if (button) button.disabled = true;
    try {
      await requireCurrentAppsScriptVersion();
      await waitForRemoteQueue();
      const result = await appsScriptRequest("delete_inventory_movement", { movementId }, 40000);
      if (!result?.ok || result.deleted !== true || !Array.isArray(result.items)) {
        throw new Error(result?.error || `Publica Code.gs ${APPS_SCRIPT_REQUIRED_VERSION} para eliminar movimientos restaurando el inventario.`);
      }
      state.inventoryMovements = state.inventoryMovements.filter((entry) => String(entry.movementId) !== String(movementId));
      persistInventoryMovements();
      applyRemoteInventoryItems(result.items);
      renderInventoryMovements();
      void loadInventoryMovements();
      toast("Movimiento eliminado y existencias restauradas.", "ok", `movement-deleted:${movementId}`);
    } catch (error) {
      toast(String(error?.message || error), "error", `movement-delete-failed:${movementId}`);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  };

  const saveBusiness = async (form) => {
    const originalBusiness = state.business ? { ...state.business } : null;
    const originalTipSettings = { ...state.tipSettings };
    const originalTables = state.tables.map((table) => ({ ...table }));
    if (!updateTipSettingsFromForm(form, { renderForm: false })) return;
    const outdoorIds = state.outdoorTableDraftIds instanceof Set
      ? new Set(state.outdoorTableDraftIds)
      : new Set(normalTables().filter(isOutdoorTable).map((table) => String(table.id)));
    const payload = {
      is_primary: true,
      business_name: form.business_name.value.trim() || "Tu restaurante",
      subtitle: form.subtitle.value.trim(),
      accent_color: form.accent_color.value || "#f05a28",
      currency: DEFAULT_CURRENCY,
      logo_url: form.logo_url.value.trim(),
      cover_url: form.cover_url.value.trim(),
      tips_enabled: state.tipSettings.enabled === true,
      tip_percentage: Number(state.tipSettings.percentage || 10)
    };
    state.business = { ...(state.business || {}), ...payload };
    state.tables = state.tables.map((table) => isServicePoint(table)
      ? table
      : { ...table, is_outdoor: outdoorIds.has(String(table.id)) });
    persistBootstrapCache();
    renderBrand();
    renderBusinessForm();
    renderTables();
    renderServiceTables();
    const submit = form.querySelector('button[type="submit"]');
    const submitMarkup = submit?.innerHTML || "";
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = `${icon("loader-circle", 17)} Guardando...`;
      refreshIcons();
    }
    const savedBusiness = await retryQuiet(
      () => state.sb.from("business_settings").upsert(payload, { onConflict: "is_primary" }).select("*").single(),
      4
    );
    const savedTables = savedBusiness ? await saveOutdoorTableZonesRemotely(outdoorIds) : null;
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = submitMarkup;
    }
    if (savedBusiness && savedTables) {
      state.business = savedBusiness;
      applyBusinessTipSettings();
      if (Array.isArray(savedTables.tables)) {
        const zones = new Map(savedTables.tables.map((table) => [String(table.id), table.is_outdoor === true]));
        state.tables = state.tables.map((table) => zones.has(String(table.id)) ? { ...table, is_outdoor: zones.get(String(table.id)) } : table);
      }
      state.outdoorTableDraftIds = new Set(normalTables().filter(isOutdoorTable).map((table) => String(table.id)));
      state.outdoorTableDraftDirty = false;
      persistBootstrapCache();
      renderBrand();
      renderBusinessForm();
      renderTables();
      renderServiceTables();
      toast("Configuración guardada. La marca, la propina y las mesas ya están actualizadas.");
      refreshIcons();
      return;
    }
    if (savedBusiness && originalBusiness) {
      const rollbackPayload = {
        is_primary: true,
        business_name: originalBusiness.business_name || "Tu restaurante",
        subtitle: originalBusiness.subtitle || "",
        accent_color: originalBusiness.accent_color || "#f05a28",
        currency: DEFAULT_CURRENCY,
        logo_url: originalBusiness.logo_url || "",
        cover_url: originalBusiness.cover_url || "",
        tips_enabled: originalTipSettings.enabled === true,
        tip_percentage: Number(originalTipSettings.percentage || 10)
      };
      await retryQuiet(
        () => state.sb.from("business_settings").upsert(rollbackPayload, { onConflict: "is_primary" }).select("*").single(),
        2
      );
    }
    state.business = originalBusiness;
    state.tipSettings = originalTipSettings;
    state.tables = originalTables;
    state.outdoorTableDraftIds = new Set(normalTables().filter(isOutdoorTable).map((table) => String(table.id)));
    state.outdoorTableDraftDirty = false;
    persistTipSettings();
    persistBootstrapCache();
    renderBrand();
    renderBusinessForm();
    renderTables();
    renderServiceTables();
    toast("No se pudo guardar la configuración. Se restauró la información anterior.", "error", "business-save-failed");
    refreshIcons();
  };

  const uploadAsset = async (file, fieldName) => {
    if (!file) return;
    const status = $(`[data-upload-status="${fieldName}"]`);
    const box = $(`[data-upload-box="${fieldName}"]`);
    if (status) status.textContent = "Subiendo...";
    box?.classList.add("is-uploading");
    const extension = file.name.split(".").pop() || "jpg";
    const path = `brand/${fieldName}-${uid()}.${extension}`;
    const { error } = await state.sb.storage.from("brand-assets").upload(path, file, { upsert: true });
    if (error) {
      if (status) status.textContent = "No se pudo subir";
      box?.classList.remove("is-uploading");
      toast(`No se pudo subir: ${error.message}`, "error");
      return;
    }
    const { data } = state.sb.storage.from("brand-assets").getPublicUrl(path);
    const input = $(`[name="${fieldName}"]`);
    if (input) input.value = data.publicUrl;
    if (status) status.textContent = "Imagen cargada. Guarda para aplicar.";
    box?.classList.remove("is-uploading");
    box?.classList.add("has-file");
    toast("Imagen subida. Guarda la marca para aplicarla.");
  };

  const saveTable = async (form) => {
    const number = Number(form.table_number.value);
    const payload = {
      table_number: number,
      table_name: form.table_name.value.trim() || null,
      qr_code: `mesa-${number}`,
      qr_image_url: null,
      is_active: form.is_active.checked
    };
    if (!payload.table_number) {
      toast("El numero de mesa es obligatorio.", "error");
      return;
    }
    const id = form.table_id.value;
    const existing = id ? null : state.tables.find((table) => Number(table.table_number) === number);
    const targetId = id || existing?.id;
    const isUpdate = Boolean(targetId);
    const recordId = targetId || uid();
    const original = [...state.tables];
    const optimistic = { ...(state.tables.find((table) => table.id === recordId) || {}), ...payload, id: recordId };
    state.tables = isUpdate
      ? state.tables.map((table) => table.id === recordId ? optimistic : table)
      : [...state.tables, optimistic].sort((left, right) => Number(left.table_number || 0) - Number(right.table_number || 0));
    form.reset();
    form.table_id.value = "";
    persistBootstrapCache();
    renderTableManager();
    renderTables();
    renderTableFormQr();
    toast(isUpdate ? "Mesa actualizada. QR listo para descargar." : "Mesa guardada. QR listo para descargar.");
    void (async () => {
      const saved = await retryQuiet(
        () => isUpdate
          ? state.sb.from("restaurant_tables").update(payload).eq("id", recordId).select("*").single()
          : state.sb.from("restaurant_tables").insert({ ...payload, id: recordId }).select("*").single(),
        4
      );
      if (saved) {
        state.tables = state.tables.map((table) => table.id === recordId ? saved : table);
        persistBootstrapCache();
        return;
      }
      state.tables = original;
      persistBootstrapCache();
      renderTableManager();
      renderTables();
      renderTableFormQr();
      toast("No se pudo guardar la mesa. Se restauro la informacion.", "error", `table-save-failed:${recordId}`);
    })();
  };

  const saveCategory = async (form) => {
    const payload = {
      name: form.category_name.value.trim(),
      sort_order: Number(form.category_sort.value || 0),
      is_active: form.category_active.checked
    };
    if (!payload.name) {
      toast("La categoria necesita nombre.", "error");
      return;
    }
    const id = form.category_id.value;
    const query = id
      ? state.sb.from("menu_categories").update(payload).eq("id", id).select("*").single()
      : state.sb.from("menu_categories").insert(payload).select("*").single();
    const saved = await db(query, null);
    if (saved) {
      form.reset();
      form.category_id.value = "";
      form.category_active.checked = true;
      await loadCore();
      renderAdmin();
      toast("Categoria guardada.");
    }
  };

  const saveItem = async (form) => {
    let categoryId = form.category_id.value;
    const newCategory = form.new_category.value.trim();
    if (!categoryId && newCategory) {
      const category = await db(
        state.sb.from("menu_categories").insert({ name: newCategory, is_active: true }).select("*").single(),
        null
      );
      categoryId = category?.id || "";
    }
    const payload = {
      category_id: categoryId || null,
      name: form.item_name.value.trim(),
      description: form.description.value.trim(),
      price: currencyInputNumber(form.price),
      image_url: form.image_url.value.trim(),
      is_available: form.is_available.checked,
      sort_order: Number(form.sort_order.value || 0)
    };
    if (!payload.name || !payload.price) {
      toast("Producto y precio son obligatorios.", "error");
      return;
    }
    const id = form.item_id.value;
    const query = id
      ? state.sb.from("menu_items").update(payload).eq("id", id).select("*").single()
      : state.sb.from("menu_items").insert(payload).select("*").single();
    const saved = await db(query, null);
    if (saved) {
      form.reset();
      form.item_id.value = "";
      form.is_available.checked = true;
      await loadCore();
      renderAdmin();
      toast("Producto guardado.");
    }
  };

  const acknowledgeRequestOptimistically = (requestIds, payload, failureMessage) => {
    const ids = Array.isArray(requestIds) ? requestIds : String(requestIds || "").split(",").filter(Boolean);
    const idSet = new Set(ids);
    const originals = state.requests.filter((request) => idSet.has(request.id));
    if (!originals.length) return;
    const optimistic = { ...payload, updated_at: new Date().toISOString() };
    ids.forEach((id) => state.optimisticRequestStates.set(id, optimistic));
    state.requests = state.requests.map((request) => idSet.has(request.id) ? { ...request, ...optimistic } : request);
    renderAdminLive();

    void (async () => {
      const persist = () => state.sb.rpc("acknowledgeServiceRequests", {
        auth_token: state.authToken,
        ids,
        acknowledged_at: payload.acknowledged_at,
        message: payload.message
      }).then((fastResult) => {
        if (fastResult?.data && !fastResult?.error) return fastResult;
        return state.sb.from("service_requests").update(payload).in("id", ids).select("*");
      });
      const saved = await retryQuiet(
        persist,
        4
      );
      ids.forEach((id) => state.optimisticRequestStates.delete(id));
      if (!saved || !saved.length) {
        const originalMap = new Map(originals.map((request) => [request.id, request]));
        state.requests = state.requests.map((request) => originalMap.get(request.id) || request);
        renderAdminLive();
        toast(failureMessage, "error", `request-write-failed:${ids.join(":")}`);
        return;
      }
      const savedMap = new Map(saved.map((request) => [request.id, request]));
      state.requests = state.requests.map((request) => savedMap.has(request.id)
        ? { ...request, ...savedMap.get(request.id), restaurant_tables: request.restaurant_tables }
        : request);
      renderAdminLive();
    })();
  };

  const acceptRequest = async (ids) => {
    stopAlarm();
    const idList = String(ids || "").split(",").filter(Boolean);
    const sessionIds = [...new Set(state.requests.filter((request) => idList.includes(request.id)).map((request) => request.session_id).filter(Boolean))];
    if (sessionIds.length && state.currentUser?.id) {
      state.sessions = state.sessions.map((session) => {
        if (!sessionIds.includes(session.id)) return session;
        const optimisticSession = { ...session, assigned_waiter_id: state.currentUser.id, assigned_waiter: state.currentUser };
        state.optimisticSessionStates.set(session.id, {
          mode: "upsert",
          session: optimisticSession,
          expectedSession: { payer_name: optimisticSession.payer_name || "", assigned_waiter_id: state.currentUser.id }
        });
        return optimisticSession;
      });
      void (async () => {
        const savedSessions = await retryQuiet(
          () => state.sb.from("table_sessions").update({ assigned_waiter_id: state.currentUser.id }).in("id", sessionIds).select("*"),
          4
        );
        if (!savedSessions) sessionIds.forEach((sessionId) => state.optimisticSessionStates.delete(sessionId));
      })();
    }
    acknowledgeRequestOptimistically(
      ids,
      {
        status: "acknowledged",
        acknowledged_by_user_id: state.currentUser?.id || null,
        acknowledged_at: new Date().toISOString()
      },
      "No se pudo confirmar la solicitud. Volvio a la lista."
    );
  };

  const sendBillToClient = async (requestIds) => {
    stopAlarm();
    const ids = String(requestIds || "").split(",").filter(Boolean);
    const requestId = ids[0];
    const request = state.requests.find((entry) => entry.id === requestId);
    const session = state.sessions.find((entry) => entry.id === request?.session_id);
    if (!request || !session) {
      toast("No se encontro la cuenta abierta de esta mesa.", "error");
      return;
    }
    acknowledgeRequestOptimistically(
      ids,
      {
        status: "acknowledged",
        acknowledged_by_user_id: state.currentUser?.id || null,
        acknowledged_at: new Date().toISOString(),
        message: buildBillMessage(session)
      },
      "No se pudo enviar la cuenta. La solicitud volvio a la lista."
    );
  };

  const openMoveSessionDialog = (sessionId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session?.table_id) return;
    const form = $("#moveTableForm");
    const options = $("#moveTableOptions");
    if (!form || !options) return;
    form.reset();
    form.session_id.value = sessionId;
    const occupiedIds = new Set(state.sessions.filter((entry) => entry.id !== sessionId && entry.status === "open").map((entry) => String(entry.table_id)));
    const tables = state.tables.filter((table) => table.is_active !== false && String(table.id) !== String(session.table_id));
    $("#moveTableHint").textContent = `${sessionLabel(session)} · elige una mesa libre para trasladar todos los consumos.`;
    options.innerHTML = tables.length ? tables.map((table) => {
      const occupied = occupiedIds.has(String(table.id));
      return `<label class="move-table-option${occupied ? " is-occupied" : ""}"><input type="radio" name="target_table_id" value="${escapeHTML(table.id)}" ${occupied ? "disabled" : ""}><span>${icon("armchair", 20)}<strong>${escapeHTML(tableLabel(table))}</strong><small>${occupied ? "Ocupada" : "Libre"}</small></span></label>`;
    }).join("") : emptyState("No hay otra mesa", "Crea o activa otra mesa para mover esta cuenta.", "armchair");
    $("#moveTableDialog")?.showModal();
    refreshIcons();
  };

  const moveSessionToTable = async (sessionId, targetTableId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session?.table_id) return;
    const table = state.tables.find((entry) => String(entry.id) === String(targetTableId) && entry.is_active !== false);
    if (!table) {
      toast("Selecciona una mesa libre para continuar.", "error", "move-table-not-found");
      return;
    }
    if (String(table.id) === String(session.table_id)) return;
    if (state.sessions.some((entry) => entry.id !== sessionId && String(entry.table_id) === String(table.id) && entry.status === "open")) {
      toast("La mesa elegida ya tiene una cuenta abierta.", "error", "move-table-occupied");
      return;
    }
    $("#moveTableDialog")?.close();
    const original = session;
    state.sessions = state.sessions.map((entry) => entry.id === sessionId ? { ...entry, table_id: table.id, restaurant_tables: table } : entry);
    state.accountsRenderSignature = "";
    renderAdminLive();
    const saved = await retryQuiet(() => state.sb.from("table_sessions").update({ table_id: table.id, sale_channel: "table" }).eq("id", sessionId).select("*").single(), 4);
    if (!saved) {
      state.sessions = state.sessions.map((entry) => entry.id === sessionId ? original : entry);
      state.accountsRenderSignature = "";
      renderAdminLive();
      toast("No se pudo cambiar la mesa. La cuenta fue restaurada.", "error", `move-table:${sessionId}`);
      return;
    }
    const relatedUpdates = await Promise.all([
      dbQuiet(state.sb.from("session_items").update({ table_id: table.id, updated_by_user_id: state.currentUser?.id || null }).eq("session_id", sessionId).select("id"), null),
      dbQuiet(state.sb.from("service_requests").update({ table_id: table.id }).eq("session_id", sessionId).select("id"), null)
    ]);
    if (relatedUpdates.some((result) => result === null)) {
      await Promise.all([
        dbQuiet(state.sb.from("table_sessions").update({ table_id: original.table_id, sale_channel: original.sale_channel || "table" }).eq("id", sessionId), null),
        dbQuiet(state.sb.from("session_items").update({ table_id: original.table_id }).eq("session_id", sessionId), null),
        dbQuiet(state.sb.from("service_requests").update({ table_id: original.table_id }).eq("session_id", sessionId), null)
      ]);
      state.sessions = state.sessions.map((entry) => entry.id === sessionId ? original : entry);
      state.accountsRenderSignature = "";
      renderAdminLive();
      toast("No se pudo completar el cambio de mesa. La cuenta fue restaurada.", "error", `move-table-related:${sessionId}`);
      return;
    }
    toast(`Cuenta movida a ${tableLabel(table)}.`, "ok", `moved-table:${sessionId}`);
  };

  const closeSession = async (id, paymentMethod = "") => {
    const session = state.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    const totals = sessionTotals(session);
    if (isLocalWalkInSession(session)) {
      const closedAt = new Date().toISOString();
      const saved = {
        ...session,
        status: "closed",
        closed_at: closedAt,
        updated_at: closedAt,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        service_fee: totals.serviceFee,
        total: totals.total,
        payment_method: paymentMethod || null
      };
      state.sessions = state.sessions.filter((entry) => entry.id !== id);
      state.optimisticSessionStates.delete(id);
      persistWalkInDrafts();
      renderAdminLive();
      return { session, saved, totals };
    }
    const originalSessions = state.sessions;
    const originalRequests = state.requests;
    state.optimisticSessionStates.set(id, { mode: "remove", session });
    state.sessions = state.sessions.filter((entry) => entry.id !== id);
    state.requests = state.requests.map((request) => request.session_id === id ? { ...request, status: "resolved" } : request);
    renderAdminLive();
    const closedAt = new Date().toISOString();
    let saved = await retryQuiet(
      () => state.sb.from("table_sessions").update({
        status: "closed",
        closed_at: closedAt,
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        service_fee: totals.serviceFee,
        total: totals.total,
        payment_method: paymentMethod || null
      }).eq("id", id).eq("status", "open").select("*").single(),
      4
    );
    if (!saved) {
      const confirmed = await dbQuiet(state.sb.from("table_sessions").select("*").eq("id", id).maybeSingle(), null);
      if (confirmed?.status === "closed" && String(confirmed.closed_at || "") === closedAt) saved = confirmed;
    }
    if (!saved) {
      state.optimisticSessionStates.delete(id);
      state.sessions = originalSessions;
      state.requests = originalRequests;
      renderAdmin();
      toast("No se pudo cerrar la cuenta. Se restauro la informacion.", "error", `close-session-failed:${id}`);
      return null;
    }
    state.optimisticSessionStates.set(id, { mode: "remove", session: { ...session, ...saved } });
    await dbQuiet(state.sb.from("service_requests").update({ status: "resolved" }).eq("session_id", id), null);
    return { session, saved, totals };
  };

  const thermalReceiptHtml = (session, invoice = null) => {
    const businessName = String(state.business?.business_name || "Tu restaurante").trim() || "Tu restaurante";
    const totals = invoice?.totals || sessionTotals(session);
    const chargedTip = invoice ? Number(invoice.tipAmount ?? totals.tip ?? 0) : 0;
    const baseTotal = invoice
      ? Number(invoice.baseTotal ?? totals.baseTotal ?? Number(totals.total || 0) - chargedTip)
      : Number(totals.total || 0);
    const suggestedTip = !invoice && tipsEnabled() ? tipAmountFor(baseTotal) : 0;
    const receiptTotal = invoice ? Number(totals.total || baseTotal + chargedTip) : baseTotal + suggestedTip;
    const items = (invoice?.items || session.session_items || []).filter((item) => item.status !== "cancelled");
    const isPaid = Boolean(invoice);
    const receiptNumber = invoice?.number || `FACT-${sessionReference(session)}`;
    const issuedAt = new Date(invoice?.createdAt || Date.now());
    const payments = invoice?.payments || [];
    return `<!doctype html>
      <html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${isPaid ? "Factura" : "Pre-cuenta"} ${escapeHTML(receiptNumber)}</title>
      <style>
        @page { size: 80mm auto; margin: 3mm; }
        * { box-sizing: border-box; color: #000; text-shadow: .15px 0 #000; -webkit-text-stroke: .08px #000; }
        html { display: block; visibility: visible; min-height: 0; margin: 0; padding: 0; color: #000; background: #fff; }
        body { display: block; visibility: visible; width: 72mm; max-width: 72mm; min-height: 0; margin: 0 auto; padding: 0 3mm; overflow-wrap: anywhere; color: #000; background: #fff; font: 900 14.5px/1.38 "Courier New", monospace; }
        strong { color: #000; font-weight: 900; }
        small { color: #000; font-size: 13.5px; font-weight: 900; }
        .logo { margin: 2mm 0 0; text-align: center; font: 900 23px/1 Arial, sans-serif; letter-spacing: .5px; }
        .subtitle, .center { text-align: center; }
        .subtitle { margin: 1mm 0 3mm; font-weight: 900; }
        .rule { margin: 2.5mm 0; border-top: 1px dashed #000; }
        .meta, .totals { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 1mm 2mm; align-items: start; width: 100%; padding: 0 4mm; }
        .items { display: grid; gap: 2mm; }
        .item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 2mm; align-items: start; width: 100%; padding: 0 4mm; }
        .meta > *, .totals > *, .item > * { min-width: 0; }
        .meta strong { max-width: 27mm; overflow-wrap: anywhere; text-align: right; font-size: 14.5px; }
        .totals strong, .item > strong { white-space: nowrap; text-align: right; font-size: 14.5px; }
        .item small { display: block; }
        .total { margin-top: 1.5mm; font-size: 18px; font-weight: 900; }
        .totals strong.total { font-size: 17.5px; }
        .paid { padding: 1.5mm; border: 2px solid #000; text-align: center; font-weight: 900; }
        .footer { margin-top: 3mm; text-align: center; }
        @media screen { body { padding: 8mm 4mm; box-shadow: 0 0 22px #bbb; } }
        @media print {
          html { display: block !important; visibility: visible !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }
          body { display: block !important; visibility: visible !important; width: 72mm !important; max-width: 72mm !important; min-height: 0 !important; margin: 0 auto !important; padding: 0 3mm !important; overflow: visible !important; color: #000 !important; font-weight: 900 !important; transform: translateX(-6mm); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      </style></head><body>
        <div class="logo">${escapeHTML(businessName)}</div>
        <div class="subtitle">FACTURA DE VENTA</div>
        <div class="rule"></div>
        <div class="meta">
          <span>Documento:</span><strong>${escapeHTML(receiptNumber)}</strong>
          <span>Origen:</span><strong>${escapeHTML(sessionLabel(session))}</strong>
          <span>Fecha:</span><strong>${issuedAt.toLocaleDateString("es-CO")}</strong>
          <span>Hora:</span><strong>${issuedAt.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}</strong>
          <span>Responsable:</span><strong>${escapeHTML(session.payer_name || "Consumidor final")}</strong>
          <span>Mesero:</span><strong>${escapeHTML(session.assigned_waiter?.full_name || state.currentUser?.full_name || "Equipo")}</strong>
        </div>
        <div class="rule"></div>
        <div class="items">
          ${items.map((item) => `<div class="item"><span>${Number(item.quantity || 0)} x ${escapeHTML(item.item_name)}<small>${money(item.unit_price)} c/u</small></span><strong>${money(Number(item.unit_price) * Number(item.quantity))}</strong></div>`).join("") || "<div class=\"center\">Sin consumos</div>"}
        </div>
        <div class="rule"></div>
        <div class="totals">
          <span>Subtotal</span><strong>${money(totals.subtotal)}</strong>
          ${totals.discount ? `<span>Descuento</span><strong>-${money(totals.discount)}</strong>` : ""}
          ${totals.tax ? `<span>Impuestos</span><strong>${money(totals.tax)}</strong>` : ""}
          ${totals.serviceFee ? `<span>Servicio</span><strong>${money(totals.serviceFee)}</strong>` : ""}
          ${chargedTip ? `<span>Propina voluntaria${invoice.tipPercentage ? ` (${Number(invoice.tipPercentage)}%)` : ""}</span><strong>${money(chargedTip)}</strong>` : ""}
          ${suggestedTip ? `<span>Propina voluntaria sugerida (${state.tipSettings.percentage}%)</span><strong>${money(suggestedTip)}</strong>` : ""}
          <span class="total">${suggestedTip ? "TOTAL SUGERIDO" : "TOTAL"}</span><strong class="total">${money(receiptTotal)}</strong>
        </div>
        ${suggestedTip ? `<p class="center"><strong>La propina es voluntaria.</strong><br>El cliente puede pagar el consumo sin propina: ${money(baseTotal)}.</p>` : ""}
        ${isPaid ? `<div class="rule"></div><div class="paid">PAGADO</div><div class="meta" style="margin-top:2mm">${payments.map((payment) => `<span>${escapeHTML(paymentMethodLabel(payment.method))}</span><strong>${money(payment.amount)}</strong>`).join("")}${invoice.paymentMethod === "cash" && Number(invoice.cashReceived || 0) ? `<span>Recibido</span><strong>${money(invoice.cashReceived)}</strong><span>Cambio</span><strong>${money(invoice.changeDue)}</strong>` : ""}${invoice.reference ? `<span>Referencia</span><strong>${escapeHTML(invoice.reference)}</strong>` : ""}</div>` : ""}
        <div class="rule"></div>
        <div class="footer">Gracias por su compra<br><strong>${escapeHTML(businessName)}</strong></div>
      </body></html>`;
  };

  const printThermalReceipt = (session, invoice = null, receiptWindow = null) => {
    const popup = receiptWindow || window.open("", "_blank", "width=420,height=720");
    if (!popup) {
      toast("El navegador bloqueo la ventana de impresion. Habilita ventanas emergentes e intenta de nuevo.", "error", "receipt-popup-blocked");
      return false;
    }
    popup.document.open();
    popup.document.write(thermalReceiptHtml(session, invoice));
    popup.document.close();
    const receiptDocument = popup.document;
    const waitForReceiptLoad = () => {
      if (receiptDocument.readyState === "complete") return Promise.resolve();
      return new Promise((resolve) => {
        const complete = () => {
          if (receiptDocument.readyState !== "complete") return;
          popup.removeEventListener("load", complete);
          receiptDocument.removeEventListener("readystatechange", complete);
          resolve();
        };
        popup.addEventListener("load", complete, { once: true });
        receiptDocument.addEventListener("readystatechange", complete);
      });
    };
    const printWhenReady = async () => {
      await waitForReceiptLoad();
      try {
        if (receiptDocument.fonts?.ready) await receiptDocument.fonts.ready;
        const images = Array.from(receiptDocument.images || []);
        await Promise.all(images.map((image) => {
          if (image.complete) return image.decode?.().catch(() => undefined);
          return new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          });
        }));
        await new Promise((resolve) => popup.requestAnimationFrame(() => popup.requestAnimationFrame(resolve)));
      } finally {
        if (!popup.closed) {
          popup.focus();
          popup.print();
        }
      }
    };
    void printWhenReady();
    return true;
  };

  const updateMixedPayment = (changedField = "mixed_amount_one") => {
    const form = $("#paymentForm");
    const box = $("#paymentBalance");
    if (!form || !box) return;
    const total = integerMoney(state.activePaymentTotal);
    const first = currencyInputNumber(form.mixed_amount_one);
    const second = currencyInputNumber(form.mixed_amount_two);
    if (changedField === "mixed_amount_one") setCurrencyInputValue(form.mixed_amount_two, Math.max(0, total - first));
    if (changedField === "mixed_amount_two") setCurrencyInputValue(form.mixed_amount_one, Math.max(0, total - second));
    const currentFirst = currencyInputNumber(form.mixed_amount_one);
    const currentSecond = currencyInputNumber(form.mixed_amount_two);
    const difference = total - currentFirst - currentSecond;
    box.className = `payment-balance wide ${difference === 0 ? "is-balanced" : "is-unbalanced"}`;
    box.innerHTML = difference === 0
      ? `${icon("badge-check", 17)} Pago distribuido correctamente: ${money(total)}`
      : `${icon("circle-alert", 17)} ${difference > 0 ? "Faltan" : "Sobran"} ${money(Math.abs(difference))}`;
    refreshIcons();
  };

  const updateCashChange = () => {
    const form = $("#paymentForm");
    const box = $("#cashChange");
    if (!form || !box) return;
    const total = integerMoney(state.activePaymentTotal);
    const received = currencyInputNumber(form.cash_received);
    const change = received - total;
    box.className = `cash-change ${received >= total ? "is-sufficient" : "is-insufficient"}`;
    box.innerHTML = `<span>Vueltas / cambio</span><strong>${money(Math.max(0, change))}</strong><small>${received >= total ? `Recibido ${money(received)}` : `Faltan ${money(total - received)}`}</small>`;
  };

  const syncMixedMethods = (changedName) => {
    const form = $("#paymentForm");
    if (!form || form.mixed_method_one.value !== form.mixed_method_two.value) return;
    const other = changedName === "mixed_method_one" ? form.mixed_method_two : form.mixed_method_one;
    other.value = ["cash", "transfer", "breb"].find((method) => method !== form[changedName].value) || "cash";
  };

  const updatePaymentTipChoice = () => {
    const form = $("#paymentForm");
    if (!form) return;
    const baseTotal = integerMoney(state.activePaymentBase);
    const enabled = tipsEnabled();
    const choice = form.tip_choice?.value || "";
    const manualTip = enabled && choice === "with" ? currencyInputNumber(form.tip_amount) : 0;
    const suggestedTip = tipAmountFor(baseTotal);
    const tip = enabled && choice === "with" ? (manualTip || suggestedTip) : 0;
    const total = baseTotal + tip;
    state.activePaymentTip = tip;
    state.activePaymentTotal = total;
    if ($("#paymentTotal")) $("#paymentTotal").textContent = money(total);
    if ($("#paymentTotalHint")) $("#paymentTotalHint").textContent = enabled && !choice
      ? "Selecciona si el cliente paga con o sin propina para continuar."
      : tip
        ? `Incluye ${money(tip)} de propina voluntaria${manualTip ? " ingresada manualmente" : ""}.`
        : "Total del consumo sin propina.";
    if ($("#paymentWithoutTipAmount")) $("#paymentWithoutTipAmount").textContent = money(baseTotal);
    if ($("#paymentWithTipLabel")) $("#paymentWithTipLabel").textContent = manualTip ? "Con propina manual" : `Con propina (${state.tipSettings.percentage}%)`;
    if ($("#paymentWithTipAmount")) $("#paymentWithTipAmount").textContent = `${money(manualTip || suggestedTip)} · Total ${money(baseTotal + (manualTip || suggestedTip))}`;
    setCurrencyInputValue(form.cash_received, total);
    setCurrencyInputValue(form.mixed_amount_one, total);
    setCurrencyInputValue(form.mixed_amount_two, 0);
    const canSubmit = form.dataset.hasItems === "1";
    $$('button[type="submit"]', form).forEach((button) => { button.disabled = !canSubmit; });
    updateMixedPayment("mixed_amount_one");
    updateCashChange();
  };

  const showTipRequiredDialog = () => {
    const dialog = $("#tipRequiredDialog");
    if (!dialog) {
      toast("Antes de cobrar, elige una opción de propina.", "error", "tip-choice-required");
      return;
    }
    if (!dialog.open) dialog.showModal();
    refreshIcons();
  };

  const openPaymentDialog = (sessionId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    const dialog = $("#paymentDialog");
    const form = $("#paymentForm");
    if (!session || !dialog || !form) return;
    const quickSale = isLocalWalkInSession(session);
    const activeItems = (session.session_items || []).filter((item) => item.status !== "cancelled");
    const total = sessionTotal(session);
    if (!activeItems.length && !quickSale) {
      toast("Agrega al menos un consumo antes de cobrar la mesa.", "error", `empty-payment:${sessionId}`);
      return;
    }
    form.reset();
    form.session_id.value = session.id;
    form.payment_method.value = "cash";
    form.mixed_method_one.value = "cash";
    form.mixed_method_two.value = "transfer";
    form.dataset.hasItems = activeItems.length ? "1" : "0";
    state.activePaymentBase = total;
    state.activePaymentTip = 0;
    setCurrencyInputValue(form.mixed_amount_one, total);
    setCurrencyInputValue(form.mixed_amount_two, 0);
    setCurrencyInputValue(form.cash_received, total);
    state.activePaymentTotal = total;
    $("#paymentTableLabel").textContent = sessionLabel(session);
    $("#paymentTotal").textContent = money(total);
    const paymentLines = $("#paymentSaleLines");
    if (paymentLines) paymentLines.innerHTML = activeItems.length
      ? activeItems.map((item) => `<div><span>${Number(item.quantity || 0)} &times; ${escapeHTML(item.item_name)}</span><strong>${money(Number(item.quantity || 0) * Number(item.unit_price || 0))}</strong></div>`).join("")
      : '<p class="payment-empty-sale">Agrega el producto para continuar con el cobro.</p>';
    const addItemButton = $("#paymentAddItem");
    if (addItemButton) {
      addItemButton.hidden = !quickSale;
      addItemButton.innerHTML = `<i data-lucide="plus"></i> ${activeItems.length ? "Agregar otro producto" : "Agregar producto"}`;
    }
    const tipChoice = $("#paymentTipChoice");
    if (tipChoice) tipChoice.hidden = !tipsEnabled();
    if ($("#paymentDialogTitle")) $("#paymentDialogTitle").textContent = quickSale ? "Cobrar venta individual" : "Cobrar mesa";
    $("#mixedPaymentFields").hidden = true;
    $("#cashReceivedFields").hidden = false;
    updatePaymentTipChoice();
    dialog.showModal();
    form.scrollTop = 0;
    dialog.scrollTop = 0;
    window.requestAnimationFrame(() => {
      form.scrollTop = 0;
      dialog.scrollTop = 0;
    });
    refreshIcons();
  };

  const discardLocalWalkInSession = (sessionId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!isLocalWalkInSession(session)) return;
    state.sessions = state.sessions.filter((entry) => entry.id !== session.id);
    state.optimisticSessionStates.delete(session.id);
    persistWalkInDrafts();
    renderAdminLive();
  };

  const cancelPayment = () => {
    const sessionId = $("#paymentForm")?.session_id?.value || "";
    const session = state.sessions.find((entry) => entry.id === sessionId);
    $("#paymentDialog")?.close();
    if (isLocalWalkInSession(session)) {
      discardLocalWalkInSession(sessionId);
      toast("Venta individual cancelada. El inventario no fue modificado.", "ok", `walk-in-cancelled:${sessionId}`);
    }
  };

  const paymentFromForm = (form) => {
    const method = form.payment_method.value;
    const total = integerMoney(state.activePaymentTotal);
    if (method !== "mixed") return { method, payments: [{ method, amount: total }] };
    const firstMethod = form.mixed_method_one.value;
    const secondMethod = form.mixed_method_two.value;
    const firstAmount = currencyInputNumber(form.mixed_amount_one);
    const secondAmount = currencyInputNumber(form.mixed_amount_two);
    if (firstMethod === secondMethod || firstAmount <= 0 || secondAmount <= 0 || firstAmount + secondAmount !== total) return null;
    return { method, payments: [{ method: firstMethod, amount: firstAmount }, { method: secondMethod, amount: secondAmount }] };
  };

  const reflectInvoiceInIncomeReport = (invoice) => {
    const filters = incomeFiltersFromForm();
    const localRecord = localIncomeRecords(filters)
      .find((record) => String(record.saleId) === String(invoice.id || invoice.sessionId));
    if (!localRecord) return;
    if (!state.incomeReport) {
      state.incomeReport = localIncomeReport(filters);
      if (state.activeAdminSection === "income") renderIncomeReport();
      return;
    }
    const report = state.incomeReport;
    if (["dateFrom", "dateTo", "paymentMethod", "query"].some((key) => report.filters?.[key] !== filters[key])) return;
    const previousRecord = (report.records || []).find((record) => String(record.saleId) === String(localRecord.saleId));
    const records = [
      localRecord,
      ...(report.records || []).filter((record) => String(record.saleId) !== String(localRecord.saleId))
    ].sort((left, right) => String(right.date).localeCompare(String(left.date)));
    const addedTotals = incomeTotalsFromRecords([localRecord]);
    const removedTotals = previousRecord ? incomeTotalsFromRecords([previousRecord]) : incomeTotalsFromRecords([]);
    const totals = { ...report.totals };
    Object.keys(addedTotals).filter((key) => key !== "averageTicket").forEach((key) => {
      totals[key] = Number(totals[key] || 0) + Number(addedTotals[key] || 0) - Number(removedTotals[key] || 0);
    });
    totals.averageTicket = totals.sales ? totals.income / totals.sales : 0;
    state.incomeReport = {
      ...report,
      filters,
      records,
      totals,
      totalRecords: Math.max(Number(report.totalRecords || 0) + (previousRecord ? 0 : 1), records.length),
      pendingCount: Number(report.pendingCount || 0) + (previousRecord ? 0 : 1)
    };
    if (state.activeAdminSection === "income") renderIncomeReport();
  };

  const applyInvoiceToInventory = (invoice) => {
    if (state.invoiceHistory.some((entry) => entry.sessionId === invoice.sessionId)) return false;
    state.invoiceHistory.push(invoice);
    persistInvoiceHistory();
    reflectInvoiceInIncomeReport(invoice);
    enqueueAppsScriptJob("record_sale", { invoice }, `sale:${invoice.sessionId}`);
    return true;
  };

  const paidInventoryPlan = (session) => {
    const quantities = new Map();
    newestSessionItems(session).forEach((line) => {
      if (!line.menu_item_id || !Object.prototype.hasOwnProperty.call(state.inventoryMeta, line.menu_item_id)) return;
      quantities.set(line.menu_item_id, Number(quantities.get(line.menu_item_id) || 0) + Number(line.quantity || 0));
    });
    const legacyAdjusted = new Map();
    state.inventoryMovements.forEach((movement) => {
      if (String(movement.sessionId || "") !== String(session.id)) return;
      if (!["CONSUMO_MESA", "DEVOLUCION_CONSUMO"].includes(String(movement.type || "").toUpperCase())) return;
      legacyAdjusted.set(movement.productId, Number(legacyAdjusted.get(movement.productId) || 0) - Number(movement.delta || 0));
    });
    return Array.from(quantities.entries()).map(([productId, quantity]) => {
      const item = state.items.find((entry) => entry.id === productId);
      const alreadyAdjusted = Math.max(0, Number(legacyAdjusted.get(productId) || 0));
      return { item, quantity: Math.max(0, quantity - alreadyAdjusted) };
    }).filter((entry) => entry.item && entry.quantity > 0);
  };

  const validatePaidInventory = (plan) => {
    const insufficient = plan.find((entry) => inventoryFor(entry.item).stock < entry.quantity);
    if (!insufficient) return true;
    const available = inventoryFor(insufficient.item).stock;
    toast(`${insufficient.item.name} requiere ${insufficient.quantity} y solo hay ${available}. Corrige la cuenta o el inventario antes de cobrar.`, "error", `payment-stock:${insufficient.item.id}`);
    return false;
  };

  const applyPaidInventoryLocally = (invoice, plan) => {
    plan.forEach(({ item, quantity }) => {
      const eventId = `SALE-${invoice.id}-${item.id}`;
      if (state.inventoryMovements.some((movement) => movement.movementId === eventId)) return;
      const current = inventoryFor(item);
      const nextStock = Math.max(0, current.stock - quantity);
      state.inventoryMeta[item.id] = { ...current, stock: nextStock, updatedAt: invoice.createdAt };
      recordLocalInventoryMovement({ eventId, item, delta: -quantity, before: current.stock, after: nextStock, type: "SALIDA_VENTA", reference: invoice.number, occurredAt: invoice.createdAt });
      const movement = state.inventoryMovements.find((entry) => entry.movementId === eventId);
      if (movement) movement.sessionId = invoice.sessionId;
    });
    persistInventoryStore();
    persistInventoryMovements();
  };

  const openReceiptResult = (session, invoice) => {
    state.lastPaidReceipt = { session, invoice };
    if ($("#receiptResultTitle")) $("#receiptResultTitle").textContent = `Factura ${invoice.number}`;
    if ($("#receiptResultMessage")) $("#receiptResultMessage").textContent = `${sessionLabel(session)} · ${money(invoice.totals.total)} · ${paymentMethodLabel(invoice.paymentMethod)}.`;
    $("#receiptResultDialog")?.showModal();
    refreshIcons();
  };

  const printLastPaidReceipt = () => {
    const receipt = state.lastPaidReceipt;
    if (!receipt) {
      toast("No hay una factura reciente disponible para imprimir.", "error", "receipt-missing");
      return false;
    }
    return printThermalReceipt(receipt.session, receipt.invoice);
  };

  const processPayment = async (form, submitter) => {
    if (state.paymentProcessing) return;
    const session = state.sessions.find((entry) => entry.id === form.session_id.value);
    if (!session) {
      toast("La cuenta ya no esta abierta.", "error", "payment-session-missing");
      return;
    }
    if (!(session.session_items || []).some((item) => item.status !== "cancelled")) {
      toast("Agrega al menos un producto antes de cobrar.", "error", `empty-payment:${session.id}`);
      return;
    }
    if (tipsEnabled() && !form.tip_choice?.value) {
      showTipRequiredDialog();
      return;
    }
    const payment = paymentFromForm(form);
    if (!payment) {
      toast("En pago mixto usa dos medios diferentes y distribuye exactamente el total.", "error", "invalid-mixed-payment");
      return;
    }
    if (payment.method === "cash" && currencyInputNumber(form.cash_received) < integerMoney(state.activePaymentTotal)) {
      toast("El dinero recibido no alcanza para cubrir el total.", "error", "insufficient-cash");
      form.cash_received.focus({ preventScroll: true });
      return;
    }
    const shouldPrint = submitter?.value === "print";
    const receiptWindow = shouldPrint ? window.open("", "_blank", "width=420,height=720") : null;
    const buttons = $$('button[type="submit"]', form);
    buttons.forEach((button) => { button.disabled = true; });
    state.paymentProcessing = true;
    const inventoryPlan = paidInventoryPlan(session);
    if (!validatePaidInventory(inventoryPlan)) {
      receiptWindow?.close();
      buttons.forEach((button) => { button.disabled = false; });
      state.paymentProcessing = false;
      return;
    }
    const closed = await closeSession(session.id, payment.method);
    buttons.forEach((button) => { button.disabled = false; });
    if (!closed) {
      receiptWindow?.close();
      state.paymentProcessing = false;
      return;
    }
    const createdAt = closed.saved.closed_at || new Date().toISOString();
    const manualTip = tipsEnabled() && form.tip_choice.value === "with" ? currencyInputNumber(form.tip_amount) : 0;
    const tipPercentage = tipsEnabled() && form.tip_choice.value === "with" && !manualTip ? Number(state.tipSettings.percentage) : 0;
    const tipAmount = manualTip || (tipPercentage ? tipAmountFor(closed.totals.total, tipPercentage) : 0);
    const invoiceTotals = {
      ...closed.totals,
      baseTotal: integerMoney(closed.totals.total),
      tip: tipAmount,
      total: integerMoney(closed.totals.total) + tipAmount
    };
    const invoice = {
      id: uid(),
      number: `TN-${new Date(createdAt).toISOString().slice(0, 10).replace(/-/g, "")}-${sessionReference(session)}`,
      sessionId: session.id,
      tableId: session.table_id,
      table: sessionLabel(session),
      saleChannel: session.sale_channel || "table",
      soldByUserId: state.currentUser?.id || session.assigned_waiter_id || null,
      createdAt,
      payerName: session.payer_name || "",
      waiterName: state.currentUser?.full_name || session.assigned_waiter?.full_name || "",
      paymentMethod: payment.method,
      payments: payment.payments,
      withTip: tipAmount > 0,
      tipPercentage,
      tipAmount,
      tipIsManual: manualTip > 0,
      baseTotal: integerMoney(closed.totals.total),
      reference: form.payment_reference.value.trim(),
      cashReceived: payment.method === "cash" ? currencyInputNumber(form.cash_received) : null,
      changeDue: payment.method === "cash" ? currencyInputNumber(form.cash_received) - invoiceTotals.total : 0,
      inventoryAdjustedOnConsumption: false,
      totals: invoiceTotals,
      items: (session.session_items || []).filter((item) => item.status !== "cancelled").map((item) => ({
        id: item.id,
        menu_item_id: item.menu_item_id || null,
        item_name: item.item_name,
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || 0),
        unit_cost: Number(state.inventoryMeta[item.menu_item_id]?.costPrice || 0),
        status: item.status
      }))
    };
    applyPaidInventoryLocally(invoice, inventoryPlan);
    applyInvoiceToInventory(invoice);
    $("#paymentDialog")?.close();
    renderInventory();
    renderTips();
    if (shouldPrint) printThermalReceipt(session, invoice, receiptWindow);
    toast(`Pago registrado por ${paymentMethodLabel(payment.method)}. Factura ${invoice.number}.`, "ok", `paid:${session.id}`);
    state.paymentProcessing = false;
  };

  const renderConsumptionSelection = () => {
    const box = $("#consumptionSelection");
    const lines = $("#consumptionSelectionLines");
    const count = $("#consumptionSelectionCount");
    const total = $("#consumptionSelectionTotal");
    const priceWarning = $("#consumptionSelectionPriceWarning");
    if (!box || !lines || !count || !total) return;
    const drafts = state.consumptionDrafts;
    const canEditPrice = state.currentUser?.role !== "waiter";
    const hasEditedPrice = drafts.some((draft) => draft.menuItemId && Number(draft.unitPrice) !== Number(draft.originalUnitPrice));
    box.hidden = drafts.length === 0;
    count.textContent = `${drafts.length} ${drafts.length === 1 ? "producto" : "productos"}`;
    total.textContent = money(drafts.reduce((sum, draft) => sum + draft.quantity * draft.unitPrice, 0));
    if (priceWarning) priceWarning.hidden = !hasEditedPrice;
    lines.innerHTML = drafts.map((draft, index) => `<div class="${state.consumptionDraftEditIndex === index ? "is-editing" : ""}"><span class="consumption-draft-product" data-edit-consumption-product="${index}" title="Doble clic para cambiar este producto"><strong>${escapeHTML(draft.itemName)}</strong><small>${draft.quantity} × ${money(draft.unitPrice)}</small></span><strong${canEditPrice ? ` class="consumption-draft-price" data-edit-consumption-price="${index}" title="Doble clic para editar el precio unitario"` : ""}>${money(draft.quantity * draft.unitPrice)}</strong><button class="icon-btn danger" type="button" data-remove-consumption-draft="${index}" aria-label="Quitar ${escapeHTML(draft.itemName)}">${icon("x", 15)}</button></div>`).join("");
    const form = $("#consumptionForm");
    if (form) form.quantity.required = drafts.length === 0;
    updateConsumptionDraftAction();
    refreshIcons();
  };

  const updateConsumptionDraftAction = () => {
    const queue = $("#consumptionQueueButton");
    if (!queue) return;
    queue.innerHTML = state.consumptionDraftEditIndex >= 0
      ? `${icon("save", 16)} Guardar cambio`
      : `${icon("list-plus", 16)} Añadir a selección`;
    refreshIcons();
  };

  const editConsumptionDraftProduct = (index) => {
    const draft = state.consumptionDrafts[index];
    const form = $("#consumptionForm");
    const search = $("#consumptionProductSearch");
    if (!draft || !form || !search) return;
    state.consumptionDraftEditIndex = index;
    form.menu_item_id.value = draft.menuItemId || "";
    form.item_name.value = draft.itemName || "";
    form.quantity.value = draft.quantity || 1;
    form.notes.value = draft.notes || "";
    form.payer_name.value = draft.payerName || form.payer_name.value;
    setCurrencyInputValue(form.unit_price, draft.unitPrice || 0);
    const product = state.items.find((item) => item.id === draft.menuItemId);
    search.value = product ? `${inventoryFor(product).code} · ${product.name}` : draft.itemName || "";
    renderConsumptionProductOptions(product?.name || draft.itemName || "");
    closeConsumptionProductOptions();
    updateConsumptionDraftAction();
    renderConsumptionSelection();
    window.requestAnimationFrame(() => {
      search.focus({ preventScroll: true });
      search.select();
    });
  };

  const editConsumptionDraftPrice = (priceElement) => {
    if (state.currentUser?.role === "waiter") return;
    const index = Number(priceElement?.dataset.editConsumptionPrice);
    const draft = state.consumptionDrafts[index];
    if (!Number.isInteger(index) || !draft) return;
    const input = document.createElement("input");
    input.className = "consumption-draft-price-editor";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.setAttribute("aria-label", `Precio unitario de ${draft.itemName}`);
    input.value = formattedCurrencyInput(draft.unitPrice);
    let saved = false;
    const save = () => {
      if (saved) return;
      saved = true;
      draft.unitPrice = currencyInputNumber(input);
      if (state.consumptionDraftEditIndex === index) {
        const form = $("#consumptionForm");
        if (form?.unit_price) setCurrencyInputValue(form.unit_price, draft.unitPrice);
      }
      renderConsumptionSelection();
    };
    input.addEventListener("input", () => {
      input.value = formattedCurrencyInput(input.value, { allowEmpty: true });
      input.setSelectionRange?.(input.value.length, input.value.length);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        saved = true;
        renderConsumptionSelection();
      }
    });
    input.addEventListener("blur", save, { once: true });
    priceElement.replaceWith(input);
    window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  };

  const currentConsumptionDraft = (form, { quiet = false } = {}) => {
    const selectedItem = state.items.find((item) => item.id === form.menu_item_id.value);
    const itemName = form.item_name.value.trim() || selectedItem?.name || "";
    const quantity = Number(String(form.quantity.value || "").trim());
    const unitPrice = form.unit_price.value.trim() ? currencyInputNumber(form.unit_price) : Number(selectedItem?.price || 0);
    if (!itemName || !Number.isInteger(quantity) || quantity < 1 || quantity > 100 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      if (!quiet) toast("Selecciona un producto y revisa su cantidad antes de añadirlo.", "error", "invalid-consumption-draft");
      return null;
    }
    return {
      menuItemId: selectedItem?.id || null,
      itemName,
      quantity,
      unitPrice,
      originalUnitPrice: selectedItem ? Number(selectedItem.price || 0) : null,
      notes: form.notes.value.trim(),
      payerName: form.payer_name.value.trim()
    };
  };

  const clearConsumptionEntry = (form) => {
    form.menu_item_id.value = "";
    form.item_name.value = "";
    form.quantity.value = "";
    form.notes.value = "";
    setCurrencyInputValue(form.unit_price, 0);
    if ($("#consumptionProductSearch")) $("#consumptionProductSearch").value = "";
    renderConsumptionProductOptions("");
    closeConsumptionProductOptions();
    state.consumptionDraftEditIndex = -1;
    updateConsumptionDraftAction();
  };

  const queueConsumptionDraft = () => {
    const form = $("#consumptionForm");
    if (!form || form.session_item_id.value) return false;
    const draft = currentConsumptionDraft(form);
    if (!draft) return false;
    if (state.consumptionDraftEditIndex >= 0 && state.consumptionDrafts[state.consumptionDraftEditIndex]) {
      state.consumptionDrafts[state.consumptionDraftEditIndex] = draft;
    } else {
      state.consumptionDrafts.push(draft);
    }
    clearConsumptionEntry(form);
    renderConsumptionSelection();
    window.requestAnimationFrame(() => $("#consumptionProductSearch")?.focus({ preventScroll: true }));
    return true;
  };

  const applyConsumptionRoleRestrictions = (form) => {
    if (!form) return;
    const waiter = state.currentUser?.role === "waiter";
    [form.item_name, form.unit_price].forEach((field) => {
      if (!field) return;
      field.readOnly = waiter;
      field.setAttribute("aria-readonly", String(waiter));
      field.title = waiter ? "Solo un administrador puede cambiar este dato." : "";
    });
  };

  const setTableConsumptionPreviewVisible = (visible) => {
    const preview = $("#tableConsumptionPreview");
    const button = $("#viewTableConsumption");
    if (!preview || !button || button.hidden) return;
    preview.hidden = !visible;
    button.innerHTML = visible
      ? `${icon("list-x", 17)} Esconder lista`
      : `${icon("receipt-text", 17)} Ver consumo`;
    button.setAttribute("aria-expanded", String(visible));
    refreshIcons();
  };

  const renderTableConsumptionPreview = (session) => {
    const preview = $("#tableConsumptionPreview");
    const actions = $("#tableSessionActions");
    if (!preview || !actions) return;
    const items = session ? newestSessionItems(session) : [];
    const emptyAccount = Boolean(session) && !items.length && sessionTotal(session) <= 0;
    actions.hidden = !session || isLocalWalkInSession(session);
    const viewButton = $("#viewTableConsumption");
    const chargeButton = $("#chargeTableAccount");
    const releaseButton = $("#releaseEmptyTable");
    if (viewButton) viewButton.hidden = emptyAccount;
    if (chargeButton) chargeButton.hidden = emptyAccount;
    if (releaseButton) releaseButton.hidden = !emptyAccount;
    actions.classList.toggle("is-single", emptyAccount);
    preview.hidden = true;
    if (!session) {
      preview.innerHTML = "";
      return;
    }
    preview.innerHTML = `<div class="table-consumption-preview-head"><span>Consumo actual</span><strong>${money(sessionTotal(session))}</strong></div><div class="table-consumption-preview-lines">${items.map((item) => `<div><span>${Number(item.quantity || 0)} × ${escapeHTML(item.item_name)}</span><strong>${money(Number(item.quantity || 0) * Number(item.unit_price || 0))}</strong></div>`).join("") || "<small>Sin consumos registrados.</small>"}</div>`;
    setTableConsumptionPreviewVisible(false);
  };

  const addConsumptionBatch = async (form, drafts) => {
    let sessionId = form.session_id.value;
    let session = state.sessions.find((entry) => entry.id === sessionId);
    const pendingTableId = form.pending_table_id.value;
    const table = state.tables.find((entry) => String(entry.id) === String(pendingTableId || session?.table_id));
    if (!session && !table) return null;

    const originalSession = session || null;
    const optimisticSessionId = session?.id || uid();
    const openedAt = new Date().toISOString();
    if (!session) {
      session = {
        id: optimisticSessionId,
        table_id: table.id,
        status: "open",
        sale_channel: "table",
        payer_name: "",
        assigned_waiter_id: state.currentUser?.id || null,
        assigned_waiter: state.currentUser,
        restaurant_tables: table,
        session_items: [],
        opened_at: openedAt,
        created_at: openedAt,
        updated_at: openedAt
      };
      state.sessions = [session, ...state.sessions];
    }

    const payerName = [...drafts].reverse().find((draft) => draft.payerName)?.payerName || form.payer_name.value.trim() || session.payer_name || "";
    const optimisticItems = drafts.map((draft, index) => ({
      id: `local-batch-${uid()}`,
      session_id: optimisticSessionId,
      table_id: session.table_id,
      menu_item_id: draft.menuItemId || null,
      item_name: draft.itemName,
      unit_price: Number(draft.unitPrice || 0),
      quantity: Number(draft.quantity || 0),
      notes: draft.notes || "",
      status: "served",
      created_by_user_id: state.currentUser?.id || null,
      updated_by_user_id: state.currentUser?.id || null,
      created_by_user: state.currentUser,
      created_at: new Date(Date.now() + index).toISOString(),
      updated_at: new Date().toISOString()
    }));
    const optimisticSession = {
      ...session,
      payer_name: payerName,
      assigned_waiter_id: state.currentUser?.id || session.assigned_waiter_id,
      assigned_waiter: state.currentUser || session.assigned_waiter,
      session_items: [...(session.session_items || []), ...optimisticItems]
    };
    state.sessions = state.sessions.map((entry) => entry.id === optimisticSessionId ? optimisticSession : entry);
    state.optimisticSessionStates.set(optimisticSessionId, {
      mode: "upsert",
      session: optimisticSession,
      expectedItems: optimisticItems,
      expectedSession: {
        payer_name: optimisticSession.payer_name || "",
        assigned_waiter_id: optimisticSession.assigned_waiter_id || ""
      }
    });
    form.session_id.value = optimisticSessionId;
    form.pending_table_id.value = "";
    state.accountsRenderSignature = "";
    renderAdminLive();
    toast(`${drafts.length} ${drafts.length === 1 ? "producto agregado" : "productos agregados"} a la cuenta.`, "ok", `consumption-batch-optimistic:${optimisticSessionId}`);

    if (isLocalWalkInSession(session)) {
      state.optimisticSessionStates.set(optimisticSessionId, { mode: "upsert", localOnly: true, session: optimisticSession });
      persistWalkInDrafts();
      return { sessionId: optimisticSessionId, items: optimisticItems };
    }

    let savedSession = null;
    let persistedSessionId = optimisticSessionId;
    if (!originalSession) {
      savedSession = await retryQuiet(
        () => state.sb.from("table_sessions").insert({
          id: optimisticSessionId,
          table_id: session.table_id,
          status: "open",
          sale_channel: "table",
          payer_name: payerName,
          assigned_waiter_id: state.currentUser?.id || null
        }).select("*").single(),
        4
      );
      if (!savedSession) {
        savedSession = await dbQuiet(
          state.sb.from("table_sessions").select("*, session_items(*)")
            .eq("table_id", session.table_id).eq("status", "open")
            .order("opened_at", { ascending: false }).limit(1).maybeSingle(),
          null
        );
      }
      if (savedSession?.id && savedSession.id !== optimisticSessionId) {
        persistedSessionId = savedSession.id;
        const remappedItems = optimisticItems.map((item) => ({ ...item, session_id: persistedSessionId }));
        const remappedSession = {
          ...optimisticSession,
          ...savedSession,
          assigned_waiter: state.currentUser || optimisticSession.assigned_waiter,
          restaurant_tables: table,
          session_items: [...(savedSession.session_items || []), ...remappedItems]
        };
        state.sessions = state.sessions.map((entry) => entry.id === optimisticSessionId ? remappedSession : entry);
        state.optimisticSessionStates.delete(optimisticSessionId);
        state.optimisticSessionStates.set(persistedSessionId, {
          mode: "upsert",
          session: remappedSession,
          expectedItems: remappedItems,
          expectedSession: { payer_name: payerName, assigned_waiter_id: state.currentUser?.id || "" }
        });
        form.session_id.value = persistedSessionId;
      }
    }

    if (!originalSession && !savedSession) {
      state.optimisticSessionStates.delete(optimisticSessionId);
      state.sessions = state.sessions.filter((entry) => entry.id !== optimisticSessionId);
      form.session_id.value = "";
      form.pending_table_id.value = table.id;
      state.accountsRenderSignature = "";
      renderAdminLive();
      toast("No fue posible abrir la cuenta de la mesa. La selección fue restaurada.", "error", `batch-session-failed:${optimisticSessionId}`);
      return null;
    }

    const payloads = drafts.map((draft) => ({
      session_id: persistedSessionId,
      table_id: session.table_id,
      menu_item_id: draft.menuItemId || null,
      item_name: draft.itemName,
      unit_price: Number(draft.unitPrice || 0),
      quantity: Number(draft.quantity || 0),
      notes: draft.notes || "",
      status: "served",
      created_by_user_id: state.currentUser?.id || null,
      updated_by_user_id: state.currentUser?.id || null
    }));
    const sessionUpdatePromise = originalSession
      ? retryQuiet(() => state.sb.from("table_sessions").update({
          payer_name: payerName,
          assigned_waiter_id: state.currentUser?.id || originalSession.assigned_waiter_id || null
        }).eq("id", persistedSessionId).select("*").single(), 4)
      : Promise.resolve(savedSession);
    const itemsPromise = retryQuiet(() => state.sb.from("session_items").insert(payloads).select("*"), 4);
    const [sessionSaved, savedItems] = await Promise.all([sessionUpdatePromise, itemsPromise]);
    if (!Array.isArray(savedItems) || savedItems.length !== drafts.length) {
      state.optimisticSessionStates.delete(optimisticSessionId);
      state.optimisticSessionStates.delete(persistedSessionId);
      if (originalSession) {
        state.sessions = state.sessions.map((entry) => entry.id === persistedSessionId ? originalSession : entry);
      } else {
        state.sessions = state.sessions.filter((entry) => ![optimisticSessionId, persistedSessionId].includes(entry.id));
        form.session_id.value = "";
        form.pending_table_id.value = table.id;
        void dbQuiet(state.sb.from("table_sessions").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", persistedSessionId), null);
      }
      state.accountsRenderSignature = "";
      renderAdminLive();
      toast("No se pudo guardar la selección. La cuenta volvió a su valor anterior.", "error", `consumption-batch-failed:${persistedSessionId}`);
      return null;
    }

    const temporaryIds = new Set(optimisticItems.map((item) => item.id));
    let confirmedSession = null;
    state.sessions = state.sessions.map((entry) => entry.id === persistedSessionId
      ? (confirmedSession = {
          ...entry,
          ...(sessionSaved || {}),
          restaurant_tables: entry.restaurant_tables || table,
          assigned_waiter: state.currentUser || entry.assigned_waiter,
          session_items: [
            ...(entry.session_items || []).filter((item) => !temporaryIds.has(item.id)),
            ...savedItems.map((item) => ({ ...item, created_by_user: state.currentUser }))
          ]
        })
      : entry);
    state.optimisticSessionStates.set(persistedSessionId, {
      mode: "upsert",
      session: confirmedSession,
      expectedItems: savedItems,
      expectedSession: sessionSaved ? {
        payer_name: sessionSaved.payer_name || "",
        assigned_waiter_id: sessionSaved.assigned_waiter_id || ""
      } : null
    });
    return { sessionId: persistedSessionId, items: savedItems };
  };

  const confirmConsumptionSelection = async (form) => {
    if (form.session_item_id.value) return addManualConsumption(form);
    const hasPendingEntry = Boolean(form.menu_item_id.value || form.item_name.value.trim() || form.quantity.value || $("#consumptionProductSearch")?.value.trim());
    const pendingEntry = currentConsumptionDraft(form, { quiet: true });
    if (hasPendingEntry && !pendingEntry) {
      currentConsumptionDraft(form);
      return null;
    }
    if (pendingEntry) {
      if (state.consumptionDraftEditIndex >= 0 && state.consumptionDrafts[state.consumptionDraftEditIndex]) {
        state.consumptionDrafts[state.consumptionDraftEditIndex] = pendingEntry;
      } else {
        state.consumptionDrafts.push(pendingEntry);
      }
      state.consumptionDraftEditIndex = -1;
    }
    if (!state.consumptionDrafts.length) {
      toast("Añade al menos un producto a la selección.", "error", "empty-consumption-selection");
      return null;
    }
    const drafts = [...state.consumptionDrafts];
    const quickCheckout = form.quick_checkout.value === "1";
    const submit = $("#consumptionSubmitButton");
    const queue = $("#consumptionQueueButton");
    if (submit) submit.disabled = true;
    if (queue) queue.disabled = true;
    $("#consumptionDialog")?.close();
    const result = await addConsumptionBatch(form, drafts);
    if (submit) submit.disabled = false;
    if (queue) queue.disabled = false;
    if (!result) {
      state.consumptionDrafts = drafts;
      clearConsumptionEntry(form);
      renderConsumptionSelection();
      return null;
    }
    state.consumptionDrafts = [];
    state.consumptionDraftEditIndex = -1;
    renderConsumptionSelection();
    const sessionId = result.sessionId;
    $("#consumptionDialog")?.close();
    clearConsumptionEntry(form);
    if (quickCheckout) openPaymentDialog(sessionId);
    return sessionId;
  };

  const openConsumptionDialog = (sessionId = "", { pendingTableId = "", quickCheckout = false } = {}) => {
    const dialog = $("#consumptionDialog");
    const form = $("#consumptionForm");
    if (!dialog || !form) return;
    form.reset();
    form.session_id.value = sessionId;
    form.session_item_id.value = "";
    form.pending_table_id.value = pendingTableId;
    form.quick_checkout.value = quickCheckout ? "1" : "0";
    form.quantity.required = true;
    applyConsumptionRoleRestrictions(form);
    state.consumptionDrafts = [];
    state.consumptionDraftEditIndex = -1;
    const session = state.sessions.find((entry) => entry.id === sessionId);
    form.payer_name.value = session?.payer_name || "";
    form.quantity.value = "";
    setCurrencyInputValue(form.unit_price, 0);
    const productSearch = $("#consumptionProductSearch");
    if (productSearch) productSearch.value = "";
    const optionalFields = $("#consumptionOptionalFields");
    if (optionalFields) optionalFields.open = false;
    const table = state.tables.find((entry) => String(entry.id) === String(pendingTableId || session?.table_id));
    if ($("#consumptionEyebrow")) $("#consumptionEyebrow").textContent = quickCheckout ? "Venta individual" : "Consumo";
    if ($("#consumptionDialogTitle")) $("#consumptionDialogTitle").textContent = quickCheckout ? "Agregar producto y cobrar" : `Agregar a ${table ? tableLabel(table) : "la cuenta"}`;
    const submitLabel = $("#consumptionSubmitButton span");
    if (submitLabel) submitLabel.textContent = quickCheckout ? "Confirmar y cobrar" : "Confirmar selección";
    if ($("#consumptionQueueButton")) $("#consumptionQueueButton").hidden = false;
    renderConsumptionSelection();
    renderTableConsumptionPreview(session);
    closeConsumptionProductOptions();
    dialog.showModal();
    window.setTimeout(() => {
      productSearch?.focus({ preventScroll: true });
    }, 0);
  };

  const cancelConsumption = () => {
    const form = $("#consumptionForm");
    if (!form) return;
    const session = state.sessions.find((entry) => entry.id === form.session_id.value);
    const quickCheckout = form.quick_checkout.value === "1";
    state.consumptionDrafts = [];
    state.consumptionDraftEditIndex = -1;
    renderConsumptionSelection();
    $("#consumptionDialog")?.close();
    if (!quickCheckout || !isLocalWalkInSession(session)) return;
    const hasItems = (session.session_items || []).some((item) => item.status !== "cancelled");
    if (hasItems) openPaymentDialog(session.id);
    else {
      discardLocalWalkInSession(session.id);
      toast("Venta individual cancelada.", "ok", `walk-in-cancelled:${session.id}`);
    }
  };

  const editConsumption = (sessionId, itemId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    const item = session?.session_items?.find((entry) => entry.id === itemId);
    const form = $("#consumptionForm");
    const dialog = $("#consumptionDialog");
    if (!session || !item || !form || !dialog) return;
    form.reset();
    form.session_id.value = session.id;
    form.session_item_id.value = item.id;
    form.pending_table_id.value = "";
    form.quick_checkout.value = "0";
    form.quantity.required = true;
    applyConsumptionRoleRestrictions(form);
    state.consumptionDrafts = [];
    state.consumptionDraftEditIndex = -1;
    renderConsumptionSelection();
    if ($("#tableSessionActions")) $("#tableSessionActions").hidden = true;
    if ($("#tableConsumptionPreview")) $("#tableConsumptionPreview").hidden = true;
    if ($("#consumptionQueueButton")) $("#consumptionQueueButton").hidden = true;
    if ($("#consumptionEyebrow")) $("#consumptionEyebrow").textContent = "Consumo";
    if ($("#consumptionDialogTitle")) $("#consumptionDialogTitle").textContent = "Editar consumo";
    const submitLabel = $("#consumptionSubmitButton span");
    if (submitLabel) submitLabel.textContent = "Guardar cambios";
    form.menu_item_id.value = item.menu_item_id || "";
    form.item_name.value = item.item_name || "";
    form.payer_name.value = session.payer_name || "";
    form.quantity.value = item.quantity || 1;
    setCurrencyInputValue(form.unit_price, item.unit_price || 0);
    form.notes.value = item.notes || "";
    const optionalFields = $("#consumptionOptionalFields");
    if (optionalFields) optionalFields.open = true;
    const product = state.items.find((entry) => entry.id === item.menu_item_id);
    const productSearch = $("#consumptionProductSearch");
    if (productSearch) productSearch.value = product ? `${inventoryFor(product).code} · ${product.name}` : "";
    renderConsumptionProductOptions(product?.name || "");
    closeConsumptionProductOptions();
    dialog.showModal();
    refreshIcons();
  };

  const deleteConsumption = async (sessionId, itemId) => {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    const item = session?.session_items?.find((entry) => entry.id === itemId && entry.status !== "cancelled");
    if (!session || !item) return;
    if (!await askForConfirmation({
      eyebrow: "Cuenta abierta",
      title: `¿Quitar ${item.item_name}?`,
      message: "El producto se retirará de esta cuenta. El inventario no cambia porque todavía no se ha cobrado.",
      accept: "Sí, quitar producto",
      cancel: "Conservar producto"
    })) return;
    const originalSession = session;
    state.sessions = state.sessions.map((entry) => entry.id === sessionId
      ? { ...entry, session_items: (entry.session_items || []).map((line) => line.id === itemId ? { ...line, status: "cancelled", updated_at: new Date().toISOString() } : line) }
      : entry);
    state.accountsRenderSignature = "";
    renderAdminLive();
    if (isLocalWalkInSession(session)) {
      const updatedSession = state.sessions.find((entry) => entry.id === sessionId);
      state.optimisticSessionStates.set(sessionId, { mode: "upsert", localOnly: true, session: updatedSession });
      persistWalkInDrafts();
      toast("Consumo eliminado. El inventario permanece sin cambios.", "ok", `consumption-deleted:${itemId}`);
      return;
    }
    const saved = await retryQuiet(() => state.sb.from("session_items").update({ status: "cancelled", updated_by_user_id: state.currentUser?.id || null }).eq("id", itemId).select("*").single(), 4);
    if (!saved) {
      state.sessions = state.sessions.map((entry) => entry.id === sessionId ? originalSession : entry);
      state.accountsRenderSignature = "";
      renderAdminLive();
      toast("No se pudo eliminar el consumo. La cuenta fue restaurada.", "error", `delete-consumption:${itemId}`);
      return;
    }
    toast("Consumo eliminado. El inventario permanece sin cambios.", "ok", `consumption-deleted:${itemId}`);
  };

  const showStockWarning = ({ item, current, change, remaining, minimum, insufficient = false }) => {
    const dialog = $("#stockWarningDialog");
    if (!dialog) return Promise.resolve(!insufficient);
    const productName = item?.name || "Producto";
    $("#stockWarningTitle").textContent = insufficient ? "Existencias insuficientes" : "Stock bajo";
    $("#stockWarningMessage").textContent = insufficient
      ? `${productName} necesita ${change} unidad${change === 1 ? "" : "es"} adicionales, pero solo quedan ${current}. No se agregara el consumo.`
      : `${productName} quedara en ${remaining} unidad${remaining === 1 ? "" : "es"}, igual o por debajo del minimo configurado de ${minimum}.`;
    $("#stockWarningCurrent").textContent = current.toLocaleString("es-CO", { maximumFractionDigits: 2 });
    $("#stockWarningRequested").textContent = change.toLocaleString("es-CO", { maximumFractionDigits: 2 });
    $("#stockWarningRemaining").textContent = Math.max(0, remaining).toLocaleString("es-CO", { maximumFractionDigits: 2 });
    const cancel = $("#stockWarningCancel");
    const confirm = $("#stockWarningConfirm");
    cancel.textContent = insufficient ? "Entendido" : "Cancelar";
    confirm.hidden = insufficient;
    dialog.returnValue = "";
    dialog.showModal();
    refreshIcons();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(!insufficient && dialog.returnValue === "confirm"), { once: true });
    });
  };

  const addManualConsumption = async (form, { keepOpen = false, silent = false, openPaymentAfter = form.quick_checkout.value === "1" } = {}) => {
    let sessionId = form.session_id.value;
    let session = state.sessions.find((entry) => entry.id === sessionId);
    const pendingTableId = form.pending_table_id.value;
    const selectedItem = state.items.find((item) => item.id === form.menu_item_id.value);
    const name = form.item_name.value.trim() || selectedItem?.name;
    const price = form.unit_price.value.trim() ? currencyInputNumber(form.unit_price) : Number(selectedItem?.price || 0);
    const quantityText = String(form.quantity.value || "").trim();
    const quantity = Number(quantityText);
    const itemId = form.session_item_id.value || "";
    const payerName = form.payer_name.value.trim();
    const previousLine = itemId ? session?.session_items?.find((item) => item.id === itemId) : null;
    if (!name) {
      toast("El consumo necesita nombre o producto.", "error");
      return;
    }
    if (!quantityText || !Number.isInteger(quantity) || quantity < 1 || quantity > 100 || !Number.isFinite(price) || price < 0) {
      toast("Revisa cantidad y precio antes de guardar.", "error", "invalid-consumption-values");
      form.quantity.focus({ preventScroll: true });
      return;
    }
    if (!session && !pendingTableId) return;
    if (!session && pendingTableId) {
      const table = state.tables.find((entry) => String(entry.id) === String(pendingTableId) && entry.is_active !== false);
      session = await ensureAdminTableSession(table);
      if (!session) {
        toast("No fue posible abrir la cuenta de la mesa. No se descontó inventario.", "error", `open-table-failed:${pendingTableId}`);
        return;
      }
      sessionId = session.id;
      form.session_id.value = sessionId;
      form.pending_table_id.value = "";
    }
    const payload = {
      session_id: sessionId,
      table_id: session.table_id,
      menu_item_id: selectedItem?.id || null,
      item_name: name,
      unit_price: price,
      quantity,
      notes: form.notes.value.trim(),
      status: "served",
      created_by_user_id: itemId ? undefined : state.currentUser?.id || null,
      updated_by_user_id: state.currentUser?.id || null
    };
    const temporaryId = itemId || `local-${uid()}`;
    const optimisticItem = {
      ...payload,
      id: temporaryId,
      created_by_user: previousLine?.created_by_user || state.currentUser,
      created_at: previousLine?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    let optimisticSession = session;
    state.sessions = state.sessions.map((entry) => entry.id === sessionId
      ? (optimisticSession = {
          ...entry,
          payer_name: payerName || entry.payer_name,
          assigned_waiter_id: state.currentUser?.id || entry.assigned_waiter_id,
          assigned_waiter: state.currentUser || entry.assigned_waiter,
          session_items: itemId
            ? (entry.session_items || []).map((item) => item.id === itemId ? { ...item, ...optimisticItem } : item)
            : [...(entry.session_items || []), optimisticItem]
        })
      : entry);
    state.optimisticSessionStates.set(sessionId, {
      mode: "upsert",
      session: optimisticSession,
      expectedItem: optimisticItem,
      expectedSession: {
        payer_name: optimisticSession.payer_name || "",
        assigned_waiter_id: optimisticSession.assigned_waiter_id || ""
      }
    });
    if (!keepOpen) $("#consumptionDialog")?.close();
    renderAdminLive();
    if (isLocalWalkInSession(session)) {
      state.optimisticSessionStates.set(sessionId, {
        mode: "upsert",
        localOnly: true,
        session: optimisticSession
      });
      persistWalkInDrafts();
      if (!silent) toast(itemId ? "Consumo actualizado." : "Producto agregado a la venta individual.", "ok", `walk-in-consumption:${temporaryId}`);
      if (openPaymentAfter) openPaymentDialog(sessionId);
      return { sessionId, item: optimisticItem };
    }
    const sessionSaved = await retryQuiet(
        () => state.sb.from("table_sessions").update({
          payer_name: payerName || session.payer_name || "",
          assigned_waiter_id: state.currentUser?.id || session.assigned_waiter_id || null
        }).eq("id", sessionId).select("*").single(),
        4
    );
    const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
    const saved = await retryQuiet(
        () => itemId
          ? state.sb.from("session_items").update(cleanPayload).eq("id", itemId).select("*").single()
          : state.sb.from("session_items").insert(cleanPayload).select("*").single(),
        4
    );
    if (!saved) {
      state.optimisticSessionStates.delete(sessionId);
      state.sessions = state.sessions.map((entry) => entry.id === sessionId ? session : entry);
      renderAdmin();
      toast("No se pudo guardar el consumo. La cuenta fue restaurada y el inventario no cambio.", "error", `consumption-failed:${temporaryId}`);
      return null;
    }
    let confirmedSession = null;
    state.sessions = state.sessions.map((entry) => entry.id === sessionId
        ? (confirmedSession = {
            ...entry,
            ...(sessionSaved || {}),
            assigned_waiter: state.currentUser || entry.assigned_waiter,
            session_items: (entry.session_items || []).map((item) => item.id === temporaryId
              ? { ...saved, created_by_user: item.created_by_user || state.currentUser }
              : item)
          })
      : entry);
    state.optimisticSessionStates.set(sessionId, {
      mode: "upsert",
      session: confirmedSession,
      expectedItem: saved,
      expectedSession: sessionSaved ? {
        payer_name: sessionSaved.payer_name || "",
        assigned_waiter_id: sessionSaved.assigned_waiter_id || ""
      } : null
    });
    if (!silent) toast(itemId ? "Consumo actualizado." : "Producto agregado a la cuenta.", "ok", `consumption-saved:${saved.id}`);
    if (openPaymentAfter) openPaymentDialog(sessionId);
    return { sessionId, item: saved };
  };

  const copyQr = async (code) => {
    const url = clientUrlForCode(code);
    try {
      await navigator.clipboard.writeText(url);
      toast("Enlace de QR copiado.");
    } catch (error) {
      toast("No fue posible copiar el enlace del QR en este navegador.", "error", "qr-copy-failed");
    }
  };

  const downloadFromUrl = async (url, filename) => {
    try {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) throw new Error("No se pudo descargar el archivo.");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast("Abrimos el QR en una pestaña para guardarlo.", "ok");
    }
  };

  const pdfSafeText = (value = "") => String(value)
    .replace(/[Ⓡⓡ]/g, "®")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

  const pdfAccentColor = () => {
    const value = String(state.business?.accent_color || "#f05a28").trim();
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return [240, 90, 40];
    return [
      parseInt(match[1].slice(0, 2), 16),
      parseInt(match[1].slice(2, 4), 16),
      parseInt(match[1].slice(4, 6), 16)
    ];
  };

  const fitPdfText = (pdf, text, maxWidth, maxFontSize, minFontSize = 6) => {
    let fontSize = maxFontSize;
    pdf.setFontSize(fontSize);
    while (fontSize > minFontSize && pdf.getTextWidth(text) > maxWidth) {
      fontSize -= 0.5;
      pdf.setFontSize(fontSize);
    }
    return fontSize;
  };

  const drawQrCutMarks = (pdf, x, y, size) => {
    const mark = 2;
    const offset = 0.8;
    pdf.setDrawColor(150, 156, 166);
    pdf.setLineWidth(0.15);
    [[x, y], [x + size, y], [x, y + size], [x + size, y + size]].forEach(([cornerX, cornerY], index) => {
      const horizontalDirection = index % 2 === 0 ? -1 : 1;
      const verticalDirection = index < 2 ? -1 : 1;
      pdf.line(cornerX + horizontalDirection * offset, cornerY, cornerX + horizontalDirection * (offset + mark), cornerY);
      pdf.line(cornerX, cornerY + verticalDirection * offset, cornerX, cornerY + verticalDirection * (offset + mark));
    });
  };

  const drawQrPdfCard = async (pdf, table, x, y, preparedQrDataUrl = "") => {
    const cardSize = 90;
    const [red, green, blue] = pdfAccentColor();
    const rawName = pdfSafeText(table.table_name);
    const fallbackName = `MESA ${table.table_number}`;
    const primaryName = (rawName || fallbackName).toUpperCase();
    const normalizedPrimary = primaryName.replace(/\s+/g, "");
    const normalizedFallback = fallbackName.replace(/\s+/g, "");
    const secondaryName = normalizedPrimary === normalizedFallback ? "ESCANEA EL CODIGO" : fallbackName;
    const businessName = pdfSafeText(state.business?.business_name || "Servicio a la mesa").toUpperCase();
    const qrDataUrl = preparedQrDataUrl || await cachedQrDataUrl(qrTextForTable(table), 1000);

    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(30, 35, 43);
    pdf.setLineWidth(0.25);
    pdf.roundedRect(x, y, cardSize, cardSize, 1.2, 1.2, "FD");
    pdf.setFillColor(red, green, blue);
    pdf.rect(x, y, cardSize, 1.6, "F");

    pdf.setTextColor(92, 99, 112);
    pdf.setFont("helvetica", "bold");
    fitPdfText(pdf, businessName, 76, 12.5, 8);
    pdf.text(businessName, x + cardSize / 2, y + 8.4, { align: "center" });

    pdf.setTextColor(20, 23, 29);
    fitPdfText(pdf, primaryName, 78, 17, 10);
    pdf.text(primaryName, x + cardSize / 2, y + 15.2, { align: "center" });

    pdf.setTextColor(red, green, blue);
    pdf.setFont("helvetica", "bold");
    fitPdfText(pdf, secondaryName, 72, 8.2, 6.5);
    pdf.text(secondaryName, x + cardSize / 2, y + 19.2, { align: "center" });

    pdf.addImage(qrDataUrl, "PNG", x + 15.3, y + 21.3, 59.4, 59.4, undefined, "FAST");

    pdf.setTextColor(74, 81, 92);
    pdf.setFont("helvetica", "bold");
    const footerText = "ORDENA Y SOLICITA ATENCION DESDE TU MESA";
    fitPdfText(pdf, footerText, 82, 10.5, 8.5);
    pdf.text(footerText, x + cardSize / 2, y + 86.5, { align: "center" });
    drawQrCutMarks(pdf, x, y, cardSize);
  };

  const downloadQrPdf = async (tables) => {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) {
      toast("No se pudo cargar el generador de PDF. Revisa la conexion e intenta de nuevo.", "error", "pdf-library-missing");
      return;
    }
    const printableTables = (tables || []).filter(Boolean);
    if (!printableTables.length) {
      toast("Selecciona al menos una mesa para generar el PDF.", "error", "no-qr-selection");
      return;
    }
    const downloadButton = $("#downloadSelectedQrs");
    if (downloadButton) {
      downloadButton.disabled = true;
      downloadButton.innerHTML = `${icon("loader-circle", 18)} Generando PDF...`;
      refreshIcons();
    }
    try {
      const preparedQrs = await Promise.all(printableTables.map((table) => cachedQrDataUrl(qrTextForTable(table), 1000)));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      const columns = 2;
      const rows = 3;
      const cardsPerPage = columns * rows;
      const cardSize = 90;
      const gap = 8;
      const startX = 11;
      const startY = 8;
      for (let index = 0; index < printableTables.length; index += 1) {
        if (index > 0 && index % cardsPerPage === 0) pdf.addPage("a4", "portrait");
        const pageIndex = index % cardsPerPage;
        const column = pageIndex % columns;
        const row = Math.floor(pageIndex / columns);
        await drawQrPdfCard(pdf, printableTables[index], startX + column * (cardSize + gap), startY + row * (cardSize + gap), preparedQrs[index]);
      }
      const filename = printableTables.length === 1
        ? `qr-mesa-${printableTables[0].table_number}-9x9.pdf`
        : `qr-${printableTables.length}-mesas-9x9.pdf`;
      pdf.save(filename);
      toast(`${printableTables.length} ${printableTables.length === 1 ? "QR listo" : "QR listos"} en PDF de 9 x 9 cm.`);
    } catch (error) {
      console.error(error);
      toast("No se pudo generar el PDF de los QR. Intenta de nuevo.", "error", "qr-pdf-failed");
    } finally {
      renderQrBatchControls();
    }
  };

  const downloadQr = async (id) => {
    const table = state.tables.find((entry) => String(entry.id) === String(id));
    if (table) await downloadQrPdf([table]);
  };

  const downloadSelectedQrs = async () => {
    const tables = normalTables().filter((table) => state.selectedTableQrIds.has(String(table.id)));
    await downloadQrPdf(tables);
  };

  const regenerateQr = async (id) => {
    const table = state.tables.find((entry) => entry.id === id);
    if (!table) return;
    if (!await askForConfirmation({
      eyebrow: "Cambiar código QR",
      title: `¿Rehacer el QR de ${tableLabel(table)}?`,
      message: "El QR que ya esté impreso dejará de funcionar y tendrás que imprimir el nuevo.",
      accept: "Sí, crear QR nuevo",
      cancel: "Conservar el actual"
    })) return;
    const nextCode = `mesa-${table.table_number}-${uid().slice(0, 8)}`;
    const saved = await db(
      state.sb
        .from("restaurant_tables")
        .update({ qr_code: nextCode, qr_image_url: null })
        .eq("id", id)
        .select("*")
        .single(),
      null
    );
    if (saved) {
      await loadCore();
      renderAdmin();
      showAdminSection("menu");
      toast("QR regenerado. Descarga el nuevo antes de imprimir.");
    }
  };

  const editTable = (id) => {
    const table = state.tables.find((entry) => entry.id === id);
    const form = $("#tableForm");
    if (!table || !form) return;
    form.table_id.value = table.id;
    form.table_number.value = table.table_number;
    form.table_name.value = table.table_name || "";
    form.is_active.checked = table.is_active;
    renderTableFormQr();
    history.replaceState(null, "", "#menu");
    showAdminSection("menu");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const editCategory = (id) => {
    const category = state.categories.find((entry) => entry.id === id);
    const form = $("#categoryForm");
    if (!category || !form) return;
    form.category_id.value = category.id;
    form.category_name.value = category.name;
    form.category_sort.value = category.sort_order || 0;
    form.category_active.checked = category.is_active;
    history.replaceState(null, "", "#menu");
    showAdminSection("menu");
  };

  const editItem = (id) => {
    const item = state.items.find((entry) => entry.id === id);
    const form = $("#itemForm");
    if (!item || !form) return;
    form.item_id.value = item.id;
    form.category_id.value = item.category_id || "";
    form.new_category.value = "";
    form.item_name.value = item.name;
    form.description.value = item.description || "";
    setCurrencyInputValue(form.price, item.price);
    form.image_url.value = item.image_url || "";
    form.is_available.checked = item.is_available;
    form.sort_order.value = item.sort_order || 0;
    history.replaceState(null, "", "#menu");
    showAdminSection("menu");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const deleteRow = async (table, id, label) => {
    const rowBeforeDelete = table === "restaurant_tables" ? state.tables.find((entry) => entry.id === id) : null;
    const quickServicePointDelete = Boolean(rowBeforeDelete && isServicePoint(rowBeforeDelete));
    if (table === "menu_items") {
      const product = state.items.find((entry) => entry.id === id);
      const unitsInOpenTables = state.sessions.reduce((sum, session) => sum + (session.session_items || [])
        .filter((entry) => entry.status !== "cancelled" && entry.menu_item_id === id)
        .reduce((lineSum, entry) => lineSum + Number(entry.quantity || 0), 0), 0);
      if (unitsInOpenTables > 0) {
        toast(`No puedes eliminar ${product?.name || "este producto"}: tiene ${unitsInOpenTables} unidad${unitsInOpenTables === 1 ? "" : "es"} en mesas abiertas.`, "error", `product-in-open-table:${id}`);
        return;
      }
      if (!await askForConfirmation({ eyebrow: "Eliminar producto", title: `¿Eliminar ${product?.name || "este producto"}?`, message: "Se retirará del menú y del inventario. Las ventas anteriores conservarán su detalle.", accept: "Sí, eliminar producto", cancel: "Conservar producto" })) return;
    } else if (!await askForConfirmation({ eyebrow: "Eliminar registro", title: `¿Eliminar ${label}?`, message: "Esta acción retirará el registro del sistema.", accept: "Sí, eliminar", cancel: "Cancelar" })) return;
    const property = {
      restaurant_tables: "tables",
      menu_categories: "categories",
      menu_items: "items"
    }[table];
    const original = property ? state[property] : null;
    if (property) state[property] = state[property].filter((entry) => entry.id !== id);
    if (property) persistBootstrapCache();
    if (quickServicePointDelete) renderServicePoints();
    else renderAdmin();
    void (async () => {
      const removed = await retryQuiet(
        () => state.sb.from(table).delete().eq("id", id).select("*").single(),
        4
      );
      if (removed) {
        if (table === "menu_items") {
          if (state.inventoryMeta[id]) {
            delete state.inventoryMeta[id];
            persistInventoryStore();
          }
          enqueueAppsScriptJob("delete_inventory", { productId: id }, `inventory-delete:${id}`);
        }
        if (table === "menu_items") resetInventoryForm();
        return;
      }
      if (property) state[property] = original;
      if (property) persistBootstrapCache();
      if (quickServicePointDelete) renderServicePoints();
      else renderAdmin();
      toast("No se pudo eliminar. Se restauro el registro.", "error", `delete-failed:${table}:${id}`);
    })();
  };

  const bindAdmin = () => {
    bindCurrencyInputs();
    $("#businessForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveBusiness(event.currentTarget);
    });
    $("#businessForm")?.addEventListener("change", async (event) => {
      if (event.target.name === "tips_enabled") {
        const previous = { ...state.tipSettings };
        if (updateTipSettingsFromForm(event.currentTarget, { toggleChanged: true })) {
          const desired = { ...state.tipSettings };
          if (await saveTipSettingsRemotely(desired)) {
            toast(desired.enabled ? `Propina voluntaria activada al ${desired.percentage}% en todos los dispositivos.` : "Propina voluntaria desactivada en todos los dispositivos.");
          } else {
            state.tipSettings = previous;
            persistTipSettings();
            renderBusinessForm();
            syncTipFeatureVisibility();
            toast("No se pudo guardar la propina. Se restauró la configuración anterior.", "error", "tip-save-failed");
          }
        }
      }
      if (event.target.name === "tip_percentage" && !event.currentTarget.tips_enabled.checked) {
        const previous = { ...state.tipSettings };
        if (updateTipSettingsFromForm(event.currentTarget) && !await saveTipSettingsRemotely({ ...state.tipSettings })) {
          state.tipSettings = previous;
          persistTipSettings();
          renderBusinessForm();
          toast("No se pudo guardar el porcentaje. Se restauró el valor anterior.", "error", "tip-percentage-save-failed");
        }
      }
    });
    $("#tipSplitPeople")?.addEventListener("input", (event) => {
      if (!event.currentTarget.value) return;
      const people = Math.min(100, Math.max(1, Number(event.currentTarget.value || 1)));
      state.tipSplitPeople = people;
      localStorage.setItem(TIP_SPLIT_STORAGE_KEY, String(people));
      renderTips();
    });
    $("#resetTips")?.addEventListener("click", resetTips);
    $("#tableForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveTable(event.currentTarget);
    });
    $("#tableForm")?.addEventListener("input", (event) => {
      if (event.target.name === "table_number") renderTableFormQr();
    });
    $("#tableForm")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches('input[name="table_number"], input[name="table_name"]')) {
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }
    });
    $("#tableManagerSearch")?.addEventListener("input", renderTableManager);
    $("#categoryForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveCategory(event.currentTarget);
    });
    $("#itemForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveItem(event.currentTarget);
    });
    $("#inventoryForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveInventoryProduct(event.currentTarget);
    });
    $("#inventoryForm")?.addEventListener("input", renderInventoryLiveCalculation);
    $("#inventoryAdjustForm")?.addEventListener("input", renderInventoryAdjustmentPreview);
    $("#inventoryAdjustForm")?.addEventListener("change", renderInventoryAdjustmentPreview);
    $("#inventoryAdjustForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveInventoryAdjustment(event.currentTarget);
    });
    $("#incomeFilterForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.incomeRangePreset !== "custom") return;
      void loadIncomeReport();
    });
    $("#incomeEditForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveIncomeEdit(event.currentTarget);
    });
    $("#deleteIncomeForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await deleteIncomeSale(event.currentTarget);
    });
    $("#moveTableForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const targetTableId = new FormData(event.currentTarget).get("target_table_id");
      await moveSessionToTable(event.currentTarget.session_id.value, targetTableId);
    });
    $("#incomeSearch")?.addEventListener("input", () => {
      clearTimeout(state.incomeSearchTimer);
      state.incomeSearchTimer = window.setTimeout(loadIncomeReport, 120);
    });
    $("#incomePaymentMethod")?.addEventListener("change", () => void loadIncomeReport());
    [$("#incomeDateFrom"), $("#incomeDateTo")].filter(Boolean).forEach((input) => input.addEventListener("change", () => {
      state.incomeRangePreset = "custom";
      markIncomeRangePreset();
    }));
    $("#inventorySearch")?.addEventListener("input", (event) => {
      state.inventorySearch = event.currentTarget.value;
      renderInventory();
    });
    $("#inventoryStatusFilter")?.addEventListener("change", (event) => {
      state.inventoryStatusFilter = event.currentTarget.value || "all";
      renderInventory();
    });
    $("#inventoryCategoryFilter")?.addEventListener("change", (event) => {
      state.inventoryCategoryFilter = event.currentTarget.value || "all";
      renderInventory();
    });
    $("#dashboardTableZoneFilter")?.addEventListener("change", (event) => {
      state.dashboardTableZoneFilter = event.currentTarget.value || "all";
      renderTables();
    });
    $("#dashboardTableSearch")?.addEventListener("input", (event) => {
      const value = event.currentTarget.value.toUpperCase();
      if (event.currentTarget.value !== value) event.currentTarget.value = value;
      state.dashboardTableSearch = value;
      renderTables();
    });
    $("#serviceTableZoneFilter")?.addEventListener("change", (event) => {
      state.serviceTableZoneFilter = event.currentTarget.value || "all";
      renderServiceTables();
    });
    $("#serviceTableSearch")?.addEventListener("input", (event) => {
      const value = event.currentTarget.value.toUpperCase();
      if (event.currentTarget.value !== value) event.currentTarget.value = value;
      state.serviceTableSearch = value;
      renderServiceTables();
    });
    $("#movementSearch")?.addEventListener("input", (event) => {
      state.movementSearch = event.currentTarget.value;
      renderInventoryMovements();
    });
    $("#movementTypeFilter")?.addEventListener("change", (event) => {
      state.movementTypeFilter = event.currentTarget.value || "all";
      renderInventoryMovements();
    });
    $("#consumptionForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await confirmConsumptionSelection(event.currentTarget);
    });
    $("#consumptionForm")?.elements.quantity?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (event.currentTarget.form?.session_item_id.value) event.currentTarget.form.requestSubmit();
      else queueConsumptionDraft();
    });
    $("#consumptionQueueButton")?.addEventListener("click", queueConsumptionDraft);
    $("#consumptionSelectionLines")?.addEventListener("dblclick", (event) => {
      const price = event.target.closest("[data-edit-consumption-price]");
      if (price) {
        editConsumptionDraftPrice(price);
        return;
      }
      const product = event.target.closest("[data-edit-consumption-product]");
      if (product) editConsumptionDraftProduct(Number(product.dataset.editConsumptionProduct));
    });
    $("#paymentForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await processPayment(event.currentTarget, event.submitter);
    });
    $("#paymentForm")?.addEventListener("change", (event) => {
      if (event.target.name === "tip_choice") updatePaymentTipChoice();
      if (event.target.name === "payment_method") {
        const mixed = event.target.value === "mixed";
        $("#mixedPaymentFields").hidden = !mixed;
        $("#cashReceivedFields").hidden = event.target.value !== "cash";
        if (mixed) updateMixedPayment("mixed_amount_one");
        if (event.target.value === "cash") updateCashChange();
      }
      if (event.target.name === "mixed_method_one" || event.target.name === "mixed_method_two") syncMixedMethods(event.target.name);
    });
    $("#paymentForm")?.addEventListener("input", (event) => {
      if (event.target.name === "tip_amount") {
        event.currentTarget.tip_choice.value = "with";
        updatePaymentTipChoice();
      }
      if (event.target.name === "mixed_amount_one" || event.target.name === "mixed_amount_two") updateMixedPayment(event.target.name);
      if (event.target.name === "cash_received") updateCashChange();
    });
    $("#paymentPrintPreview")?.addEventListener("click", () => {
      const sessionId = $("#paymentForm")?.session_id?.value || "";
      const session = state.sessions.find((entry) => entry.id === sessionId);
      if (session) printThermalReceipt(session);
    });
    $("#receiptPrintButton")?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      printLastPaidReceipt();
    });
    $("#consumptionDialog")?.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelConsumption();
    });
    $("#accountDetailDialog")?.addEventListener("cancel", (event) => {
      event.preventDefault();
      event.currentTarget.close();
    });
    $("#accountDetailDialog")?.addEventListener("close", () => {
      state.activeAccountDetailId = "";
    });
    $("#paymentDialog")?.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelPayment();
    });
    $$("dialog.modal").forEach((dialog) => dialog.addEventListener("click", (event) => {
      if (event.target !== dialog || !dialog.open) return;
      if (dialog.id === "consumptionDialog") cancelConsumption();
      else if (dialog.id === "paymentDialog") cancelPayment();
      else dialog.close("cancel");
    }));
    const productSearch = $("#consumptionProductSearch");
    productSearch?.addEventListener("input", (event) => {
      const form = event.currentTarget.form;
      if (form) {
        form.menu_item_id.value = "";
        form.item_name.value = event.currentTarget.value.trim();
      }
      renderConsumptionProductOptions(event.currentTarget.value);
      showConsumptionProductOptions();
    });
    productSearch?.addEventListener("focus", () => {
      renderConsumptionProductOptions(productSearch.value);
      showConsumptionProductOptions();
    });
    productSearch?.addEventListener("keydown", (event) => {
      const availableButtons = $$('[data-consumption-product]:not(:disabled)', $("#consumptionProductOptions"));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        showConsumptionProductOptions();
        const currentIndex = Number($("#consumptionProductCombobox")?.dataset.activeIndex ?? -1);
        setConsumptionProductActiveIndex(currentIndex < 0 ? (event.key === "ArrowDown" ? 0 : availableButtons.length - 1) : currentIndex + (event.key === "ArrowDown" ? 1 : -1));
      }
      if (event.key === "Enter" && !$("#consumptionProductOptions")?.hidden) {
        const index = Number($("#consumptionProductCombobox")?.dataset.activeIndex ?? -1);
        const selected = index >= 0 ? availableButtons[index] : (availableButtons.length === 1 ? availableButtons[0] : null);
        if (selected) {
          event.preventDefault();
          selectConsumptionProduct(selected.dataset.consumptionProduct);
        }
      }
      if (event.key === "Escape") closeConsumptionProductOptions();
    });
    $("#consumptionProductOptions")?.addEventListener("click", (event) => {
      const option = event.target.closest("[data-consumption-product]");
      if (option && !option.disabled) selectConsumptionProduct(option.dataset.consumptionProduct);
    });
    $("#userForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveUser(event.currentTarget);
    });
    $("#adminChatDock")?.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-admin-chat-form]");
      if (!form) return;
      event.preventDefault();
      const sessionId = String(form.dataset.adminChatForm || "");
      const chat = state.adminChats.get(sessionId);
      const input = form.elements.message;
      const body = input.value.trim();
      if (!body || !chat) return;
      input.value = "";
      const saved = await persistChatMessage("staff", body, { sessionId, table: chat.table });
      if (saved) broadcastChatEvent("chat-refresh", {}, sessionId);
      else toast("No se pudo enviar el mensaje. Intenta nuevamente.", "error", `chat-message-failed:${sessionId}`);
    });
    $("#adminChatDock")?.addEventListener("input", (event) => {
      const form = event.target.closest("[data-admin-chat-form]");
      if (form && event.target.name === "message") broadcastTyping("staff", form.dataset.adminChatForm);
    });
    $("#adminChatDock")?.addEventListener("keydown", (event) => {
      const minimizedChat = event.target.closest(".admin-chat-window.is-minimized");
      if (!minimizedChat || event.target.closest("button") || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      setAdminChatMinimized(minimizedChat.dataset.adminChatWindow, false);
    });
    $("#adminAiForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      askAdminAi(event.currentTarget.question.value);
      event.currentTarget.reset();
    });
    const waiterTableSearch = $("#waiterTableSearch");
    waiterTableSearch?.addEventListener("input", (event) => {
      renderWaiterTableSelect(event.currentTarget.value);
      showWaiterTableOptions();
    });
    waiterTableSearch?.addEventListener("focus", () => {
      renderWaiterTableSelect();
      showWaiterTableOptions();
    });
    waiterTableSearch?.addEventListener("click", showWaiterTableOptions);
    waiterTableSearch?.addEventListener("keydown", async (event) => {
      const combobox = $("#waiterTableCombobox");
      const buttons = $$('[data-waiter-table]', $("#waiterTableOptions"));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        showWaiterTableOptions();
        const currentIndex = Number(combobox?.dataset.activeIndex ?? -1);
        const nextIndex = currentIndex < 0
          ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
          : (event.key === "ArrowDown" ? currentIndex + 1 : currentIndex - 1);
        setWaiterTableActiveIndex(nextIndex);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selectedId = combobox?.dataset.selectedId || (buttons.length === 1 ? buttons[0].dataset.waiterTable : "");
        if (selectedId) await openWaiterTableChoice(selectedId);
        else showWaiterTableOptions();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeWaiterTableOptions();
      }
    });
    $("#waiterTableOptions")?.addEventListener("click", async (event) => {
      const option = event.target.closest("[data-waiter-table]");
      if (option) await openWaiterTableChoice(option.dataset.waiterTable);
    });
    $("#waiterTableForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selectedId = $("#waiterTableCombobox")?.dataset.selectedId;
      if (selectedId) await openWaiterTableChoice(selectedId);
      else showWaiterTableOptions();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#waiterTableCombobox")) closeWaiterTableOptions();
      if (!event.target.closest("#consumptionProductCombobox")) closeConsumptionProductOptions();
    });
    $("#logoutButton")?.addEventListener("click", logoutAdmin);

    document.addEventListener("change", async (event) => {
      if (event.target.matches("[data-outdoor-table]")) {
        if (!(state.outdoorTableDraftIds instanceof Set)) state.outdoorTableDraftIds = new Set();
        const id = String(event.target.dataset.outdoorTable || "");
        if (event.target.checked) state.outdoorTableDraftIds.add(id);
        else state.outdoorTableDraftIds.delete(id);
        state.outdoorTableDraftDirty = true;
        renderOutdoorTableConfigurator();
        return;
      }
      if (event.target.matches("[data-user-access]")) {
        await toggleUserAccess(event.target.dataset.userAccess, event.target.checked, event.target);
        return;
      }
      if (event.target.matches("[data-select-table-qr]")) {
        const id = String(event.target.dataset.selectTableQr);
        if (event.target.checked) state.selectedTableQrIds.add(id);
        else state.selectedTableQrIds.delete(id);
        event.target.closest(".table-manager-row")?.classList.toggle("is-selected", event.target.checked);
        renderQrBatchControls();
        return;
      }
      if (event.target.id === "alertFilter") {
        state.alertFilter = event.target.value || "all";
        renderAlerts();
        return;
      }
      if (event.target.matches("[data-upload]")) {
        await uploadAsset(event.target.files[0], event.target.dataset.upload);
      }
      if (event.target.name === "menu_item_id" && event.target.closest("#consumptionForm")) {
        const item = state.items.find((entry) => entry.id === event.target.value);
        const form = event.target.form;
        form.item_name.value = item?.name || "";
        setCurrencyInputValue(form.unit_price, item?.price || 0);
      }
    });

    document.addEventListener("click", async (event) => {
      const navLink = event.target.closest(".admin-sidebar nav a");
      if (navLink) {
        event.preventDefault();
        const section = navLink.getAttribute("href")?.replace("#", "") || "dashboard";
        history.replaceState(null, "", `#${section}`);
        showAdminSection(section);
        if (section === "users" && state.currentUser?.role === "admin") {
          void loadUsers().then(renderUsers);
        }
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        return;
      }

      if (event.target.closest("[data-alert-card]")) stopAlarm();

      const finishChatButton = event.target.closest("[data-finish-admin-chat]");
      if (finishChatButton) {
        await requestFinishAdminChat(finishChatButton.dataset.finishAdminChat);
        return;
      }

      const minimizedChat = event.target.closest(".admin-chat-window.is-minimized");
      if (minimizedChat) {
        setAdminChatMinimized(minimizedChat.dataset.adminChatWindow, false);
        return;
      }

      const target = event.target.closest("button");
      if (!target) return;
      if (target.id === "enableSound") {
        if (state.soundEnabled) {
          if (await confirmDisableAlarm()) disableAlarm();
        } else {
          await unlockAlarm();
        }
      }
      if (target.id === "selectAllTableQrs") {
        setAllQrSelections(true);
      }
      if (target.id === "selectOutdoorRange" || target.id === "clearOutdoorRange") {
        const fromId = $("#outdoorTableFrom")?.value || "";
        const toId = $("#outdoorTableTo")?.value || "";
        const ordered = normalTables()
          .filter((table) => table.is_active !== false)
          .sort((left, right) => Number(left.table_number || 0) - Number(right.table_number || 0));
        const fromIndex = ordered.findIndex((table) => String(table.id) === String(fromId));
        const toIndex = ordered.findIndex((table) => String(table.id) === String(toId));
        if (fromIndex >= 0 && toIndex >= 0) {
          if (!(state.outdoorTableDraftIds instanceof Set)) state.outdoorTableDraftIds = new Set();
          const first = Math.min(fromIndex, toIndex);
          const last = Math.max(fromIndex, toIndex);
          ordered.slice(first, last + 1).forEach((table) => {
            if (target.id === "selectOutdoorRange") state.outdoorTableDraftIds.add(String(table.id));
            else state.outdoorTableDraftIds.delete(String(table.id));
          });
          state.outdoorTableDraftDirty = true;
          renderOutdoorTableConfigurator();
        }
      }
      if (target.id === "clearTableQrs") {
        setAllQrSelections(false);
      }
      if (target.id === "downloadSelectedQrs") await downloadSelectedQrs();
      if (target.id === "syncAppsScriptInventory") {
        await runRefreshAction(target, async () => {
          const flushed = await flushAppsScriptOutbox();
          if (!flushed || readAppsScriptOutbox().length) return false;
          const coreRefreshed = await refreshCoreData();
          const inventoryRefreshed = await syncInventoryWithAppsScript();
          return coreRefreshed && inventoryRefreshed;
        }, "Inventario actualizado desde las fuentes oficiales.");
      }
      if (target.dataset.incomeRange) setIncomeRange(target.dataset.incomeRange);
      if (target.dataset.editIncome) openIncomeEdit(target.dataset.editIncome);
      if (target.dataset.deleteIncome) openDeleteIncomeDialog(target.dataset.deleteIncome);
      if (target.dataset.deleteMovement) await deleteInventoryMovement(target.dataset.deleteMovement);
      if (target.id === "refreshIncomeReport") {
        await runRefreshAction(target, async () => {
          const flushed = await flushAppsScriptOutbox();
          if (!flushed || readAppsScriptOutbox().length) return false;
          const filters = incomeFiltersFromForm();
          state.incomeRecoveredRanges.delete(`${filters.dateFrom}:${filters.dateTo}`);
          return loadIncomeReport();
        }, "Informe de ingresos actualizado.");
      }
      if (target.id === "loadMoreIncome") await loadMoreIncomeReport();
      if (target.id === "exportIncomeCsv") exportIncomeCsv();
      if (target.id === "newInventoryProduct") resetInventoryForm({ open: true });
      if (target.id === "cancelInventoryEdit") {
        resetInventoryForm();
        $("#inventoryDialog")?.close();
      }
      if (target.id === "refreshInventoryMovements") {
        await runRefreshAction(target, async () => {
          const flushed = await flushAppsScriptOutbox();
          if (!flushed || readAppsScriptOutbox().length) return false;
          return loadInventoryMovements();
        }, "Movimientos actualizados desde el historial oficial.");
      }
      if (target.id === "loadMoreMovements") await loadMoreInventoryMovements();
      if (target.dataset.resetSection) {
        await resetSectionData(target.dataset.resetSection);
        return;
      }
      if (target.dataset.removeConsumptionDraft !== undefined) {
        const removedIndex = Number(target.dataset.removeConsumptionDraft);
        state.consumptionDrafts.splice(removedIndex, 1);
        if (state.consumptionDraftEditIndex === removedIndex) clearConsumptionEntry($("#consumptionForm"));
        else if (state.consumptionDraftEditIndex > removedIndex) state.consumptionDraftEditIndex -= 1;
        renderConsumptionSelection();
      }
      if (target.dataset.minimizeAdminChat) setAdminChatMinimized(target.dataset.minimizeAdminChat, !state.adminChats.get(String(target.dataset.minimizeAdminChat))?.minimized);
      if (target.id === "newWalkInSale") await createWalkInSale();
      if (target.id === "addServicePoint") addServicePoint();
      if (target.dataset.serviceZone) {
        state.activeServiceZone = target.dataset.serviceZone;
        localStorage.setItem(SERVICE_ZONE_STORAGE_KEY, state.activeServiceZone);
        renderServicePoints();
      }
      if (target.id === "openCashDrawer" || target.dataset.openCashDrawer !== undefined) await openCashDrawer();
      if (target.id === "receiptPrintButton") printLastPaidReceipt();
      if (target.dataset.closeReceiptResult !== undefined) $("#receiptResultDialog")?.close();
      if (target.id === "viewTableConsumption") {
        const preview = $("#tableConsumptionPreview");
        if (preview) setTableConsumptionPreviewVisible(preview.hidden);
      }
      if (target.id === "releaseEmptyTable") {
        const sessionId = $("#consumptionForm")?.session_id.value || "";
        state.consumptionDrafts = [];
        state.consumptionDraftEditIndex = -1;
        $("#consumptionDialog")?.close();
        const released = await closeSession(sessionId);
        if (released) toast("Mesa liberada y disponible nuevamente.", "ok", `released-empty-table:${sessionId}`);
        return;
      }
      if (target.id === "chargeTableAccount") {
        if (state.consumptionDrafts.length) {
          toast("Confirma o elimina la seleccion pendiente antes de cobrar la cuenta.", "error", "pending-items-before-payment");
          return;
        }
        const sessionId = $("#consumptionForm")?.session_id.value || "";
        $("#consumptionDialog")?.close();
        openPaymentDialog(sessionId);
      }
      if (target.id === "paymentAddItem") {
        const sessionId = $("#paymentForm")?.session_id?.value || "";
        $("#paymentDialog")?.close();
        openConsumptionDialog(sessionId, { quickCheckout: true });
      }
      if (target.dataset.cancelConsumption !== undefined) cancelConsumption();
      if (target.dataset.cancelPayment !== undefined) cancelPayment();
      if (target.dataset.openTable) await openCompactTable(target.dataset.openTable);
      if (target.dataset.acceptRequest) await acceptRequest(target.dataset.acceptRequest);
      if (target.dataset.openChat) await openAdminChat(target.dataset.openChat);
      if (target.dataset.adminAiQuestion) askAdminAi(target.dataset.adminAiQuestion);
      if (target.dataset.sendBill) await sendBillToClient(target.dataset.sendBill);
      if (target.dataset.viewAccount) openAccountDetailDialog(target.dataset.viewAccount);
      if (target.dataset.closeSession) await closeSession(target.dataset.closeSession);
      if (target.dataset.moveSession) {
        target.closest("#accountDetailDialog")?.close();
        openMoveSessionDialog(target.dataset.moveSession);
      }
      if (target.dataset.chargeSession) {
        target.closest("#accountDetailDialog")?.close();
        openPaymentDialog(target.dataset.chargeSession);
      }
      if (target.dataset.printSession) {
        const session = state.sessions.find((entry) => entry.id === target.dataset.printSession);
        if (session) printThermalReceipt(session);
      }
      if (target.dataset.addManual) {
        target.closest("#accountDetailDialog")?.close();
        openConsumptionDialog(target.dataset.addManual);
      }
      if (target.dataset.editConsumption) {
        target.closest("#accountDetailDialog")?.close();
        editConsumption(target.dataset.sessionId, target.dataset.editConsumption);
      }
      if (target.dataset.deleteConsumption) await deleteConsumption(target.dataset.sessionId, target.dataset.deleteConsumption);
      if (target.dataset.removeIncomeLine !== undefined) {
        const line = target.closest("[data-income-line]");
        const lines = $$('[data-income-line]', $("#incomeEditForm"));
        if (lines.length <= 1) {
          const saleId = $("#incomeEditForm")?.sale_id.value || "";
          $("#incomeEditDialog")?.close();
          openDeleteIncomeDialog(saleId);
        }
        else line?.remove();
      }
      if (target.dataset.closeDialog !== undefined) target.closest("dialog")?.close();
      if (target.dataset.copyQr) await copyQr(target.dataset.copyQr);
      if (target.dataset.downloadQr) await downloadQr(target.dataset.downloadQr);
      if (target.dataset.regenerateQr) await regenerateQr(target.dataset.regenerateQr);
      if (target.dataset.viewSession) {
        history.replaceState(null, "", "#accounts");
        showAdminSection("accounts");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      if (target.dataset.editTable) editTable(target.dataset.editTable);
      if (target.dataset.editCategory) editCategory(target.dataset.editCategory);
      if (target.dataset.editItem) editItem(target.dataset.editItem);
      if (target.dataset.editInventory) editInventoryProduct(target.dataset.editInventory);
      if (target.dataset.inventoryAdjust) openInventoryAdjustment(target.dataset.inventoryAdjust);
      if (target.dataset.editUser) editUser(target.dataset.editUser);
      if (target.dataset.deleteUser) await deleteUser(target.dataset.deleteUser);
      if (target.dataset.deleteTable) await deleteRow("restaurant_tables", target.dataset.deleteTable, "esta mesa");
      if (target.dataset.deleteServicePoint) {
        const hasOpenAccount = state.sessions.some((session) => String(session.table_id) === String(target.dataset.deleteServicePoint) && session.status === "open");
        if (hasOpenAccount) toast("Cobra o mueve la cuenta antes de eliminar este puesto.", "error", `service-point-open:${target.dataset.deleteServicePoint}`);
        else await deleteRow("restaurant_tables", target.dataset.deleteServicePoint, "este puesto");
      }
      if (target.dataset.deleteCategory) await deleteRow("menu_categories", target.dataset.deleteCategory, "esta categoria");
      if (target.dataset.deleteItem) await deleteRow("menu_items", target.dataset.deleteItem, "este producto");
    });

    window.addEventListener("hashchange", () => {
      showAdminSection(location.hash.replace("#", "") || "dashboard");
    });
  };

  const subscribeAdmin = () => {
    const channel = state.sb
      .channel("admin", { config: { broadcast: { self: false }, private: false } })
      .on("broadcast", { event: "refresh" }, refreshAdminNow)
      .on("postgres_changes", { event: "*", schema: "public", table: "service_requests" }, refreshAdminNow)
      .on("postgres_changes", { event: "*", schema: "public", table: "table_sessions" }, refreshAdminNow)
      .on("postgres_changes", { event: "*", schema: "public", table: "session_items" }, refreshAdminNow)
      .on("postgres_changes", { event: "*", schema: "public", table: "business_settings" }, refreshCoreData)
      .on("postgres_changes", { event: "*", schema: "public", table: "restaurant_tables" }, refreshCoreData)
      .on("postgres_changes", { event: "*", schema: "public", table: "menu_categories" }, refreshCoreData)
      .on("postgres_changes", { event: "*", schema: "public", table: "menu_items" }, refreshCoreData)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeStatus("En vivo", "live");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setRealtimeStatus("Respaldo cada 5 segundos", "fallback");
        }
      });
    state.subscriptions.push(channel);
  };

  const tableFromScannedValue = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    let code = raw;
    try {
      const url = new URL(raw);
      code = url.searchParams.get("mesa") || url.searchParams.get("table") || url.searchParams.get("t") || raw;
    } catch (error) { /* El lector puede entregar solo el codigo. */ }
    return state.tables.find((table) =>
      String(table.id) === code ||
      String(table.table_number) === code ||
      String(table.qr_code || "").toLowerCase() === code.toLowerCase()
    ) || null;
  };

  const ensureAdminTableSession = async (table) => {
    if (!table) return null;
    let session = state.sessions.find((entry) => String(entry.table_id) === String(table.id) && entry.status === "open");
    if (!session) {
      session = await dbQuiet(
        state.sb.from("table_sessions").select("*, session_items(*)")
          .eq("table_id", table.id).eq("status", "open")
          .order("opened_at", { ascending: false }).limit(1).maybeSingle(),
        null
      );
    }
    if (!session) {
      session = await dbQuiet(
        state.sb.from("table_sessions").insert({
          table_id: table.id,
          status: "open",
          sale_channel: "table",
          assigned_waiter_id: state.currentUser?.id || null
        }).select("*").single(),
        null
      );
      if (!session) {
        session = await dbQuiet(
          state.sb.from("table_sessions").select("*, session_items(*)")
            .eq("table_id", table.id).eq("status", "open")
            .order("opened_at", { ascending: false }).limit(1).maybeSingle(),
          null
        );
      }
    }
    if (!session) return null;
    session = {
      ...session,
      restaurant_tables: table,
      assigned_waiter: state.currentUser || session.assigned_waiter,
      session_items: session.session_items || []
    };
    state.sessions = [session, ...state.sessions.filter((entry) => entry.id !== session.id)];
    state.accountsRenderSignature = "";
    renderAdminLive();
    return session;
  };

  const openScannedTable = async (value) => {
    let table = tableFromScannedValue(value);
    if (!table) {
      await loadCore();
      table = tableFromScannedValue(value);
    }
    if (!table) {
      toast("No se encontro la mesa seleccionada. Actualiza la pagina e intenta de nuevo.", "error", "unknown-service-table");
      return;
    }
    let session = state.sessions.find((entry) => entry.table_id === table.id && entry.status === "open");
    if (session) {
      session = {
        ...session,
        restaurant_tables: table,
        assigned_waiter: state.currentUser,
        session_items: session.session_items || []
      };
      state.sessions = [session, ...state.sessions.filter((entry) => entry.id !== session.id)];
    }
    openConsumptionDialog(session?.id || "", { pendingTableId: session ? "" : table.id });
  };

  const stopQrCamera = () => {
    state.qrCameraStream?.getTracks?.().forEach((track) => track.stop());
    state.qrCameraStream = null;
    const video = $("#qrCamera");
    if (video) {
      video.hidden = true;
      video.srcObject = null;
    }
  };

  const startQrCamera = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      toast("La camara necesita abrirse desde una pagina HTTPS segura.", "error", "qr-camera-insecure");
      return;
    }
    stopQrCamera();
    const video = $("#qrCamera");
    if (!video) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      state.qrCameraStream = stream;
      video.srcObject = stream;
      video.hidden = false;
      await video.play();

      let detector = null;
      if ("BarcodeDetector" in window) {
        try {
          const supported = typeof BarcodeDetector.getSupportedFormats === "function"
            ? await BarcodeDetector.getSupportedFormats()
            : ["qr_code"];
          if (supported.includes("qr_code")) detector = new BarcodeDetector({ formats: ["qr_code"] });
        } catch (error) { /* Safari y algunos WebViews exponen una implementacion incompleta. */ }
      }

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!detector && (typeof window.jsQR !== "function" || !context)) {
        stopQrCamera();
        toast("No se pudo cargar el lector QR. Recarga la pagina e intenta de nuevo.", "error", "qr-reader-unavailable");
        return;
      }

      const scan = async () => {
        if (!state.qrCameraStream) return;
        let value = "";
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
          if (detector) {
            try {
              const codes = await detector.detect(video);
              value = codes[0]?.rawValue || "";
            } catch (error) {
              detector = null;
            }
          }
          // Algunos móviles exponen BarcodeDetector pero no decodifican video correctamente.
          if (!value && typeof window.jsQR === "function" && context) {
            const scale = Math.min(1, 720 / video.videoWidth);
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = context.getImageData(0, 0, canvas.width, canvas.height);
            value = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" })?.data || "";
          }
        }
        if (value) {
          stopQrCamera();
          await openScannedTable(value);
          return;
        }
        window.requestAnimationFrame(scan);
      };
      scan();
    } catch (error) {
      stopQrCamera();
      const errorName = String(error?.name || "");
      const message = errorName === "NotAllowedError" || errorName === "SecurityError"
        ? "Permiso de camara bloqueado. Habilitalo en la configuracion del sitio y vuelve a intentar."
        : errorName === "NotFoundError" || errorName === "OverconstrainedError"
          ? "No se encontro una camara disponible en este dispositivo."
          : errorName === "NotReadableError" || errorName === "AbortError"
            ? "La camara esta siendo usada por otra aplicacion. Cierrala y vuelve a intentar."
            : "No se pudo iniciar la camara. Recarga la pagina y vuelve a intentar.";
      toast(message, "error", `qr-camera-${errorName || "failed"}`);
    }
  };

  const setQrScanStatus = (message, tone = "scanning") => {
    const status = $("#qrScanStatus");
    if (!status) return;
    status.hidden = !message;
    status.className = `qr-scan-status ${tone}`;
    status.textContent = message;
  };

  const stopPowerfulQrCamera = async (keepStatus = false) => {
    const controls = state.qrScannerControls;
    state.qrScannerControls = null;
    try { controls?.stop?.(); } catch (error) { /* El stream pudo cerrarse antes. */ }
    const scanner = state.qrScanner;
    state.qrScanner = null;
    try { scanner?.reset?.(); } catch (error) { /* Limpieza opcional de ZXing. */ }
    stopQrCamera();
    const reader = $("#qrReader");
    if (reader) {
      reader.hidden = true;
      reader.innerHTML = "";
    }
    const choice = $("#qrCameraChoice");
    if (choice) choice.hidden = true;
    if (!keepStatus) setQrScanStatus("");
  };

  const handleDecodedQr = async (decodedText) => {
    const value = String(decodedText || "").trim();
    if (!value || state.qrScanBusy) return;
    state.qrScanBusy = true;
    const input = $("#waiterQrForm [name='qr_value']");
    if (input) input.value = value;
    setQrScanStatus("QR detectado. Abriendo la mesa...", "detected");
    try {
      await stopPowerfulQrCamera(true);
      await openScannedTable(value);
    } finally {
      state.qrScanBusy = false;
    }
  };

  const qrCameraErrorMessage = (error) => {
    const detail = `${error?.name || ""} ${error?.message || error || ""}`.toLowerCase();
    if (/notallowed|permission|denied|security/.test(detail)) {
      return "Permiso de camara bloqueado. Habilitalo para este sitio y vuelve a intentar.";
    }
    if (/notfound|devicesnotfound|overconstrained/.test(detail)) {
      return "No se encontro una camara trasera disponible.";
    }
    if (/notreadable|trackstarterror|ocupada|in use/.test(detail)) {
      return "La camara esta ocupada por otra aplicacion. Cierrala y vuelve a intentar.";
    }
    return "No se pudo iniciar el lector. Prueba con Leer foto QR.";
  };

  const cameraName = (device, index) => device.label?.trim() || `Camara ${index + 1}`;

  const cameraScore = (device) => {
    const label = String(device?.label || "").toLowerCase();
    let score = 0;
    if (/back|rear|environment|trasera|posterior|traseira/.test(label)) score += 100;
    if (/front|user|frontal/.test(label)) score -= 200;
    if (/ultra|tele|macro|depth|0[.,]5|2x|3x/.test(label)) score -= 70;
    if (/\b1x\b|back camera$|rear camera$|camara trasera$|cámara trasera$/.test(label)) score += 40;
    return score;
  };

  const populateQrCameraSelect = (devices, selectedId) => {
    state.qrCameraDevices = devices || [];
    const select = $("#qrCameraSelect");
    const choice = $("#qrCameraChoice");
    if (!select || !choice) return;
    select.innerHTML = state.qrCameraDevices.map((device, index) =>
      `<option value="${escapeHTML(device.deviceId)}">${escapeHTML(cameraName(device, index))}</option>`
    ).join("");
    if (selectedId && state.qrCameraDevices.some((device) => device.deviceId === selectedId)) {
      select.value = selectedId;
    }
    choice.hidden = state.qrCameraDevices.length < 2;
  };

  const improveQrCameraFocus = async () => {
    const track = $("#qrCamera")?.srcObject?.getVideoTracks?.()[0];
    if (!track?.applyConstraints || !track?.getCapabilities) return;
    try {
      const capabilities = track.getCapabilities();
      const advanced = [];
      if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      }
      if (advanced.length) await track.applyConstraints({ advanced });
    } catch (error) { /* No todos los Safari aceptan restricciones avanzadas. */ }
  };

  const startPowerfulQrCamera = async (preferredDeviceId = "") => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      toast("La camara requiere abrir el panel desde HTTPS.", "error", "qr-camera-insecure");
      return;
    }
    if (typeof window.ZXingBrowser?.BrowserQRCodeReader !== "function") {
      toast("El motor ZXing no cargo. Recarga la pagina con conexion a internet.", "error", "qr-library-missing");
      return;
    }
    await stopPowerfulQrCamera();
    state.qrScanBusy = false;
    const video = $("#qrCamera");
    if (!video) return;
    video.hidden = false;
    setQrScanStatus("Solicitando la camara trasera...", "scanning");
    try {
      let cameras = [];
      try {
        cameras = await window.ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
      } catch (error) { /* Algunos Safari no enumeran dispositivos antes de autorizar. */ }
      const ranked = [...cameras].sort((a, b) => cameraScore(b) - cameraScore(a));
      const labelsAvailable = cameras.some((entry) => String(entry.label || "").trim());
      let selectedId = preferredDeviceId && cameras.some((entry) => entry.deviceId === preferredDeviceId)
        ? preferredDeviceId
        : labelsAvailable ? ranked[0]?.deviceId : "";
      populateQrCameraSelect(cameras, selectedId);
      const scanner = new window.ZXingBrowser.BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 70,
        delayBetweenScanSuccess: 500,
        tryPlayVideoTimeout: 5000
      });
      state.qrScanner = scanner;
      const videoConstraints = selectedId
        ? { deviceId: { exact: selectedId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      const controls = await scanner.decodeFromConstraints({ video: videoConstraints, audio: false }, video, (result, error) => {
        if (result) void handleDecodedQr(result.getText?.() || result.text || String(result));
        // NotFoundException es normal: ZXing la emite en cada cuadro sin codigo.
        if (error && !/notfoundexception/i.test(String(error?.name || error))) {
          console.debug("QR frame:", error);
        }
      });
      state.qrScannerControls = controls;
      state.qrCameraStream = video.srcObject;
      await improveQrCameraFocus();
      selectedId = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId || selectedId;

      // Los nombres completos aparecen despues de conceder permiso en varios moviles.
      try {
        cameras = await window.ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
        populateQrCameraSelect(cameras, selectedId);
      } catch (error) { /* El lector ya funciona aunque el navegador oculte la lista. */ }
      setQrScanStatus("Lector ZXing activo. Acerca el QR hasta que se vea nitido; si no enfoca, cambia la camara.", "scanning");
    } catch (error) {
      await stopPowerfulQrCamera();
      const message = qrCameraErrorMessage(error);
      setQrScanStatus(message, "error");
      toast(message, "error", "qr-advanced-camera-failed");
    }
  };

  const scanQrImage = async (file) => {
    if (typeof window.ZXingBrowser?.BrowserQRCodeReader !== "function") {
      toast("El motor ZXing no cargo. Recarga la pagina.", "error", "qr-library-missing-file");
      return;
    }
    await stopPowerfulQrCamera();
    setQrScanStatus("Analizando la imagen...", "scanning");
    const imageUrl = URL.createObjectURL(file);
    try {
      const scanner = new window.ZXingBrowser.BrowserQRCodeReader();
      const result = await scanner.decodeFromImageUrl(imageUrl);
      await handleDecodedQr(result.getText?.() || result.text || String(result));
    } catch (error) {
      await stopPowerfulQrCamera();
      const message = "No se encontro un QR legible en la imagen. Acercate y evita reflejos.";
      setQrScanStatus(message, "error");
      toast(message, "error", "qr-image-not-readable");
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  };

  const applyCurrentUser = () => {
    document.body.dataset.userRole = state.currentUser?.role || "";
    const displayName = state.currentUser?.full_name || "Sin sesión";
    $("#currentUserName") && ($("#currentUserName").textContent = displayName);
    $("#currentUserRole") && ($("#currentUserRole").textContent = state.currentUser?.role === "admin" ? "Administrador" : "Mesero");
    $("#currentUserInitials") && ($("#currentUserInitials").textContent = state.currentUser
      ? displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase()
      : "TN");
    document.body.classList.toggle("admin-authenticated", Boolean(state.currentUser));
  };

  const ADMIN_USER_CACHE_KEY = "la_licorera_17_admin_user_v1";

  const waitForAdminLogin = async () => {
    const storedToken = localStorage.getItem("la_licorera_17_admin_token") || "";
    let cachedUser = null;
    try { cachedUser = JSON.parse(localStorage.getItem(ADMIN_USER_CACHE_KEY) || "null"); } catch (error) { /* cache opcional */ }
    if (storedToken && cachedUser?.id) {
      state.authToken = storedToken;
      state.currentUser = cachedUser;
      state.sb.setAuthToken(storedToken);
      applyCurrentUser();
      void state.sb.rpc("getCurrentUser", { auth_token: storedToken }).then(({ data, error }) => {
        if (data) {
          state.currentUser = data;
          localStorage.setItem(ADMIN_USER_CACHE_KEY, JSON.stringify(data));
          applyCurrentUser();
          return;
        }
        if (error && /sesion vencida|autenticacion requerida|usuario inactivo/i.test(String(error.message || ""))) {
          localStorage.removeItem("la_licorera_17_admin_token");
          localStorage.removeItem(ADMIN_USER_CACHE_KEY);
          location.reload();
        }
      }).catch(() => undefined);
      return true;
    }
    if (storedToken) {
      const user = await dbQuiet(state.sb.rpc("getCurrentUser", { auth_token: storedToken }), null);
      if (user) {
        state.authToken = storedToken;
        state.currentUser = user;
        state.sb.setAuthToken(storedToken);
        localStorage.setItem(ADMIN_USER_CACHE_KEY, JSON.stringify(user));
        applyCurrentUser();
        return true;
      }
      localStorage.removeItem("la_licorera_17_admin_token");
      localStorage.removeItem(ADMIN_USER_CACHE_KEY);
    }

    setLoading(false);
    applyCurrentUser();
    refreshIcons();
    const form = $("#loginForm");
    const errorBox = $("#loginError");
    const regularCredentials = $("#loginCredentials");
    const initialCredentials = $("#initialAdminCredentials");
    const intro = $("#loginIntro");
    const submitButton = $("#loginSubmit");
    let initialSetup = false;
    const setInitialSetupMode = (enabled) => {
      initialSetup = Boolean(enabled);
      if (regularCredentials) regularCredentials.hidden = initialSetup;
      if (initialCredentials) initialCredentials.hidden = !initialSetup;
      $$("input", regularCredentials || document).forEach((input) => { input.disabled = initialSetup; });
      $$("input", initialCredentials || document).forEach((input) => { input.disabled = !initialSetup; });
      if (intro) intro.textContent = initialSetup
        ? "Crea el primer administrador para activar esta instalación."
        : "Ingresa con tu usuario y PIN personal.";
      if (submitButton) submitButton.innerHTML = initialSetup
        ? `${icon("user-plus", 18)} Crear administrador`
        : `${icon("log-in", 18)} Entrar`;
      refreshIcons();
    };
    const setupStatus = await dbQuiet(state.sb.rpc("getInitialSetupStatus"), null);
    setInitialSetupMode(Boolean(setupStatus?.needs_initial_admin));
    return new Promise((resolve) => {
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = submitButton || form.querySelector("[type='submit']");
        if (button) button.disabled = true;
        if (errorBox) errorBox.textContent = "";
        const username = initialSetup ? form.initialUsername.value.trim() : form.username.value.trim();
        const pin = initialSetup ? form.initialPin.value : form.pin.value;
        if (initialSetup) {
          const created = await dbQuiet(state.sb.rpc("bootstrapFirstAdmin", {
            full_name: form.initialFullName.value.trim(),
            username,
            pin
          }), null);
          if (!created?.id) {
            if (errorBox) errorBox.textContent = "No fue posible crear el administrador. Revisa los datos e intenta nuevamente.";
            if (button) button.disabled = false;
            return;
          }
          setInitialSetupMode(false);
        }
        const session = await dbQuiet(state.sb.rpc("login", {
          username,
          pin
        }), null);
        if (!session?.token || !session?.user) {
          if (errorBox) errorBox.textContent = "Usuario o PIN incorrectos.";
          if (button) button.disabled = false;
          return;
        }
        state.authToken = session.token;
        state.currentUser = session.user;
        state.sb.setAuthToken(session.token);
        localStorage.setItem("la_licorera_17_admin_token", session.token);
        localStorage.setItem(ADMIN_USER_CACHE_KEY, JSON.stringify(session.user));
        applyCurrentUser();
        setLoading(true);
        resolve(true);
      });
    });
  };

  const sortUsers = (users) => [...users].sort((left, right) => {
    const roleOrder = (left.role === "admin" ? 0 : 1) - (right.role === "admin" ? 0 : 1);
    return roleOrder || String(left.full_name || "").localeCompare(String(right.full_name || ""), "es");
  });

  const mergeUsers = (...collections) => {
    const usersById = new Map();
    collections.flat().filter((user) => user?.id).forEach((user) => usersById.set(String(user.id), user));
    return sortUsers([...usersById.values()]);
  };

  const persistUsersCache = () => {
    try {
      localStorage.setItem(USER_LIST_CACHE_KEY, JSON.stringify(state.users));
    } catch (error) { /* La lista remota sigue siendo la fuente principal. */ }
  };

  const loadUsers = async () => {
    const cachedUsers = readLocalJson(USER_LIST_CACHE_KEY, []);
    const fallbackUsers = mergeUsers(Array.isArray(cachedUsers) ? cachedUsers : [], state.users, state.currentUser ? [state.currentUser] : []);
    if (state.currentUser?.role !== "admin") {
      state.users = mergeUsers(state.currentUser ? [state.currentUser] : []);
      return;
    }
    state.users = fallbackUsers;
    renderUsers();
    let remoteUsers = [];
    try {
      const { data, error } = await state.sb.rpc("listUsers", { auth_token: state.authToken });
      if (error) throw error;
      remoteUsers = Array.isArray(data) ? data : Array.isArray(data?.users) ? data.users : [];
    } catch (error) {
      remoteUsers = [];
    }
    state.users = remoteUsers.length
      ? mergeUsers(state.currentUser ? [state.currentUser] : [], remoteUsers)
      : fallbackUsers;
    if (remoteUsers.length) persistUsersCache();
  };

  const renderUsers = () => {
    const list = $("#usersList");
    if (!list) return;
    const renderSignature = JSON.stringify(state.users.map((user) => [user.id, user.full_name, user.username, user.role, user.is_active]));
    if (renderSignature === state.usersRenderSignature) return;
    state.usersRenderSignature = renderSignature;
    const badge = $("#usersCountBadge");
    if (badge) badge.innerHTML = `${icon("users-round", 16)} ${state.users.length} ${state.users.length === 1 ? "usuario" : "usuarios"}`;
    list.innerHTML = state.users.length
      ? state.users.map((user) => `
          <article class="user-card ${user.is_active === false ? "is-disabled" : ""}">
            <div class="user-avatar">${icon(user.role === "admin" ? "shield-check" : "user-round", 20)}</div>
            <div class="user-card-copy">
              <div class="user-card-name"><strong>${escapeHTML(user.full_name)}</strong>${String(user.id) === String(state.currentUser?.id) ? '<span class="current-user-badge">Sesión actual</span>' : ""}</div>
              <span>@${escapeHTML(user.username)}</span>
              <div class="user-card-badges"><em>${user.role === "admin" ? "Administrador" : "Mesero"}</em><em class="${user.is_active === false ? "is-off" : "is-on"}">${user.is_active === false ? "Sin acceso" : "Acceso activo"}</em></div>
            </div>
            <label class="user-access-switch" title="${user.is_active === false ? "Dar acceso" : "Quitar acceso"}">
              <span>Acceso</span>
              <input type="checkbox" data-user-access="${user.id}" ${user.is_active === false ? "" : "checked"} aria-label="${user.is_active === false ? "Dar acceso" : "Quitar acceso"} a ${escapeHTML(user.full_name)}">
              <span class="user-access-track" aria-hidden="true"></span>
            </label>
            <div class="row-actions user-row-actions"><button class="icon-btn" data-edit-user="${user.id}" title="Editar" aria-label="Editar usuario">${icon("pencil", 16)}</button><button class="icon-btn danger" data-delete-user="${user.id}" title="Eliminar" aria-label="Eliminar usuario">${icon("trash-2", 16)}</button></div>
          </article>`).join("")
      : emptyState("Sin usuarios", "Crea el equipo operativo.", "users");
    refreshIcons();
  };

  const resetUserFormPresentation = (form = $("#userForm")) => {
    if (!form) return;
    if ($("#userFormEyebrow")) $("#userFormEyebrow").textContent = "Nuevo acceso";
    if ($("#userFormTitle")) $("#userFormTitle").textContent = "Agregar integrante";
    const label = form.querySelector('.user-save-button span');
    if (label) label.textContent = "Guardar usuario";
  };

  const toggleUserAccess = async (id, nextActive, control) => {
    const user = state.users.find((entry) => String(entry.id) === String(id));
    if (!user || (user.is_active !== false) === nextActive) return;
    if (String(user.id) === String(state.currentUser?.id) && !nextActive) {
      if (control) control.checked = true;
      toast("No puedes quitar tu propio acceso mientras esta sesión está abierta.", "error", "disable-current-user");
      return;
    }
    if (control) control.disabled = true;
    let saved = null;
    let saveError = null;
    try {
      const result = await state.sb.rpc("saveUser", {
        auth_token: state.authToken,
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        pin: "",
        role: user.role,
        is_active: nextActive
      });
      saved = result.data;
      saveError = result.error;
    } catch (error) {
      saveError = error;
    }
    if (saveError || !saved?.id) {
      if (control) {
        control.checked = user.is_active !== false;
        control.disabled = false;
      }
      toast(saveError?.message || "No se pudo cambiar el acceso del usuario.", "error", `user-access:${id}`);
      return;
    }
    state.users = mergeUsers(state.users.map((entry) => String(entry.id) === String(saved.id) ? saved : entry));
    persistUsersCache();
    renderUsers();
    toast(nextActive ? `Acceso habilitado para ${saved.full_name}.` : `Acceso deshabilitado para ${saved.full_name}.`, "ok", `user-access-saved:${saved.id}:${nextActive}`);
  };

  const saveUser = async (form) => {
    const isEditing = Boolean(form.user_id.value);
    const fullName = form.full_name.value.trim();
    const username = form.username.value.trim().toLowerCase();
    const pin = form.pin.value.trim();
    if (!fullName || !/^[a-z0-9._-]{3,40}$/.test(username) || (!isEditing && !/^\d{4,12}$/.test(pin)) || (pin && !/^\d{4,12}$/.test(pin))) {
      toast("Revisa el usuario y usa un PIN numerico de 4 a 12 digitos.", "error", "invalid-user-fields");
      return;
    }
    const payload = {
      auth_token: state.authToken,
      id: form.user_id.value || uid(),
      full_name: fullName,
      username,
      pin,
      role: form.role.value,
      is_active: form.is_active.checked
    };
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    let saved = null;
    let saveError = null;
    try {
      const result = await state.sb.rpc("saveUser", payload);
      saved = result.data;
      saveError = result.error;
    } catch (error) {
      saveError = error;
    } finally {
      if (submit) submit.disabled = false;
    }
    if (saveError || !saved?.id) {
      toast(saveError?.message || "No se pudo guardar el usuario.", "error", "save-user-failed");
      return;
    }
    state.users = mergeUsers(state.users.map((user) => String(user.id) === String(saved.id) ? saved : user), [saved]);
    persistUsersCache();
    if (String(saved.id) === String(state.currentUser?.id)) {
      state.currentUser = saved;
      localStorage.setItem(ADMIN_USER_CACHE_KEY, JSON.stringify(saved));
      applyCurrentUser();
    }
    form.reset();
    form.user_id.value = "";
    form.is_active.checked = true;
    form.pin.placeholder = "4 a 12 dígitos";
    resetUserFormPresentation(form);
    renderUsers();
    toast(isEditing ? `Usuario actualizado${pin ? " con nuevo PIN" : ""}.` : "Usuario creado correctamente.", "ok", `user-saved:${saved.id}`);
  };

  const editUser = (id) => {
    const user = state.users.find((entry) => entry.id === id);
    const form = $("#userForm");
    if (!user || !form) return;
    form.user_id.value = user.id;
    form.full_name.value = user.full_name || "";
    form.username.value = user.username || "";
    form.pin.value = "";
    form.pin.placeholder = "Dejar vacío para conservar";
    form.role.value = user.role || "waiter";
    form.is_active.checked = user.is_active !== false;
    if ($("#userFormEyebrow")) $("#userFormEyebrow").textContent = "Editar acceso";
    if ($("#userFormTitle")) $("#userFormTitle").textContent = user.full_name || "Usuario";
    const submitLabel = form.querySelector('.user-save-button span');
    if (submitLabel) submitLabel.textContent = "Guardar cambios";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const deleteUser = async (id) => {
    const user = state.users.find((entry) => entry.id === id);
    if (!user) return;
    if (String(user.id) === String(state.currentUser?.id)) {
      toast("No puedes eliminar el usuario con el que tienes la sesion abierta.", "error", "delete-current-user");
      return;
    }
    if (!await askForConfirmation({ eyebrow: "Eliminar usuario", title: `¿Eliminar a ${user.full_name}?`, message: "No podrá volver a iniciar sesión. Sus ventas anteriores conservarán el nombre del responsable.", accept: "Sí, eliminar usuario", cancel: "Conservar usuario" })) return;
    let result = null;
    let deleteError = null;
    try {
      const response = await state.sb.rpc("deleteUser", { auth_token: state.authToken, user_id: id });
      result = response.data;
      deleteError = response.error;
    } catch (error) {
      deleteError = error;
    }
    if (deleteError || !result?.deleted) {
      toast(deleteError?.message || "No se pudo eliminar el usuario.", "error", `delete-user:${id}`);
      return;
    }
    state.users = state.users.filter((entry) => entry.id !== id);
    persistUsersCache();
    renderUsers();
    const form = $("#userForm");
    if (form?.user_id.value === id) {
      form.reset();
      form.user_id.value = "";
      form.is_active.checked = true;
      form.pin.placeholder = "4 a 12 dígitos";
      resetUserFormPresentation(form);
    }
    toast("Usuario eliminado. El historial de sus ventas se conserva.", "ok", `user-deleted:${id}`);
  };

  const logoutAdmin = async () => {
    const token = state.authToken;
    state.authToken = "";
    state.currentUser = null;
    state.sb.setAuthToken("");
    localStorage.removeItem("la_licorera_17_admin_token");
    localStorage.removeItem(ADMIN_USER_CACHE_KEY);
    applyCurrentUser();
    void dbQuiet(state.sb.rpc("logout", { auth_token: token }), null);
    location.reload();
  };

  const initAdmin = async () => {
    setLoading(true);
    const pendingScan = new URLSearchParams(location.search).get("scan") || "";
    await waitForAdminLogin();
    loadInventoryStore();
    void loadUsers().then(renderUsers);
    state.soundEnabled = localStorage.getItem("waiter_alarm_enabled") === "1";
    const initialSection = pendingScan ? "service" : (location.hash.replace("#", "") || "dashboard");
    renderAdmin();
    renderUsers();
    showAdminSection(initialSection);
    updateAlarmButton();
    bindAdmin();
    armAlarmOnFirstGesture();
    subscribeAdmin();
    startAlarmLoop();
    setLoading(false);
    await loadBootstrap();
    await ensurePresetCategories();
    renderAdmin();
    showAdminSection(state.activeAdminSection || initialSection);
    renderTableFormQr();
    initRemoteStorage();
    window.addEventListener("online", flushAppsScriptOutbox);
    startAdminPolling();
    if (pendingScan) {
      const cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete("scan");
      history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}#service`);
      await openScannedTable(pendingScan);
    }
    // El shell queda visible al instante; el snapshot pesado llega sin bloquear la interfaz.
    void refreshAdminNow();
  };

  const init = async () => {
    state.page = document.body.dataset.page || "";
    void registerPwa();
    if (!connect()) {
      document.body.innerHTML = `
        <main class="setup-screen">
          <div class="setup-card">
            ${icon("database-zap", 34)}
            <h1>Conecta Supabase</h1>
            <p>Configura la URL y la anon key en <strong>app.js</strong>, y ejecuta <strong>supabase-schema.sql</strong>.</p>
          </div>
        </main>
      `;
      refreshIcons();
      return;
    }
    if (state.page === "client") {
      window.addEventListener("online", () => {
        flushRequestOutbox();
        flushBillResolutionOutbox();
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          flushRequestOutbox();
          flushBillResolutionOutbox();
        }
      });
      flushRequestOutbox();
    }
    if (state.page === "admin") await initAdmin();
    if (state.page === "client") await initClient();
    refreshIcons();
  };

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
