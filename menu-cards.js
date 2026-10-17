/* Biblioteca de cartas, asignación por mesa y visor privado del cliente. */
window.MenuCards = (() => {
  const $ = (selector) => document.querySelector(selector);
  const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const colors = { blue: "Azul", violet: "Violeta", green: "Verde", amber: "Ámbar", rose: "Rosa", cyan: "Cian" };
  const features = {
    client_menu_enabled: ["Carta", "book-open", "Permite consultar las imágenes de la carta asignadas a cada mesa."],
    client_bill_enabled: ["Ver cuenta", "receipt-text", "Permite a los clientes consultar la cuenta de su mesa."],
    client_waiter_enabled: ["Llamar mesero", "bell-ring", "Muestra el botón para solicitar atención del mesero."],
    client_chat_enabled: ["Chat", "messages-square", "Permite conversar y hacer pedidos por el chat."],
    client_song_enabled: ["Pedir canción", "music-2", "Permite enviar solicitudes de canciones desde la mesa."]
  };
  let ctx;
  let cards = [];
  let selected = "";
  let assigning = false;
  let loaded = false;
  let loading = null;
  let uploading = false;
  let saving = false;
  let pendingSave = null;
  let autosaveTimer = null;
  let viewerCards = [];
  let viewerIndex = 0;
  let viewerRequest = 0;
  let viewerImageRequest = 0;
  let preparedTable = null;
  let menuUpdatesChannel = null;
  let zoomScale = 1;
  let zoomX = 0;
  let zoomY = 0;
  let imageFit = {width: 0, height: 0, viewportWidth: 0, viewportHeight: 0};
  let zoomFrame = null;
  let gestureStart = null;
  let gesturePinched = false;
  let lastTap = null;
  const pointers = new Map();
  const drafts = new Map();
  const previews = new Map();
  const brandDrafts = new Map();
  const featureDrafts = new Map();

  const icon = (name, size = 18) => ctx.icon(name, size);
  const enabled = (key) => ctx?.getBusiness()?.[key] !== false;
  const activeTables = () => ctx.getTables().filter((t) => t.is_active !== false).slice().sort((a, b) => Number(a.table_number) - Number(b.table_number));
  const activeCard = () => cards.find((card) => card.id === selected);
  const draftFor = (card) => {
    if (!card) return null;
    if (!drafts.has(card.id)) drafts.set(card.id, { name: card.name, color: card.color, tableIds: new Set(card.table_ids.map(String)) });
    return drafts.get(card.id);
  };
  const draftSignature = (draft) => JSON.stringify([draft.name.trim(), draft.color, [...draft.tableIds].map(String).sort()]);
  const pendingCards = () => cards.filter((card) => drafts.has(card.id) && draftSignature(drafts.get(card.id)) !== draftSignature({name: card.name, color: card.color, tableIds: new Set(card.table_ids || [])}));
  const persistCardDrafts = () => {
    try {
      const pending = pendingCards().map((card) => ({id: card.id, name: drafts.get(card.id).name, color: drafts.get(card.id).color, table_ids: [...drafts.get(card.id).tableIds]}));
      if (pending.length) localStorage.setItem("maravillosos-menu-card-drafts", JSON.stringify(pending));
      else localStorage.removeItem("maravillosos-menu-card-drafts");
    } catch { /* El guardado remoto sigue funcionando sin almacenamiento local. */ }
  };
  const scheduleCardSave = () => {
    persistCardDrafts();
    clearTimeout(autosaveTimer);
    if (!pendingCards().length) {
      autosaveTimer = null;
      if (!pendingSave) setStatus("Asignaciones guardadas y verificadas. Cada mesa verá todas sus cartas seleccionadas.");
      return;
    }
    setStatus("Guardando la selección de mesas…");
    autosaveTimer = setTimeout(() => { autosaveTimer = null; void savePendingCards({background: true}); }, 450);
  };
  const setStatus = (message, error = false) => {
    const status = $("#menuCardsStatus");
    if (status) { status.textContent = message; status.classList.toggle("is-error", error); }
  };
  const rpc = async (name, args) => {
    const { data, error } = await ctx.sb.rpc(name, args);
    if (error) throw new Error(error.message || "No se pudo completar la operación.");
    return data;
  };
  const signedImage = async (imagePath) => {
    const { data, error } = await ctx.sb.storage.from("menu-cards").createSignedUrl(imagePath, 300);
    if (error || !data?.signedUrl) throw new Error("No se pudo abrir la imagen de la carta.");
    return data.signedUrl;
  };

  const renderLibrary = () => {
    const stack = $("#menuLibraryStack");
    if (!stack) return;
    const count = cards.length;
    $("#menuLibraryCount").textContent = `${count}/5`;
    $("#menuLibraryProgress").value = count;
    $("#menuLibraryProgress").textContent = `${count} de 5`;
    $("#menuLibraryUploadStatus").textContent = uploading ? "Subiendo imágenes…" : count >= 5 ? "Biblioteca completa · 5 imágenes" : "Subir imágenes · JPG, PNG o WebP";
    $("#menuCardImageFile").disabled = uploading || saving || count >= 5 || !loaded;
    $("#newMenuCard").disabled = uploading || saving || count >= 5 || !loaded;
    const disabled = uploading || saving || count >= 5 || !loaded;
    stack.innerHTML = count ? cards.map((card, index) => `<button type="button" class="menu-library-card" data-library-card="${escape(card.id)}" data-color="${card.color}" style="--card-index:${index};--card-depth:${card.id === selected ? 6 : index + 1}" title="Subir otra imagen de carta" aria-label="Subir otra imagen de carta" ${disabled ? "disabled" : ""}>${previews.has(card.id) ? `<img src="${escape(previews.get(card.id))}" alt="${escape(card.name)}">` : icon("image", 30)}<span>${escape(card.name)}</span></button>`).join("") : `<button type="button" class="menu-library-empty" data-add-menu-image aria-label="Subir imágenes de cartas" ${disabled ? "disabled" : ""}>${icon("images", 28)}<span>Tus cartas, en un solo lugar</span></button>`;
    ctx.refreshIcons();
  };

  const renderTabs = () => {
    const tabs = $("#menuCardTabs");
    if (!tabs) return;
    tabs.innerHTML = cards.map((card) => `<button type="button" class="menu-card-tab" data-select-menu-card="${escape(card.id)}" data-color="${draftFor(card).color}" aria-pressed="${card.id === selected}"><span class="menu-card-color-dot"></span>${escape(draftFor(card).name || card.name)}</button>`).join("");
    $("#menuCardFields").hidden = !activeCard();
    $("#menuCardAssignmentActions").hidden = !activeCard();
  };

  const renderTableSelector = () => {
    if (!assigning) return false;
    const selector = $("#outdoorTableSelector");
    if (!selector) return false;
    const draft = draftFor(activeCard());
    const tables = activeTables();
    const ids = new Set(tables.map((t) => String(t.id)));
    ["#outdoorTableFrom", "#outdoorTableTo"].forEach((name, index) => {
      const select = $(name);
      const previous = select.value;
      select.innerHTML = tables.map((t) => `<option value="${escape(t.id)}">M${escape(t.table_number)} · ${escape(ctx.tableLabel(t))}</option>`).join("") || '<option value="">Sin mesas</option>';
      if (ids.has(previous)) select.value = previous;
      else if (index && tables.length) select.value = String(tables[tables.length - 1].id);
    });
    selector.classList.add("menu-card-table-selector");
    selector.dataset.color = draft?.color || "blue";
    selector.innerHTML = tables.map((table) => {
      const id = String(table.id);
      const assigned = cards.filter((c) => draftFor(c).tableIds.has(id));
      return `<label class="outdoor-table-option menu-card-table-option" title="${escape(ctx.tableLabel(table))}"><input type="checkbox" data-menu-card-table="${escape(id)}" ${draft?.tableIds.has(id) ? "checked" : ""} ${!draft || saving ? "disabled" : ""}><span>${icon("armchair", 16)} M${escape(table.table_number)}<small class="menu-card-table-dots">${assigned.map((c) => `<i class="menu-card-color-dot" data-color="${draftFor(c).color}" title="${escape(draftFor(c).name)}"></i>`).join("")}</small></span></label>`;
    }).join("") || '<p>No hay mesas activas para asignar.</p>';
    const count = draft ? tables.filter((t) => draft.tableIds.has(String(t.id))).length : 0;
    $("#tableZoneSettingStatus").textContent = draft ? `${count} de ${tables.length} mesas verán «${draft.name || activeCard().name}». Las selecciones se guardan automáticamente.` : "Sube una imagen en la biblioteca y elige sus mesas.";
    ctx.refreshIcons();
    return true;
  };

  const renderEditor = () => {
    renderTabs();
    const card = activeCard();
    const draft = draftFor(card);
    if (draft) {
      $("#menuCardName").value = draft.name;
      $("#menuCardColors").innerHTML = Object.entries(colors).map(([value, name]) => `<button class="menu-card-color-choice" type="button" data-card-color="${value}" data-color="${value}" aria-label="${name}" aria-pressed="${draft.color === value}" title="${name}"><span class="menu-card-color-dot"></span></button>`).join("");
      const img = $("#menuCardPreview");
      img.hidden = !previews.has(card.id);
      if (previews.has(card.id)) img.src = previews.get(card.id);
      img.alt = `Vista previa: ${draft.name || card.name}`;
    }
    $("#saveMenuCard").disabled = saving || uploading;
    $("#deleteMenuCard").disabled = saving || uploading;
    renderLibrary();
    renderTableSelector();
  };

  const loadLibrary = async () => {
    if (loaded || !ctx.getAuthToken()) return;
    if (loading) return loading;
    $("#menuLibraryUploadStatus").textContent = "Cargando biblioteca…";
    loading = (async () => {
      try {
        const data = await rpc("list_business_menu_cards", { p_auth_token: ctx.getAuthToken() });
        cards = Array.isArray(data) ? data : [];
        try {
          const stored = JSON.parse(localStorage.getItem("maravillosos-menu-card-drafts") || "[]");
          const valid = new Set(activeTables().map((table) => String(table.id)));
          for (const draft of stored) {
            if (cards.some((card) => card.id === draft.id) && typeof draft.name === "string" && colors[draft.color] && Array.isArray(draft.table_ids)) {
              drafts.set(draft.id, {name: draft.name, color: draft.color, tableIds: new Set(draft.table_ids.map(String).filter((id) => valid.has(id)))});
            }
          }
        } catch { /* Un borrador inválido no cambia las asignaciones guardadas. */ }
        loaded = true;
        selected ||= cards[0]?.id || "";
        renderEditor();
        if (pendingCards().length) scheduleCardSave();
        setStatus(cards.length ? "Selecciona una carta y marca sus mesas." : "Sube tus primeras cartas junto a Logo y Portada.");
        await Promise.allSettled(cards.map(async (card) => { previews.set(card.id, await signedImage(card.image_path)); }));
        renderEditor();
      } catch (error) {
        $("#menuLibraryUploadStatus").textContent = "No se pudo cargar · pulsa Cartas para reintentar";
        setStatus("No pudimos cargar la biblioteca. Vuelve a pulsar Cartas para reintentar.", true);
      } finally { loading = null; }
    })();
    return loading;
  };

  const toggleAssignment = async (value = !assigning) => {
    assigning = value;
    $("#menuCardsEditor").hidden = !assigning;
    $("#manageMenuCards").setAttribute("aria-expanded", String(assigning));
    $("#manageMenuCards").classList.toggle("is-active", assigning);
    ["#selectOutdoorRange", "#clearOutdoorRange"].forEach((s) => { $(s).hidden = assigning; });
    $("#outdoorTableSelector").classList.toggle("menu-card-table-selector", assigning);
    if (assigning) { renderEditor(); await loadLibrary(); }
    else ctx.renderOutdoorTables();
  };

  const uploadFiles = async (files) => {
    if (uploading || saving) return;
    const pending = Array.from(files || []);
    $("#menuCardImageFile").value = "";
    if (!pending.length) return;
    if (cards.length + pending.length > 5) { ctx.toast(`Puedes subir ${5 - cards.length} imagen(es) más. El máximo es 5.`, "error"); return; }
    for (const file of pending) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 15 * 1024 * 1024) {
        ctx.toast("Usa imágenes JPG, PNG o WebP de hasta 15 MB cada una.", "error"); return;
      }
    }
    uploading = true;
    renderLibrary();
    let completed = 0;
    try {
      for (const file of pending) {
        $("#menuLibraryUploadStatus").textContent = `Subiendo ${completed + 1} de ${pending.length}…`;
        const id = crypto.randomUUID();
        const extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[file.type];
        const imagePath = `cards/${id}/${crypto.randomUUID()}.${extension}`;
        const storage = ctx.sb.storage.from("menu-cards");
        const { error } = await storage.upload(imagePath, file, { upsert: false, contentType: file.type });
        if (error) throw new Error(error.message);
        let saved;
        try {
          saved = await rpc("save_business_menu_card", { p_card_id: id, p_name: file.name.replace(/\.[^.]+$/, "").trim().slice(0, 80) || `Carta ${cards.length + 1}`, p_image_path: imagePath, p_color: Object.keys(colors).find((color) => !cards.some((card) => card.color === color)) || "blue", p_table_ids: [], p_auth_token: ctx.getAuthToken() });
        } catch (saveError) { await storage.remove([imagePath]); throw saveError; }
        cards.push(saved);
        previews.set(saved.id, URL.createObjectURL(file));
        selected = saved.id;
        completed += 1;
        renderEditor();
      }
      setStatus(`${completed} imagen(es) subida(s). Ahora nombra cada carta, selecciona sus mesas y pulsa Guardar cartas.`);
      await toggleAssignment(true);
      $("#menuCardsEditor").scrollIntoView({behavior: "smooth", block: "nearest"});
    } catch (error) {
      ctx.toast(`Se subieron ${completed} de ${pending.length} imágenes. ${error.message}`, "error");
      setStatus("No se completó la carga. Las imágenes ya subidas se conservan.", true);
    } finally { uploading = false; renderEditor(); }
  };

  const savePendingCards = async ({notify = false, background = false} = {}) => {
    clearTimeout(autosaveTimer); autosaveTimer = null;
    if (pendingSave) {
      if (!(await pendingSave)) return false;
      return savePendingCards({notify, background});
    }
    if (saving || uploading) { setStatus("Espera a que termine la operación de las cartas.", true); return false; }
    const changes = pendingCards();
    if (!changes.length) return true;
    const invalid = changes.find((card) => !drafts.get(card.id).name.trim());
    if (invalid) {
      selected = invalid.id; renderEditor(); $("#menuCardName").focus();
      setStatus("Escribe el nombre de cada carta antes de guardar.", true); return false;
    }
    const snapshots = changes.map((card) => ({card, draft: {...drafts.get(card.id), tableIds: new Set(drafts.get(card.id).tableIds)}}));
    if (!background) { saving = true; $("#menuCardName").disabled = true; renderEditor(); }
    setStatus("Guardando todas las cartas y sus mesas…");
    pendingSave = (async () => {
      let success = false;
      try {
        const validIds = new Set(activeTables().map((t) => String(t.id)));
        const results = await Promise.allSettled(snapshots.map(({card, draft}) => rpc("save_business_menu_card", {p_card_id: card.id, p_name: draft.name.trim(), p_image_path: card.image_path, p_color: draft.color, p_table_ids: [...draft.tableIds].filter((id) => validIds.has(id)), p_auth_token: ctx.getAuthToken()})));
        const stored = await rpc("list_business_menu_cards", {p_auth_token: ctx.getAuthToken()});
        const failed = [];
        snapshots.forEach(({card, draft}, index) => {
          const confirmed = stored.find((entry) => entry.id === card.id);
          if (results[index].status === "rejected" || !confirmed || draftSignature(draft) !== draftSignature({name: confirmed.name, color: confirmed.color, tableIds: new Set(confirmed.table_ids || [])})) {
            failed.push(draft.name); return;
          }
          cards = cards.map((entry) => entry.id === card.id ? confirmed : entry);
          if (drafts.has(card.id) && draftSignature(drafts.get(card.id)) === draftSignature(draft)) drafts.delete(card.id);
        });
        if (failed.length) { setStatus(`No se confirmó el guardado de: ${failed.join(", ")}. Conservamos tu selección; pulsa Guardar cartas para reintentar.`, true); return false; }
        success = true;
        try { localStorage.setItem("maravillosos-menu-cards-version", String(Date.now())); } catch { /* La actualización remota sigue disponible. */ }
        void menuUpdatesChannel?.send({type: "broadcast", event: "assignments-changed", payload: {updatedAt: Date.now()}}).catch(() => {});
        setStatus("Asignaciones guardadas y verificadas. Cada mesa verá todas sus cartas seleccionadas.");
        if (notify) ctx.toast("Cartas y mesas guardadas.");
        return true;
      } catch (error) {
        setStatus(`No pudimos verificar las asignaciones. Tu selección se conserva. ${error.message}`, true);
        return false;
      } finally {
        saving = false; pendingSave = null; persistCardDrafts();
        if (background) { renderLibrary(); renderTableSelector(); }
        else { $("#menuCardName").disabled = false; renderEditor(); }
        if (success && pendingCards().length) scheduleCardSave();
      }
    })();
    return pendingSave;
  };

  const deleteCard = async () => {
    const card = activeCard();
    if (!card || saving || uploading) return;
    if (!await ctx.confirm({title: `¿Eliminar «${card.name}»?`, message: "Esta carta dejará de mostrarse en todas sus mesas.", accept: "Eliminar carta"})) return;
    saving = true; renderEditor();
    try {
      await rpc("delete_business_menu_card", {p_card_id: card.id, p_auth_token: ctx.getAuthToken()});
      cards = cards.filter((c) => c.id !== card.id);
      drafts.delete(card.id);
      persistCardDrafts();
      const preview = previews.get(card.id);
      if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
      previews.delete(card.id);
      selected = cards[0]?.id || "";
      // Una imagen huérfana nunca queda visible para los clientes.
      await ctx.sb.storage.from("menu-cards").remove([card.image_path]);
      setStatus("Carta eliminada.");
    } catch (error) { setStatus(error.message, true); }
    finally { saving = false; renderEditor(); }
  };

  const assignTables = (mode) => {
    const draft = draftFor(activeCard());
    if (!draft || saving) return;
    const tables = activeTables();
    if (mode === "none") draft.tableIds.clear();
    else {
      const from = tables.findIndex((t) => String(t.id) === $("#outdoorTableFrom").value);
      const to = tables.findIndex((t) => String(t.id) === $("#outdoorTableTo").value);
      tables.forEach((t, index) => {
        const id = String(t.id);
        const outdoor = ctx.isOutdoor(t);
        const match = mode === "all" || mode === "outdoor" && outdoor || mode === "indoor" && !outdoor || ["range", "remove-range"].includes(mode) && from >= 0 && to >= 0 && index >= Math.min(from, to) && index <= Math.max(from, to);
        if (match) mode === "remove-range" ? draft.tableIds.delete(id) : draft.tableIds.add(id);
      });
    }
    renderTableSelector();
    scheduleCardSave();
  };

  const clampViewerPan = () => {
    const limitX = Math.max(0, (imageFit.width * zoomScale - imageFit.viewportWidth) / 2);
    const limitY = Math.max(0, (imageFit.height * zoomScale - imageFit.viewportHeight) / 2);
    zoomX = Math.max(-limitX, Math.min(limitX, zoomX));
    zoomY = Math.max(-limitY, Math.min(limitY, zoomY));
  };
  const paintViewerZoom = () => {
    if (zoomFrame !== null) return;
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = null;
      const image = $("#menuViewerImage");
      const wrap = $("#menuViewerImageWrap");
      const button = $("#menuViewerZoom");
      const zoomed = zoomScale > 1.01;
      image.style.transform = `translate3d(${zoomX}px, ${zoomY}px, 0) scale(${zoomScale})`;
      wrap.classList.toggle("is-zoomed", zoomed);
      const pressed = String(zoomed);
      if (button.getAttribute("aria-pressed") !== pressed || !button.querySelector("svg")) {
        button.setAttribute("aria-pressed", pressed);
        button.setAttribute("aria-label", zoomed ? "Restablecer tamaño de imagen" : "Ampliar imagen");
        button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5M7 10.5h7${zoomed ? "" : "M10.5 7v7"}"/></svg>`;
      }
    });
  };
  const fitViewerImage = () => {
    const image = $("#menuViewerImage");
    const wrap = $("#menuViewerImageWrap");
    if (!image.naturalWidth || !wrap.clientWidth || !wrap.clientHeight) return;
    const ratio = Math.min(wrap.clientWidth / image.naturalWidth, wrap.clientHeight / image.naturalHeight);
    imageFit = {width: image.naturalWidth * ratio, height: image.naturalHeight * ratio, viewportWidth: wrap.clientWidth, viewportHeight: wrap.clientHeight};
    image.style.width = `${imageFit.width}px`;
    image.style.height = `${imageFit.height}px`;
    clampViewerPan(); paintViewerZoom();
  };
  const resetViewerZoom = () => {
    zoomScale = 1; zoomX = 0; zoomY = 0;
    pointers.clear(); gestureStart = null; gesturePinched = false; lastTap = null;
    $("#menuViewerImageWrap").classList.remove("is-dragging");
    fitViewerImage(); paintViewerZoom();
  };
  const zoomViewerAt = (scale, clientX, clientY) => {
    const bounds = $("#menuViewerImageWrap").getBoundingClientRect();
    const x = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
    const y = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
    const next = Math.max(1, Math.min(6, scale));
    const ratio = next / zoomScale;
    zoomX = x - (x - zoomX) * ratio;
    zoomY = y - (y - zoomY) * ratio;
    zoomScale = next;
    clampViewerPan(); paintViewerZoom();
  };
  const bindViewerGestures = () => {
    const wrap = $("#menuViewerImageWrap");
    const midpoint = (points) => ({x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2});
    const distance = (points) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    wrap.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || $("#menuViewerImage").hidden) return;
      event.preventDefault();
      wrap.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (pointers.size === 1) {
        gestureStart = {x: event.clientX, y: event.clientY, at: performance.now()};
        gesturePinched = false;
      } else { gesturePinched = true; lastTap = null; }
      wrap.classList.toggle("is-dragging", zoomScale > 1 || pointers.size > 1);
    });
    wrap.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      const previous = pointers.get(event.pointerId);
      const before = [...pointers.values()].slice(0, 2);
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (pointers.size > 1) {
        const after = [...pointers.values()].slice(0, 2);
        const oldCenter = midpoint(before), center = midpoint(after);
        zoomViewerAt(zoomScale * distance(after) / Math.max(1, distance(before)), oldCenter.x, oldCenter.y);
        zoomX += center.x - oldCenter.x; zoomY += center.y - oldCenter.y;
      } else if (zoomScale > 1) {
        zoomX += event.clientX - previous.x; zoomY += event.clientY - previous.y;
      }
      clampViewerPan(); paintViewerZoom();
    });
    const endPointer = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
      if (pointers.size) return;
      wrap.classList.remove("is-dragging");
      const start = gestureStart; gestureStart = null;
      if (!start || gesturePinched || event.type === "pointercancel") { lastTap = null; return; }
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) < 10 && performance.now() - start.at < 350) {
        const now = performance.now();
        if (lastTap && now - lastTap.at < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 35) {
          zoomViewerAt(zoomScale > 1.01 ? 1 : 2.5, event.clientX, event.clientY);
          lastTap = null;
        } else lastTap = {x: event.clientX, y: event.clientY, at: now};
      } else {
        lastTap = null;
        if (zoomScale <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) moveViewer(dx < 0 ? 1 : -1);
      }
    };
    wrap.addEventListener("pointerup", endPointer);
    wrap.addEventListener("pointercancel", endPointer);
    wrap.addEventListener("wheel", (event) => {
      if ($("#menuViewerImage").hidden) return;
      event.preventDefault();
      zoomViewerAt(zoomScale * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
    }, {passive: false});
    new ResizeObserver(fitViewerImage).observe(wrap);
  };

  const warmCardImage = (card, priority = "low") => {
    if (card.imageElement) return Promise.resolve(card.imageElement);
    if (card.imageLoading) return card.imageLoading;
    card.imageLoading = (async () => {
      if (!card.url || card.urlExpiresAt < Date.now()) {
        card.url = await signedImage(card.image_path);
        card.urlExpiresAt = Date.now() + 270000;
      }
      const image = new Image();
      image.decoding = "async";
      image.fetchPriority = priority;
      image.draggable = false;
      image.alt = card.name;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("No se pudo descargar la imagen de la carta."));
        image.src = card.url;
      });
      await image.decode();
      image.onload = null; image.onerror = null;
      card.imageElement = image;
      return image;
    })().finally(() => { card.imageLoading = null; });
    return card.imageLoading;
  };
  const prepareForTable = async ({force = false} = {}) => {
    if (!ctx || ctx.page !== "client") return;
    const table = ctx.getCurrentTable();
    const key = table && enabled("client_menu_enabled") ? `${table.id}:${table.qr_code}` : "";
    if (!key) { preparedTable = null; $("#openMenuCards")?.removeAttribute("data-menu-ready"); return; }
    if (preparedTable?.key !== key) {
      if ($("#menuCardsViewer").open) closeViewer();
      preparedTable = {key, cards: [], loaded: false, updatedAt: 0, pending: null};
      $("#openMenuCards").dataset.menuReady = "false";
    }
    const cache = preparedTable;
    if (cache.pending) return cache.pending;
    if (!force && cache.loaded && Date.now() - cache.updatedAt < 15000) return cache;
    cache.pending = (async () => {
      const data = await rpc("get_table_menu_cards", {p_table_id: table.id, p_table_access_code: table.qr_code});
      if (cache !== preparedTable || String(ctx.getCurrentTable()?.id) !== String(table.id)) return;
      const previous = new Map(cache.cards.map((card) => [card.id, card]));
      const signature = (list) => JSON.stringify(list.map((card) => [card.id, card.name, card.image_path]));
      const oldSignature = signature(cache.cards);
      cache.cards = (Array.isArray(data) ? data : []).map((card) => {
        const old = previous.get(card.id);
        return old?.image_path === card.image_path ? Object.assign(old, card) : card;
      });
      cache.loaded = true; cache.updatedAt = Date.now();
      // Solo se descargan y decodifican imágenes autorizadas para la mesa actual.
      $("#openMenuCards").dataset.menuCardCount = String(cache.cards.length);
      $("#openMenuCards").dataset.menuReady = String(cache.cards.every((card) => card.imageElement));
      void Promise.allSettled(cache.cards.map((card, index) => warmCardImage(card, index ? "low" : "high"))).then(() => {
        if (cache === preparedTable) $("#openMenuCards").dataset.menuReady = String(cache.cards.every((card) => card.imageElement));
      });
      if ($("#menuCardsViewer").open && oldSignature !== signature(cache.cards)) {
        const currentId = viewerCards[viewerIndex]?.id;
        viewerCards = cache.cards;
        viewerIndex = Math.max(0, viewerCards.findIndex((card) => card.id === currentId));
        $("#menuViewerStatus").textContent = "Todavía no hay cartas asignadas a esta mesa. Consulta con el mesero.";
        renderViewer();
      }
      return cache;
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  };
  const showViewerImage = async (card) => {
    const request = ++viewerImageRequest;
    $("#menuViewerImage").hidden = true;
    $("#menuViewerStatus").hidden = false;
    $("#menuViewerStatus").textContent = "Cargando imagen…";
    try {
      const image = card.imageElement || await warmCardImage(card, "high");
      if (request !== viewerImageRequest || card.id !== viewerCards[viewerIndex]?.id || !$("#menuCardsViewer").open) return;
      const previous = $("#menuViewerImage");
      if (previous !== image) { previous.removeAttribute("id"); previous.replaceWith(image); }
      image.id = "menuViewerImage";
      image.alt = card.name;
      image.hidden = false;
      $("#menuViewerStatus").hidden = true;
      fitViewerImage();
    } catch (error) {
      if (request === viewerImageRequest) $("#menuViewerStatus").textContent = "No pudimos cargar esta imagen. Puedes cambiar de carta o cerrar y volver a intentarlo.";
    }
  };

  const renderViewer = () => {
    const card = viewerCards[viewerIndex];
    const image = $("#menuViewerImage");
    resetViewerZoom();
    ["#previousMenuCard", "#nextMenuCard"].forEach((s) => { $(s).hidden = viewerCards.length < 2; });
    $("#menuViewerZoom").hidden = !card;
    $("#menuViewerTitle").textContent = card?.name || "Carta";
    $("#menuViewerCounter").textContent = card ? `${viewerIndex + 1} de ${viewerCards.length}` : "";
    $("#menuViewerDots").innerHTML = viewerCards.map((c, i) => `<button type="button" data-menu-view-index="${i}" aria-label="${escape(c.name)}" aria-current="${i === viewerIndex ? "true" : "false"}"></button>`).join("");
    image.hidden = true;
    $("#menuViewerStatus").hidden = false;
    $("#menuCardsViewer .menu-viewer-footer > small").hidden = !enabled("client_chat_enabled");
    if (card) void showViewerImage(card);
    else { viewerImageRequest += 1; }
    ctx.refreshIcons();
  };

  const closeViewer = () => {
    viewerRequest += 1;
    viewerImageRequest += 1;
    $("#menuCardsViewer")?.close();
    viewerCards = [];
    resetViewerZoom();
    const image = $("#menuViewerImage");
    if (image) image.hidden = true;
    $("#openMenuCards")?.focus({preventScroll: true});
  };
  const openViewer = async () => {
    if (!enabled("client_menu_enabled")) return;
    const table = ctx.getCurrentTable();
    if (!table) { ctx.toast("Selecciona tu mesa para consultar su carta.", "error"); return; }
    const request = ++viewerRequest;
    const tableId = String(table.id);
    const preparing = prepareForTable();
    viewerCards = preparedTable?.cards || []; viewerIndex = 0;
    $("#menuViewerStatus").textContent = "Cargando cartas…";
    const dialog = $("#menuCardsViewer");
    if (!dialog.open) dialog.showModal();
    renderViewer();
    try {
      const cache = await preparing;
      if (request !== viewerRequest || tableId !== String(ctx.getCurrentTable()?.id) || !enabled("client_menu_enabled")) return;
      if (!cache?.cards.length) $("#menuViewerStatus").textContent = "Todavía no hay cartas asignadas a esta mesa. Consulta con el mesero.";
    } catch (error) {
      if (request !== viewerRequest) return;
      $("#menuViewerStatus").textContent = "No pudimos cargar la carta. Cierra e inténtalo de nuevo.";
    }
  };
  const moveViewer = (step) => { if (viewerCards.length) { viewerIndex = (viewerIndex + step + viewerCards.length) % viewerCards.length; renderViewer(); } };

  const syncFeatures = () => {
    if (!ctx || ctx.page !== "client") return;
    const visibility = [["#openMenuCards", "client_menu_enabled"], ['[data-request="bill"]', "client_bill_enabled"], ['[data-request="waiter"]', "client_waiter_enabled"], ["#songModeToggle", "client_song_enabled"]];
    visibility.forEach(([selector, key]) => { const el = $(selector); if (el) el.hidden = !enabled(key); });
    const chat = $("#clientChatSection");
    if (chat) chat.hidden = !(enabled("client_chat_enabled") || enabled("client_song_enabled") && ctx.getAssistantMode() === "song");
    if (!enabled("client_menu_enabled") && $("#menuCardsViewer")?.open) closeViewer();
    if (!enabled("client_bill_enabled")) ctx.refreshBill?.();
    void prepareForTable().catch(() => {});
  };

  const renderBrandAssets = (form) => {
    ["logo_url", "cover_url"].forEach((field) => {
      const value = brandDrafts.get(field) ?? ctx.getBusiness()?.[field] ?? "";
      form[field].value = value;
      const box = $(`[data-upload-box="${field}"]`);
      if (!box) return;
      let img = box.querySelector(".brand-asset-preview");
      if (!value) { img?.remove(); return; }
      if (!img) { img = document.createElement("img"); img.className = "brand-asset-preview"; img.alt = field === "logo_url" ? "Vista previa del logo" : "Vista previa de la portada"; box.append(img); }
      if (img.getAttribute("src") !== value) img.src = value;
      box.classList.add("has-file");
    });
  };
  const renderFeatureForm = (form) => {
    Object.keys(features).forEach((key) => {
      const input = form.elements[key];
      if (!input) return;
      input.checked = featureDrafts.get(key) ?? enabled(key);
      if (key === "client_bill_enabled") {
        const available = Object.hasOwn(ctx.getBusiness() || {}, key);
        input.disabled = !available;
        const help = $("#client_bill_enabled_help");
        if (help) help.textContent = available ? features[key][2] : "Pendiente de actualizar Supabase para guardar esta opción.";
      }
    });
    renderBrandAssets(form);
    if (ctx.page === "admin" && !loaded && !loading && ctx.getAuthToken() && ctx.canManage()) void loadLibrary();
  };

  const saveFeature = async (input) => {
    const key = input.name;
    const value = input.checked;
    const previous = enabled(key);
    if (key === "client_bill_enabled" && !Object.hasOwn(ctx.getBusiness() || {}, key)) {
      input.checked = previous;
      ctx.toast("Actualiza Supabase para habilitar el interruptor Ver cuenta.", "error");
      return;
    }
    featureDrafts.set(key, value);
    input.disabled = true;
    ctx.updateBusiness({[key]: value});
    try {
      const {data, error} = await ctx.sb.from("business_settings").update({[key]: value}).eq("is_primary", true).select("*").maybeSingle();
      if (error || !data) throw new Error(error?.message || "No se pudo guardar el cambio.");
      if (key === "client_bill_enabled" && data[key] !== value) throw new Error("No se confirmó el cambio de Ver cuenta.");
      ctx.updateBusiness({[key]: data[key]});
      featureDrafts.delete(key);
      ctx.toast(`${features[key][0]} ${value ? "activado" : "desactivado"}.`);
    } catch (error) {
      featureDrafts.delete(key);
      ctx.updateBusiness({[key]: previous});
      input.checked = previous;
      ctx.toast(`No se guardó el cambio de ${features[key][0]}. Inténtalo de nuevo.`, "error");
    } finally { input.disabled = false; }
  };

  const init = (context) => {
    if (ctx) return;
    ctx = context;
    menuUpdatesChannel = ctx.sb.channel("business-menu-card-updates", {config: {broadcast: {self: false}, private: false}})
      .on("broadcast", {event: "assignments-changed"}, () => { if (ctx.page === "client") void prepareForTable({force: true}).catch(() => {}); })
      .subscribe();
    if (ctx.page === "admin") {
      const propina = $(".tip-setting-card");
      propina?.insertAdjacentHTML("afterend", `<div class="client-features-card wide" role="group" aria-label="Opciones para los clientes">${Object.entries(features).map(([key, [name, glyph, description]]) => `<div class="client-feature-setting"><div class="client-feature-heading"><strong>${icon(glyph)} ${name}</strong><label class="modern-switch"><input name="${key}" type="checkbox" role="switch" checked aria-label="Activar ${name}" aria-describedby="${key}_help"><span aria-hidden="true"></span></label></div><small id="${key}_help">${description}</small></div>`).join("")}<small class="client-feature-save-note">Los cambios se guardan al activar o desactivar cada opción.</small></div>`);
      $("#menuCardName")?.addEventListener("input", (event) => { const draft = draftFor(activeCard()); if (draft) { draft.name = event.target.value; persistCardDrafts(); renderTabs(); renderTableSelector(); } });
      $("#menuCardName")?.addEventListener("keydown", (event) => { if (event.key === "Enter") {event.preventDefault(); void savePendingCards({notify: true});} });
      $("#menuCardImageFile")?.addEventListener("change", (event) => void uploadFiles(event.target.files));
      document.addEventListener("change", (event) => {
        if (Object.hasOwn(features, event.target.name)) void saveFeature(event.target);
        if (event.target.matches("[data-menu-card-table]")) {
          const draft = draftFor(activeCard());
          if (!draft || saving) return;
          const id = event.target.dataset.menuCardTable;
          event.target.checked ? draft.tableIds.add(id) : draft.tableIds.delete(id);
          renderTableSelector();
          scheduleCardSave();
        }
      });
      document.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button || button.disabled) return;
        if (button.id === "manageMenuCards") await toggleAssignment();
        if (button.id === "newMenuCard" || button.dataset.libraryCard || button.hasAttribute("data-add-menu-image")) {
          if (!$("#menuCardImageFile").disabled) $("#menuCardImageFile").click();
          return;
        }
        if (button.id === "saveMenuCard") await savePendingCards({notify: true});
        if (button.id === "deleteMenuCard") await deleteCard();
        const id = button.dataset.selectMenuCard;
        if (id && !saving) { selected = id; renderEditor(); }
        if (button.dataset.cardColor && !saving) { const draft = draftFor(activeCard()); if (draft) { draft.color = button.dataset.cardColor; renderEditor(); scheduleCardSave(); } }
        if (button.dataset.cardAssign) assignTables(button.dataset.cardAssign);
      });
    } else {
      ctx.sb.channel("client-feature-settings")
        .on("postgres_changes", {event: "UPDATE", schema: "public", table: "business_settings"}, ({new: business}) => ctx.updateBusiness(business))
        .subscribe();
      $("#openMenuCards")?.addEventListener("click", openViewer);
      window.addEventListener("storage", (event) => { if (event.key === "maravillosos-menu-cards-version") void prepareForTable({force: true}).catch(() => {}); });
      document.addEventListener("visibilitychange", () => { if (!document.hidden) void prepareForTable({force: true}).catch(() => {}); });
      $("#closeMenuCards")?.addEventListener("click", closeViewer);
      $("#previousMenuCard")?.addEventListener("click", () => moveViewer(-1));
      $("#nextMenuCard")?.addEventListener("click", () => moveViewer(1));
      $("#menuCardsViewer")?.addEventListener("cancel", (e) => {e.preventDefault(); closeViewer();});
      $("#menuCardsViewer")?.addEventListener("click", (e) => {if (e.target === e.currentTarget) closeViewer();});
      $("#menuCardsViewer")?.addEventListener("keydown", (e) => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); moveViewer(e.key === "ArrowLeft" ? -1 : 1); } });
      $("#menuViewerDots")?.addEventListener("click", (e) => {const b = e.target.closest("[data-menu-view-index]"); if (b) {viewerIndex = Number(b.dataset.menuViewIndex); renderViewer();}});
      $("#menuViewerZoom")?.addEventListener("click", () => zoomViewerAt(zoomScale > 1.01 ? 1 : 2.5));
      bindViewerGestures();
    }
    ctx.refreshIcons();
    syncFeatures();
  };
  return {
    init, enabled, syncFeatures, renderTableSelector, renderFeatureForm, savePendingCards, prepareForTable,
    featurePayload: (form) => Object.fromEntries(Object.keys(features).filter((key) => key !== "client_bill_enabled" || Object.hasOwn(ctx.getBusiness() || {}, key)).map((key) => [key, Boolean(form.elements[key]?.checked)])),
    originalFeaturePayload: (business) => Object.fromEntries(Object.keys(features).filter((key) => key !== "client_bill_enabled" || Object.hasOwn(business || {}, key)).map((key) => [key, business?.[key] !== false])),
    previewBrandAsset: (field, url) => { brandDrafts.set(field, url); const form = $("#businessForm"); if (form) renderBrandAssets(form); },
    clearBrandDrafts: (saved) => {
      for (const [field, value] of brandDrafts) if (saved[field] === value) brandDrafts.delete(field);
      for (const [field, value] of featureDrafts) if (saved[field] === value) featureDrafts.delete(field);
    }
  };
})();
