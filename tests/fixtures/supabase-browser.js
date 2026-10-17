// Sustituye solo la red. Las pruebas ejecutan el HTML, CSS y App.init reales.
(() => {
  const config = window.__testConfig || {};
  const tables = Array.from({length: 65}, (_, i) => ({id: `10000000-0000-4000-8000-${String(i+1).padStart(12, '0')}`, table_number: i+1, table_name: `Mesa de prueba ${i+1}`, qr_code: `mesa-${i+1}`, is_active: true, is_outdoor: i < 20}));
  const business = {is_primary: true, business_name: 'Los Años Maravillosos', subtitle: 'Servicio a la mesa', accent_color: '#f05a28', currency: 'COP', tips_enabled: false, tip_percentage: 10, client_menu_enabled: true, client_bill_enabled: true, client_waiter_enabled: true, client_chat_enabled: true, client_song_enabled: true, ...config.business};
  const categories = ['Cervezas','Aguardientes','Ron','Whisky','Vodka','Tequila','Ginebra','Cocteles','Sin alcohol','Comidas'].map((name,i) => ({id: `category-${i}`, name, sort_order: i, is_active: true}));
  if (config.missingBillColumn) delete business.client_bill_enabled;
  const items = [{id: 'product-1', name: 'Cerveza', price: 5000, is_available: true, category_id: 'category-0', menu_categories: {name: 'Cervezas'}}];
  const sessions = [];
  const requests = [];
  const messages = [];
  const cards = config.cards || [];
  const files = new Map();
  const copy = (data) => data == null ? data : JSON.parse(JSON.stringify(data));
  const log = [];
  window.__mock = {tables, business, categories, items, sessions, requests, cards, log, files, featuresChanged: null};
  const collections = {business_settings: [business], restaurant_tables: tables, menu_categories: categories, menu_items: items, table_sessions: sessions, service_requests: requests, session_items: []};
  const query = (table) => {
    const q = {filters: [], operation: '', value: null, isSingle: false,
      select() {return this;}, order() {return this;}, limit() {return this;}, range() {return this;},
      eq(key, value) {this.filters.push(row => row[key] === value); return this;},
      neq(key, value) {this.filters.push(row => row[key] !== value); return this;},
      in(key, values) {this.filters.push(row => values.includes(row[key])); return this;},
      single() {this.isSingle = true; return this;}, maybeSingle() {this.isSingle = true; return this;},
      update(value) {this.operation = 'update'; this.value = value; return this;},
      upsert(value) {this.operation = 'upsert'; this.value = value; return this;},
      insert(value) {this.operation = 'insert'; this.value = value; return this;},
      delete() {this.operation = 'delete'; return this;},
      then(resolve, reject) {
        try {
          if (table === 'session_items' && this.operation === 'insert') {
            log.push({name:'insert-session-items',at:performance.now()});
            const finish = () => {
              const rows=(Array.isArray(this.value)?this.value:[this.value]).map(v=>({id:crypto.randomUUID(),...v}));
              collections.session_items.push(...rows);
              rows.forEach(row => {const s=sessions.find(s=>s.id===row.session_id);if(s)(s.session_items ||= []).push(row);});
              resolve({data:copy(this.isSingle?rows[0]:rows),error:null});
            };
            if(window.__mock.sessionItemDelay)setTimeout(finish,window.__mock.sessionItemDelay);else finish();
            return;
          }
          if (table === 'business_settings' && this.operation === 'update' && window.__mock.failFeatureKey && Object.hasOwn(this.value, window.__mock.failFeatureKey)) {
            resolve({data:null,error:{message:'Sin conexión de prueba'}});return;
          }
          let rows = collections[table] || [];
          if (this.operation === 'insert') {
            rows = (Array.isArray(this.value) ? this.value : [this.value]).map(v => ({id: crypto.randomUUID(), ...v}));
            (collections[table] ||= []).push(...rows);
          } else if (this.operation === 'upsert') {
            if (table === 'business_settings') {Object.assign(business, this.value); rows = [business];}
          } else {
            rows = rows.filter(r => this.filters.every(f => f(r)));
            if (this.operation === 'update') rows.forEach(row => Object.assign(row, this.value));
          }
          resolve({data: copy(this.isSingle ? rows[0] || null : rows), error: null});
        } catch (e) {reject(e);}
      }
    };
    return q;
  };
  const placeholder = (() => { const c=document.createElement('canvas'); c.width=400;c.height=600;const x=c.getContext('2d');x.fillStyle='#fff0db';x.fillRect(0,0,400,600);x.fillStyle='#65402c';x.font='28px sans-serif';x.fillText('CARTA DEL NEGOCIO',35,70);return c.toDataURL(); })();
  const client = {
    from: query,
    async rpc(name, args) {
      log.push({name, args, at: performance.now()});
      let data = null;
      if (name === 'get_initial_setup_status') {await new Promise(r => setTimeout(r, config.setupDelay || 0)); data = {needs_initial_admin: false};}
      else if (name === 'login') {
        await new Promise(r => setTimeout(r, config.loginDelay || 0));
        if (args.pin === '1234') data = {token: 'test-token', user: {id: 'user-1', full_name: 'Administrador', role: 'boss', permissions: []}};
      } else if (name === 'get_bootstrap_data') data = {business, tables, categories, items};
      else if (name === 'get_admin_snapshot') data = {requests, sessions};
      else if (name === 'list_users') data = [];
      else if (name === 'save_table_zones') {tables.forEach(t => t.is_outdoor = args.outdoor_table_ids.includes(t.id)); data = {ok: true, tables};}
      else if (name === 'list_business_menu_cards') data = cards;
      else if (name === 'save_business_menu_card') {
        if(window.__mock.failCardId===args.p_card_id) return {data:null,error:{message:'Fallo simulado al guardar la carta'}};
        if(window.__mock.cardSaveDelay) await new Promise(r=>setTimeout(r,window.__mock.cardSaveDelay));
        data = {id: args.p_card_id, name: args.p_name, image_path: args.p_image_path, color: args.p_color, table_ids: args.p_table_ids};
        const existing = cards.find(c => c.id === data.id);
        if (existing) Object.assign(existing, data); else cards.push(data);
      } else if (name === 'delete_business_menu_card') {const i = cards.findIndex(c => c.id === args.p_card_id); if (i >= 0) cards.splice(i,1); data = {ok:true};}
      else if (name === 'get_table_menu_cards') {
        if(config.menuDelay) await new Promise(r=>setTimeout(r,config.menuDelay));
        data = business.client_menu_enabled ? cards.filter(c => c.table_ids.includes(args.p_table_id)) : [];
      }
      else if (name === 'get_client_table_state') {
        const table = tables.find(t => t.id === args.table_id);
        let session = sessions.find(s => s.table_id === args.table_id);
        if (!session && args.ensure_session) {session = {id: 'client-session', table_id: args.table_id, status: 'open', session_items: [], restaurant_tables: table}; sessions.push(session);}
        data = {session:session || null, sessionItems: session?.session_items || [], requests:requests.filter(r=>r.session_id===session?.id)};
      } else if (name === 'get_client_snapshot') data = {sessionItems: [], requests: []};
      else if (name === 'list_chat_messages') data = {messages};
      else if (name === 'send_chat_message') {data={message:{id:args.p_message_id,session_id:args.p_session_id,table_id:args.p_table_id,sender_type:args.p_sender_type,body:args.p_body,created_at:new Date().toISOString()}};messages.push(data.message);}
      else if (name === 'create_service_requests_batch' || name === 'create_service_request') {
        const results=(args.requests || [args]).map(request => {
          let session=sessions.find(s=>s.table_id===request.table_id && s.status==='open');
          if(!session){session={id:crypto.randomUUID(),table_id:request.table_id,status:'open',opened_at:new Date().toISOString(),session_items:[],restaurant_tables:tables.find(t=>t.id===request.table_id)};sessions.push(session);}
          const saved={id:request.request_id,table_id:request.table_id,session_id:session.id,request_type:request.request_type,message:request.message || '',status:'pending',created_at:new Date().toISOString(),restaurant_tables:session.restaurant_tables};
          requests.push(saved);return {request:saved,duplicate:false};
        });
        data=name==='create_service_requests_batch'?{results}:results[0];
      }
      if(name==='get_client_table_state' && window.__mock.tableStateDelay) await new Promise(r=>setTimeout(r,window.__mock.tableStateDelay));
      return {data: copy(data), error: null};
    },
    storage: {from(bucket) {return {
      async upload(name, file) {files.set(name,file); return {data:{path:name},error:null};},
      async createSignedUrl(name) {log.push({name:'signed-image', path:name});if(config.imageSignDelay)await new Promise(r=>setTimeout(r,config.imageSignDelay));return {data:{signedUrl:files.has(name) ? URL.createObjectURL(files.get(name)) : placeholder},error:null};},
      async remove(names) {names.forEach(n => files.delete(n)); return {data:[],error:null};},
      getPublicUrl(name) {return {data:{publicUrl:files.has(name) ? URL.createObjectURL(files.get(name)) : placeholder}};}
    };}},
    channel(name) {return {
      on(type, filter, handler) {
        if(name==='business-menu-card-updates' && type==='broadcast')window.__mock.menuCardsChanged=handler;
        if (type === 'postgres_changes' && filter.table === 'business_settings') window.__mock.featuresChanged = handler;
        if (name.startsWith('table:') && type==='broadcast' && filter.event==='refresh') window.__mock.tableRefresh=handler;
        return this;
      },
      subscribe(handler) {if(name==='admin' && handler) window.__mock.adminConnectionStatus=handler;return this;}, send() {return Promise.resolve('ok');}, unsubscribe() {return Promise.resolve();}
    };},
    removeChannel() {}
  };
  window.supabase = {createClient: () => client};
  // Evita sonidos, solicitudes externas y registro del service worker en las pruebas.
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  if (navigator.serviceWorker) navigator.serviceWorker.register = async () => {throw new Error('disabled in test');};
  window.lucide = {createIcons() {window.__iconRuns = (window.__iconRuns || 0)+1;}};
  window.print = () => {window.__printedAt = Date.now(); window.__printCalls = (window.__printCalls || 0) + 1;};
})();
