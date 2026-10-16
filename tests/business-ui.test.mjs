import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {chromium} from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(os.tmpdir(), 'codex-maravillosos-ui');
const fixture = await fs.readFile(new URL('./fixtures/supabase-browser.js', import.meta.url), 'utf8');
const app = (await fs.readFile(path.join(root,'app.js'), 'utf8')).replace('return { init };', 'return { init, state, openConsumptionDialog, editConsumption, renderTableConsumptionPreview, renderBusinessForm, showAdminSection, printThermalReceipt, refreshIcons, renderBrand, activateSongRequestMode, hydrateSelectedTable, renderTables, renderAccounts, renderAdminShell };') + '\nwindow.__app = App;';
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const name = url.pathname === '/' ? 'admin.html' : decodeURIComponent(url.pathname.slice(1));
    const absolute = path.resolve(root,name);
    if (!absolute.startsWith(root + path.sep)) {res.writeHead(403); res.end(); return;}
    let body = name === 'app.js' ? app : await fs.readFile(absolute);
    const ext = path.extname(name);
    const type = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.mp3':'audio/mpeg'}[ext] || 'application/octet-stream';
    if (ext === '.html') body = body.toString().replace(/<script src="https:[^"]+"><\/script>/g, '');
    res.writeHead(200, {'Content-Type':type}); res.end(body);
  } catch {res.writeHead(404);res.end();}
});

test('Marca, cartas, consumo y respuesta al clic en navegador', async (t) => {
  await fs.mkdir(artifacts,{recursive:true});
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {try {await fs.access(candidate); executablePath=candidate;break;}catch {}}
  assert(executablePath, 'Configura CHROME_PATH para ejecutar las pruebas de navegador.');
  const browser = await chromium.launch({executablePath, headless:true});
  const makePage = async (config = {}, size = {width:1440,height:1000}, options = {}) => {
    const context = await browser.newContext({viewport:size,...options});
    await context.addInitScript((value) => {window.__testConfig = value;}, config);
    await context.addInitScript({content:fixture});
    await context.route('**/*', route => route.request().url().startsWith(origin)
      ? route.continue() : route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{ok:true, version:'2.10.0', items:[], records:[], movements:[], totals:{}, summary:{}}}));
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.errors = [];
    page.on('pageerror', e => {page.errors.push(e.message); console.error('Browser error:',e.message);});
    return page;
  };
  let admin;
  try {
    await t.test('el login no espera la consulta inicial y confirma el clic al instante', async () => {
      admin = await makePage({setupDelay:1500, loginDelay:50});
      await admin.goto(`${origin}/admin.html#brand`,{waitUntil:'domcontentloaded'});
      await admin.locator('#loginForm [name=username]').fill('prueba');
      await admin.locator('#loginForm [name=pin]').fill('1234');
      const response = await admin.evaluate(() => {
        const start = performance.now();
        document.querySelector('#loginSubmit').click();
        return {ms:performance.now()-start, disabled:document.querySelector('#loginSubmit').disabled, message:document.querySelector('#loginSubmit').textContent};
      });
      assert(response.disabled); assert.match(response.message,/Entrando/); assert(response.ms < 100, `Respuesta ${response.ms} ms`);
      await admin.waitForFunction(() => document.body.classList.contains('admin-authenticated'));
      assert(await admin.evaluate(() => __mock.log.find(c => c.name==='login').at - __mock.log.find(c => c.name==='get_initial_setup_status').at < 1500));
      await admin.waitForFunction(() => document.querySelector('#menuCardImageFile')?.disabled === false);
      assert.equal(await admin.locator('.client-features-card').count(),1);
      assert.equal(await admin.locator('.client-features-card [role=switch]').count(),5);
      const width = await admin.evaluate(() => ({features:document.querySelector('.client-features-card').getBoundingClientRect().width, form:document.querySelector('#businessForm').getBoundingClientRect().width}));
      assert(Math.abs(width.features-width.form)<2, 'Los cinco switches deben compartir un contenedor de ancho completo');
      assert.equal(await admin.locator('#menuLibraryCount').textContent(),'0/5');
      assert.deepEqual(admin.errors, []);
    });
    await t.test('biblioteca de tres imágenes: nombres, colores y mesas independientes', async () => {
      const png = await admin.evaluate(() => {const c=document.createElement('canvas');c.width=400;c.height=600;const x=c.getContext('2d');x.fillStyle='#fff0db';x.fillRect(0,0,400,600);x.fillStyle='#65402c';x.font='28px sans-serif';x.fillText('CARTA DEL NEGOCIO',35,70);return c.toDataURL().split(',')[1];});
      const image = Buffer.from(png,'base64');
      await admin.locator('#menuCardImageFile').setInputFiles(['Carta afuera','Carta adentro','Carta comidas'].map(name => ({name:`${name}.png`,mimeType:'image/png',buffer:image})));
      await admin.waitForFunction(() => document.querySelector('#menuLibraryCount').textContent === '3/5');
      await admin.waitForFunction(() => !document.querySelector('#saveMenuCard').disabled);
      assert.equal(await admin.locator('#menuLibraryStack .menu-library-card').count(),3);
      assert(await admin.locator('#menuCardsEditor').isVisible());
      await admin.locator('[data-card-assign=all]').click();
      assert.equal(await admin.locator('[data-menu-card-table]:checked').count(),65);
      await admin.getByRole('button',{name:'Carta afuera',exact:true}).click();
      await admin.locator('[data-card-assign=outdoor]').click();
      await admin.locator('[data-card-color=blue]').click();
      await admin.getByRole('button',{name:'Carta adentro',exact:true}).click();
      await admin.locator('[data-card-assign=indoor]').click();
      await admin.locator('[data-card-color=violet]').click();
      await admin.locator('#saveMenuCard').click();
      await admin.waitForFunction(() => __mock.cards.find(c => c.name==='Carta comidas')?.table_ids.length===65);
      assert.equal(await admin.evaluate(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length),20,'Guardar debe aplicar también las cartas configuradas en otras pestañas');
      await admin.waitForFunction(() => __mock.cards.find(c => c.name==='Carta adentro')?.table_ids.length===45);
      assert.equal(await admin.locator('[data-menu-card-table]:checked').count(),45);
      assert.equal(await admin.locator('.menu-card-table-selector').getAttribute('data-color'),'violet');
      const before = await admin.evaluate(() => JSON.stringify(__mock.tables.map(t=>t.is_outdoor)));
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      assert.equal(await admin.evaluate(() => JSON.stringify(__mock.tables.map(t=>t.is_outdoor))),before);
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      await admin.screenshot({path:path.join(artifacts,'marca-desktop.png'),fullPage:true});
      assert.deepEqual(admin.errors, []);
    });
    await t.test('Guardar configuración guarda las asignaciones pendientes de todas las cartas', async () => {
      await admin.getByRole('button',{name:'Carta afuera',exact:true}).click();
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      await admin.getByRole('button',{name:'Carta adentro',exact:true}).click();
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      await admin.locator('#businessForm > button[type=submit]').click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===19 && __mock.cards.find(c=>c.name==='Carta adentro').table_ids.length===46);
      await admin.waitForFunction(()=>!document.querySelector('#businessForm > button[type=submit]').disabled);
      // Restaura ambas selecciones usando otra vez un único guardado general.
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      await admin.getByRole('button',{name:'Carta afuera',exact:true}).click();
      await admin.locator('[data-menu-card-table]').first().locator('..').click();
      await admin.locator('#businessForm > button[type=submit]').click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===20 && __mock.cards.find(c=>c.name==='Carta adentro').table_ids.length===45);
      await admin.waitForFunction(()=>!document.querySelector('#businessForm > button[type=submit]').disabled);
      assert.deepEqual(admin.errors,[]);
    });
    await t.test('marcar mesas guarda y verifica automáticamente; un fallo conserva la selección', async () => {
      const first=()=>admin.locator('[data-menu-card-table]').first().locator('..');
      await admin.getByRole('button',{name:'Carta afuera',exact:true}).click();
      await first().click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===19 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      assert.match(await admin.locator('#menuCardsStatus').textContent(),/verificadas/);
      await first().click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===20 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      await admin.evaluate(()=>{__mock.failCardId=__mock.cards.find(c=>c.name==='Carta afuera').id;});
      await first().click();
      await admin.waitForFunction(()=>document.querySelector('#menuCardsStatus').classList.contains('is-error'));
      assert.equal(await admin.evaluate(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length),20);
      assert.equal(await admin.evaluate(()=>JSON.parse(localStorage.getItem('maravillosos-menu-card-drafts'))[0].table_ids.length),19);
      await admin.evaluate(()=>{delete __mock.failCardId;});
      await admin.locator('#saveMenuCard').click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===19 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      await first().click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===20 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      assert.deepEqual(admin.errors,[]);
    });
    await t.test('editar mesas durante un guardado lento conserva la última selección', async () => {
      await admin.evaluate(()=>{__mock.cardSaveDelay=350;});
      await admin.getByRole('button',{name:'Carta afuera',exact:true}).click();
      const before=await admin.evaluate(()=>__mock.log.filter(l=>l.name==='save_business_menu_card').length);
      await admin.locator('[data-menu-card-table]').nth(0).locator('..').click();
      await admin.waitForFunction(count=>__mock.log.filter(l=>l.name==='save_business_menu_card').length>count,before);
      await admin.locator('[data-menu-card-table]').nth(1).locator('..').click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===18 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      await admin.locator('[data-menu-card-table]').nth(0).locator('..').click();
      await admin.locator('[data-menu-card-table]').nth(1).locator('..').click();
      await admin.waitForFunction(()=>__mock.cards.find(c=>c.name==='Carta afuera').table_ids.length===20 && !localStorage.getItem('maravillosos-menu-card-drafts'));
      await admin.evaluate(()=>{delete __mock.cardSaveDelay;});
      assert.deepEqual(admin.errors,[]);
    });
    await t.test('los cinco interruptores guardan valores separados y sobreviven al render', async () => {
      for (const name of ['client_menu_enabled','client_bill_enabled','client_waiter_enabled','client_chat_enabled','client_song_enabled']) await admin.locator(`[name=${name}]`).locator('..').click();
      await admin.evaluate(() => __app.renderBusinessForm());
      assert.equal(await admin.locator('.client-features-card input:checked').count(),0);
      await admin.locator('#businessForm > button[type=submit]').click();
      await admin.waitForFunction(() => __mock.business.client_menu_enabled === false && __mock.business.client_bill_enabled === false && __mock.business.client_waiter_enabled === false && __mock.business.client_chat_enabled === false && __mock.business.client_song_enabled === false);
      await admin.waitForFunction(() => !document.querySelector('#businessForm > button[type=submit]').disabled);
      assert.equal(await admin.evaluate(() => __app.state.business.client_chat_enabled),false);
      await admin.evaluate(() => {__mock.failFeatureKey='client_menu_enabled';});
      await admin.locator('[name=client_menu_enabled]').locator('..').click();
      await admin.waitForFunction(() => !document.querySelector('[name=client_menu_enabled]').disabled);
      assert.equal(await admin.locator('[name=client_menu_enabled]').isChecked(),false, 'Un cambio fallido debe restaurar el interruptor');
      await admin.evaluate(() => {delete __mock.failFeatureKey;});
      assert.deepEqual(admin.errors, []);
    });
    await t.test('el visor muestra solo precios de su mesa y comidas; navegación, zoom y X', async () => {
      const cards = await admin.evaluate(() => __mock.cards);
      const client = await makePage({cards});
      await client.goto(`${origin}/index.html?mesa=mesa-21`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(() => __app.state.currentTable?.table_number === 21);
      await client.locator('#openMenuCards').click();
      await client.waitForFunction(() => document.querySelector('#menuViewerCounter').textContent==='1 de 2');
      await client.waitForFunction(() => document.querySelector('#menuViewerImage').naturalWidth > 0);
      await client.waitForFunction(()=>document.querySelector('#openMenuCards').dataset.menuReady==='true');
      assert.equal(await client.evaluate(() => __mock.log.filter(l=>l.name==='signed-image').length),2, 'Las dos cartas de la mesa deben prepararse en segundo plano');
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta adentro');
      assert.equal(await client.locator('#menuViewerDots button').count(),2);
      await client.locator('#nextMenuCard').click();
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta comidas');
      await client.locator('#menuViewerZoom').click();
      await client.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
      await client.locator('#previousMenuCard').click();
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta adentro');
      await client.clock.setFixedTime(new Date(Date.now()+6*60*1000));
      await client.locator('#nextMenuCard').click();
      assert.equal(await client.evaluate(()=>__mock.log.filter(l=>l.name==='signed-image').length),2,'La imagen ya descargada no debe volver a pedirse al navegar');
      const images = await client.evaluate(() => __mock.log.filter(l=>l.name==='signed-image').map(l=>l.path));
      assert(!images.includes(cards.find(c=>c.name==='Carta afuera').image_path));
      await client.screenshot({path:path.join(artifacts,'carta-desktop.png')});
      await client.locator('#closeMenuCards').click();
      assert.equal(await client.locator('#menuCardsViewer').evaluate(d=>d.open),false);
      await client.evaluate(() => {
        Object.assign(__mock.business,{client_menu_enabled:false,client_bill_enabled:false,client_waiter_enabled:false,client_chat_enabled:false,client_song_enabled:false});
        __mock.featuresChanged({new:{...__mock.business}});
      });
      assert(await client.locator('#openMenuCards').isHidden());
      assert(await client.locator('[data-request=bill]').isHidden());
      assert(await client.locator('[data-request=waiter]').isHidden());
      assert(await client.locator('#clientChatSection').isHidden());
      assert(await client.locator('#songModeToggle').isHidden());
      // Canción y chat funcionan por separado: no aparece el chat de pedidos al habilitar solo música.
      await client.evaluate(() => {__mock.business.client_song_enabled=true;__mock.featuresChanged({new:{...__mock.business}});});
      assert(await client.locator('#clientChatSection').isHidden());
      await client.locator('#songModeToggle').click();
      assert(await client.locator('#clientChatSection').isVisible());
      assert.equal(await client.locator('#assistantTitle').textContent(),'Pide una canción');
      assert.deepEqual(client.errors, []);
      await client.context().close();
    });
    await t.test('cartas precargadas: abrir y cambiar de imagen no inicia solicitudes ni descargas', async () => {
      const client=await makePage({cards:await admin.evaluate(()=>__mock.cards),menuDelay:250,imageSignDelay:250},{width:390,height:844});
      try {
        await client.goto(`${origin}/index.html?mesa=mesa-21`,{waitUntil:'domcontentloaded'});
        await client.waitForFunction(()=>document.querySelector('#openMenuCards').dataset.menuReady==='true');
        const count=await client.evaluate(()=>__mock.log.length);
        const opened=await client.evaluate(()=>{
          const start=performance.now();document.querySelector('#openMenuCards').click();
          const image=document.querySelector('#menuViewerImage');
          return {ms:performance.now()-start,ready:!image.hidden && image.complete && image.naturalWidth>0,counter:document.querySelector('#menuViewerCounter').textContent};
        });
        assert(opened.ready);assert.equal(opened.counter,'1 de 2');
        assert(opened.ms<80,`Apertura de la carta preparada: ${opened.ms} ms`);
        assert.equal(await client.evaluate(()=>__mock.log.length),count);
        const next=await client.evaluate(()=>{
          const start=performance.now();document.querySelector('#nextMenuCard').click();
          const image=document.querySelector('#menuViewerImage');
          return {ms:performance.now()-start,ready:!image.hidden && image.complete,counter:document.querySelector('#menuViewerCounter').textContent};
        });
        assert(next.ready);assert.equal(next.counter,'2 de 2');assert(next.ms<80);
        assert.equal(await client.evaluate(()=>__mock.log.length),count);
        await client.locator('#closeMenuCards').click();
        await client.locator('#openMenuCards').click();
        assert(await client.locator('#menuViewerImage').isVisible());
        assert.equal(await client.evaluate(()=>__mock.log.filter(l=>l.name==='signed-image').length),2);
        t.diagnostic(`Carta precargada: abrir ${opened.ms.toFixed(1)} ms; cambiar ${next.ms.toFixed(1)} ms, sin solicitudes nuevas`);
        assert.deepEqual(client.errors,[]);
      } finally {await client.context().close();}
    });
    await t.test('una mesa que tenía solo Comidas recibe la segunda carta al guardar la asignación', async () => {
      const cards=await admin.evaluate(()=>__mock.cards);
      const insideId='10000000-0000-4000-8000-000000000021';
      cards.find(c=>c.name==='Carta adentro').table_ids=cards.find(c=>c.name==='Carta adentro').table_ids.filter(id=>id!==insideId);
      const client=await makePage({cards},{width:390,height:844});
      try {
        await client.goto(`${origin}/index.html?mesa=mesa-21`,{waitUntil:'domcontentloaded'});
        await client.waitForFunction(()=>document.querySelector('#openMenuCards').dataset.menuReady==='true');
        await client.locator('#openMenuCards').click();
        assert.equal(await client.locator('#menuViewerCounter').textContent(),'1 de 1');
        assert(await client.locator('#nextMenuCard').isHidden());
        await client.evaluate(id=>{
          __mock.cards.find(c=>c.name==='Carta adentro').table_ids.push(id);
          __mock.menuCardsChanged({payload:{updatedAt:Date.now()}});
        },insideId);
        await client.waitForFunction(()=>document.querySelector('#menuViewerCounter').textContent==='2 de 2' && document.querySelector('#openMenuCards').dataset.menuReady==='true');
        assert(await client.locator('#nextMenuCard').isVisible());assert(await client.locator('#previousMenuCard').isVisible());
        await client.locator('#previousMenuCard').click();
        assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta adentro');
        assert(await client.locator('#menuViewerImage').isVisible());
        const paths=await client.evaluate(()=>__mock.log.filter(l=>l.name==='signed-image').map(l=>l.path));
        assert(!paths.includes(cards.find(c=>c.name==='Carta afuera').image_path));
        assert.deepEqual(client.errors,[]);
      } finally {await client.context().close();}
    });
    await t.test('el visor móvil conserva la interfaz y la biblioteca se limita a cinco imágenes', async () => {
      const client = await makePage({cards:await admin.evaluate(() => __mock.cards)}, {width:390,height:844});
      await client.goto(`${origin}/index.html?mesa=mesa-1`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(() => __app.state.currentTable?.table_number===1);
      await client.locator('#openMenuCards').click();
      await client.waitForFunction(() => document.querySelector('#menuViewerCounter').textContent==='1 de 2');
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta afuera');
      await client.locator('#nextMenuCard').click();
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta comidas');
      await client.waitForFunction(()=>!document.querySelector('#menuViewerImage').hidden);
      await client.screenshot({path:path.join(artifacts,'carta-mobile.png')});
      for (const size of [{width:320,height:568},{width:390,height:844},{width:430,height:932},{width:844,height:390}]) {
        await client.setViewportSize(size);
        await client.evaluate(()=>{document.querySelector('#menuViewerTitle').textContent='Carta de bebidas y comidas especiales para las mesas de afuera del negocio';});
        const fit=await client.evaluate(()=>{
          const dialog=document.querySelector('#menuCardsViewer');
          const bounds=dialog.getBoundingClientRect();
          const inside=element=>{
            const r=element.getBoundingClientRect();
            return r.left>=bounds.left && r.right<=bounds.right+1 && r.top>=bounds.top && r.bottom<=bounds.bottom+1;
          };
          const arrows=[...document.querySelectorAll('.menu-viewer-arrow')].map(button=>{
            const r=button.getBoundingClientRect();
            const svg=button.querySelector('svg');
            const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
            return !button.hidden && inside(button) && r.width>=44 && r.height>=44 && svg?.getBoundingClientRect().width>20 && svg.querySelector('path') && button.contains(hit);
          }).map(Boolean);
          return {fits:bounds.left>=4 && bounds.top>=4 && bounds.right<=innerWidth-4 && bounds.bottom<=innerHeight-4,
            content:[...document.querySelectorAll('#menuViewerImage,.menu-viewer-head,.menu-viewer-footer,#closeMenuCards')].every(inside),
            scroll:dialog.scrollWidth<=dialog.clientWidth+1 && dialog.scrollHeight<=dialog.clientHeight+1,arrows};
        });
        assert(fit.fits && fit.content && fit.scroll,`El visor debe caber en ${size.width}×${size.height}: ${JSON.stringify(fit)}`);
        assert(fit.arrows.every(Boolean),'Las dos flechas deben verse y poder pulsarse sin depender de Lucide');
        await client.locator('#previousMenuCard').click();
        assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta afuera');
        await client.locator('#nextMenuCard').click();
        assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta comidas');
      }
      const requestedImages=await client.evaluate(()=>__mock.log.filter(l=>l.name==='signed-image').map(l=>l.path));
      assert(!requestedImages.includes((await admin.evaluate(()=>__mock.cards.find(c=>c.name==='Carta adentro'))).image_path));
      await client.keyboard.press('Escape');
      assert.equal(await client.locator('#menuCardsViewer').evaluate(d=>d.open),false);
      assert.equal(new URL(client.url()).pathname,'/index.html');
      await client.context().close();
      const png = await admin.evaluate(() => {const c=document.createElement('canvas');c.width=80;c.height=120;return c.toDataURL().split(',')[1];});
      const chooserReady=admin.waitForEvent('filechooser');
      await admin.locator('#menuLibraryStack .menu-library-card[style*="--card-depth:6"] img').click();
      const chooser=await chooserReady;
      await chooser.setFiles(['Carta cuatro','Carta cinco'].map(name=>({name:`${name}.png`,mimeType:'image/png',buffer:Buffer.from(png,'base64')})));
      await admin.waitForFunction(() => document.querySelector('#menuLibraryCount').textContent==='5/5' && !document.querySelector('#deleteMenuCard').disabled);
      assert(await admin.locator('#menuCardImageFile').isDisabled());
      assert.equal(await admin.locator('#menuLibraryProgress').getAttribute('value'),'5');
      await admin.locator('#deleteMenuCard').click();
      await admin.locator('#actionConfirmAccept').click();
      await admin.waitForFunction(() => document.querySelector('#menuLibraryCount').textContent==='4/5');
      assert(await admin.locator('#menuCardImageFile').isEnabled());
      await admin.setViewportSize({width:390,height:844});
      await admin.screenshot({path:path.join(artifacts,'marca-mobile.png'),fullPage:true});
      assert(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1), 'Marca no debe desbordarse en móvil');
      await admin.setViewportSize({width:1440,height:1000});
    });
    await t.test('zoom libre con rueda, arrastre, pellizco y doble toque para restablecer; X roja visible', async () => {
      const client=await makePage({cards:await admin.evaluate(()=>__mock.cards)},{width:390,height:844},{hasTouch:true});
      await client.goto(`${origin}/index.html?mesa=mesa-21`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(()=>__app.state.currentTable?.table_number===21);
      await client.locator('#openMenuCards').click();
      await client.waitForFunction(()=>!document.querySelector('#menuViewerImage').hidden);
      const closeStyle=await client.locator('#closeMenuCards').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,stroke:el.querySelector('svg').getAttribute('stroke-width')}));
      assert.deepEqual(closeStyle,{background:'rgb(220, 38, 38)',color:'rgb(255, 255, 255)',stroke:'3.5'});
      const bounds=await client.locator('#menuViewerImageWrap').boundingBox();
      const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
      await client.mouse.move(x,y);await client.mouse.wheel(0,-600);
      await client.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
      const transform=()=>{const m=new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#menuViewerImage')).transform);return {scale:m.a,x:m.m41,y:m.m42};};
      const before=await client.evaluate(transform);assert(before.scale>2);
      await client.mouse.move(x,y);await client.mouse.down();await client.mouse.move(x+55,y-70,{steps:6});await client.mouse.up();
      const after=await client.evaluate(transform);
      assert(Math.abs(after.x-before.x)>30 && Math.abs(after.y-before.y)>40,'El zoom debe permitir desplazarse horizontal y verticalmente');
      assert.equal(await client.locator('#menuViewerTitle').textContent(),'Carta adentro');
      await client.mouse.dblclick(x,y);
      await client.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='false');
      const cdp=await client.context().newCDPSession(client);
      const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,px,py])=>({id,x:px,y:py,radiusX:1,radiusY:1,force:1}))});
      await touch('touchStart',[[1,x-35,y],[2,x+35,y]]);
      await touch('touchMove',[[1,x-100,y-20],[2,x+100,y+20]]);
      await touch('touchEnd',[]);
      await client.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='true');
      assert((await client.evaluate(transform)).scale>2,'El pellizco debe ampliar la imagen');
      await client.screenshot({path:path.join(artifacts,'carta-zoom-mobile.png')});
      for(let i=0;i<2;i++){await touch('touchStart',[[1,x,y]]);await touch('touchEnd',[]);}
      await client.waitForFunction(()=>document.querySelector('#menuViewerZoom').getAttribute('aria-pressed')==='false');
      assert.deepEqual(await client.evaluate(transform),{scale:1,x:0,y:0});
      await client.screenshot({path:path.join(artifacts,'carta-restablecida-mobile.png')});
      await client.locator('#closeMenuCards').click();
      assert.equal(await client.locator('#menuCardsViewer').evaluate(el=>el.open),false);
      assert.deepEqual(client.errors,[]);await client.context().close();
    });
    await t.test('Ver cuenta se puede desactivar, cierra la cuenta visible y se puede volver a activar', async () => {
      const client=await makePage();
      try {
        await client.goto(`${origin}/index.html?mesa=mesa-21`,{waitUntil:'domcontentloaded'});
        await client.waitForFunction(()=>__app.state.tableAccountStatus==='empty');
        await client.locator('[data-request=bill]').click();
        await client.waitForFunction(()=>document.body.classList.contains('receipt-open'));
        await client.evaluate(()=>{__mock.business.client_bill_enabled=false;__mock.featuresChanged({new:{...__mock.business}});});
        assert(await client.locator('[data-request=bill]').isHidden());
        assert(await client.locator('#billChat').isHidden());
        assert.equal(await client.evaluate(()=>document.body.classList.contains('receipt-open')),false);
        const blocked=await client.evaluate(()=>{
          const before=__mock.log.length;document.querySelector('[data-request=bill]').click();
          return {calls:__mock.log.length-before,open:__app.state.localBillOpen};
        });
        assert.deepEqual(blocked,{calls:0,open:false});
        assert(await client.locator('[data-request=waiter]').isVisible());
        await client.evaluate(()=>{__mock.business.client_bill_enabled=true;__mock.featuresChanged({new:{...__mock.business}});});
        assert(await client.locator('[data-request=bill]').isVisible());
        await client.locator('[data-request=bill]').click();
        await client.waitForFunction(()=>document.body.classList.contains('receipt-open'));
        assert.deepEqual(client.errors,[]);
      } finally {await client.context().close();}
    });
    await t.test('escanear, solicitar y conversar no ocupa la mesa ni abre una cuenta de consumo', async () => {
      const client=await makePage();
      await client.goto(`${origin}/index.html?mesa=mesa-1`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(() => __app.state.tableAccountStatus==='empty');
      assert.equal(await client.evaluate(() => __mock.sessions.length),0);
      assert(await client.evaluate(() => __mock.log.filter(l=>l.name==='get_client_table_state').every(l=>l.args.ensure_session===false)));
      await client.locator('[data-request=waiter]').click();
      await client.waitForFunction(() => __mock.requests.length===1);
      await client.evaluate(() => __app.hydrateSelectedTable(__app.state.currentTable.id));
      await client.locator('#assistantInput').fill('Hola, necesito atención');
      await client.locator('#assistantForm button[type=submit]').click();
      await client.waitForFunction(() => __mock.log.some(l=>l.name==='send_chat_message'));
      const data=await client.evaluate(() => ({sessions:__mock.sessions,requests:__mock.requests}));
      await admin.evaluate(data => {
        __app.state.sessions=data.sessions;__app.state.requests=data.requests;
        __app.renderTables();__app.renderAccounts();__app.renderAdminShell();
      },data);
      const table=admin.locator('#tablesGrid [data-open-table]').first();
      assert.match(await table.getAttribute('class'),/\bfree\b/);
      assert(!/occupied|needs-attention/.test(await table.getAttribute('class')));
      assert.equal(await table.locator('small').textContent(),'Libre');
      assert.equal(await admin.locator('#metricOpen').textContent(),'0');
      assert.equal(await admin.locator('#accountsPanel [data-view-account]').count(),0);
      // Una petición de producto pendiente tampoco es consumo confirmado por el personal.
      await admin.evaluate(() => {__app.state.sessions[0].session_items=[{id:'pending-request',item_name:'Cerveza',quantity:1,unit_price:5000,status:'pending'}];__app.renderTables();__app.renderAdminShell();});
      assert.match(await table.getAttribute('class'),/\bfree\b/);
      assert.equal(await admin.locator('#metricOpen').textContent(),'0');
      await client.context().close();
    });
    await t.test('una mesa escaneada sin sesión recibe el consumo que después registra el personal', async () => {
      const client=await makePage();
      await client.goto(`${origin}/index.html?mesa=mesa-2`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(()=>__app.state.tableAccountStatus==='empty' && typeof __mock.tableRefresh==='function');
      assert.equal(await client.evaluate(()=>__mock.sessions.length),0);
      await client.evaluate(async()=>{
        const table=__mock.tables[1];
        __mock.sessions.push({id:'staff-opened-session',table_id:table.id,status:'open',session_items:[{id:'staff-line',quantity:2,unit_price:5000,status:'served'}]});
        await __mock.tableRefresh();
      });
      assert.equal(await client.evaluate(()=>__app.state.currentSession.id),'staff-opened-session');
      assert.equal(await client.evaluate(()=>__app.state.tableAccountStatus),'active');
      assert.equal(await client.evaluate(()=>__app.state.tableAccountTotal),10000);
      assert.deepEqual(client.errors,[]);
      await client.context().close();
    });
    await t.test('una lectura lenta del QR no borra una conversación recién iniciada', async () => {
      const client=await makePage();
      await client.goto(`${origin}/index.html?mesa=mesa-3`,{waitUntil:'domcontentloaded'});
      await client.waitForFunction(()=>__app.state.tableAccountStatus==='empty');
      await client.evaluate(()=>{__mock.tableStateDelay=500;window.__pendingHydration=__app.hydrateSelectedTable(__app.state.currentTable.id,{background:true});});
      await client.locator('#assistantInput').fill('Hola');
      await client.locator('#assistantForm button[type=submit]').click();
      await client.waitForFunction(()=>__app.state.currentSession?.id);
      const sessionId=await client.evaluate(()=>__app.state.currentSession.id);
      await client.evaluate(()=>window.__pendingHydration);
      assert.equal(await client.evaluate(()=>__app.state.currentSession?.id),sessionId);
      assert.equal(await client.evaluate(()=>__app.state.tableAccountStatus),'empty');
      assert.deepEqual(client.errors,[]);
      await client.context().close();
    });
    await t.test('consumo: desglose al lado, edición sin cerrarlo y versión móvil', async () => {
      await admin.evaluate(() => {
        const table=__app.state.tables[0];
        const session={id:'session-consumption',table_id:table.id,restaurant_tables:table,status:'open',opened_at:new Date().toISOString(),session_items:[{id:'line-1',item_name:'Cerveza',menu_item_id:'product-1',quantity:2,unit_price:5000,status:'served',created_at:new Date().toISOString()}]};
        __app.state.sessions=[session];__mock.sessions.splice(0,__mock.sessions.length,session);
        __app.openConsumptionDialog(session.id);
      });
      assert(await admin.locator('#tableConsumptionPreview').isVisible());
      const layout=await admin.locator('#consumptionLayout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.equal(layout,2);
      assert(await admin.locator('#consumptionDialog').evaluate(el=>{
        const rect=el.getBoundingClientRect();
        return rect.width>=innerWidth*.88 && rect.width<=innerWidth*.91 && Math.abs(rect.left-(innerWidth-rect.right))<2 && rect.height<=innerHeight*.93;
      }));
      const priceBesideName=()=>{
        const row=document.querySelector('[data-consumption-item="line-1"]');
        const name=row.querySelector('.table-consumption-item > span').getBoundingClientRect();
        const price=row.querySelector('strong').getBoundingClientRect();
        return price.left>=name.right && Math.abs(price.top-name.top)<4;
      };
      assert(await admin.evaluate(priceBesideName),'El precio debe quedar a la derecha del nombre');
      await admin.locator('[data-consumption-item=line-1]').click();
      assert(await admin.locator('#tableConsumptionPreview').isVisible());
      assert.equal(await admin.locator('#consumptionForm [name=session_item_id]').inputValue(),'line-1');
      assert.equal(await admin.locator('#consumptionForm [name=quantity]').inputValue(),'2');
      assert(await admin.locator('#consumptionQueueButton').isHidden());
      await admin.screenshot({path:path.join(artifacts,'consumo-desktop.png')});
      await admin.locator('#consumptionDialog [data-cancel-consumption]').first().click();
      await admin.setViewportSize({width:390,height:844});
      await admin.evaluate(() => __app.openConsumptionDialog('session-consumption'));
      assert(await admin.locator('#tableConsumptionPreview').isHidden());
      await admin.locator('#viewTableConsumption').click();
      assert(await admin.locator('#tableConsumptionPreview').isVisible());
      assert(await admin.evaluate(priceBesideName),'El precio también debe quedar al lado en móvil');
      await admin.screenshot({path:path.join(artifacts,'consumo-mobile.png')});
      await admin.locator('#consumptionDialog [data-cancel-consumption]').first().click();
      await admin.setViewportSize({width:1440,height:1000});
      assert.deepEqual(admin.errors, []);
    });
    await t.test('seleccionar con Enter y confirmar con doble espacio no duplica el consumo', async () => {
      await admin.evaluate(() => {__mock.sessionItemDelay=200;});
      await admin.evaluate(() => __app.openConsumptionDialog('session-consumption'));
      await admin.locator('#consumptionProductSearch').fill('Cerveza');
      await admin.locator('[data-consumption-product]').first().click();
      await admin.locator('#consumptionForm [name=quantity]').fill('3');
      await admin.locator('#consumptionForm [name=quantity]').press('Enter');
      assert.equal(await admin.locator('#consumptionSelectionCount').textContent(),'1 producto');
      await admin.locator('#consumptionProductSearch').focus();
      await admin.evaluate(() => {
        window.__flashStartedAt=0;window.__consumptionClosedAt=0;
        document.querySelector('#tableConsumptionPreview').addEventListener('animationstart',e=>{if(e.animationName==='consumptionAddedPulse')window.__flashStartedAt=performance.now();},{once:true});
        document.querySelector('#consumptionDialog').addEventListener('close',()=>{window.__consumptionClosedAt=performance.now();},{once:true});
      });
      await admin.keyboard.press('Space');
      await admin.keyboard.press('Space');
      assert(await admin.locator('#consumptionDialog').evaluate(el=>el.open));
      await admin.waitForFunction(() => document.querySelector('#tableConsumptionPreview .consumption-just-added'));
      const heartbeat=await admin.evaluate(async()=>{const start=performance.now();await new Promise(r=>setTimeout(r,20));return performance.now()-start;});
      assert(heartbeat<150,'La animación no debe bloquear el hilo de la interfaz');
      await admin.waitForFunction(() => !document.querySelector('#consumptionDialog').open);
      const inserted = await admin.evaluate(() => __app.state.sessions.find(s=>s.id==='session-consumption').session_items);
      assert.equal(inserted.filter(i=>i.quantity===3).length,1);
      assert.equal(inserted.reduce((n,i)=>n+Number(i.quantity),0),5);
      const timing=await admin.evaluate(()=>({request:__mock.log.filter(l=>l.name==='insert-session-items').at(-1).at,start:window.__flashStartedAt,close:window.__consumptionClosedAt}));
      assert(timing.close>timing.request,'El guardado debe empezar antes de que termine el parpadeo');
      assert(timing.close-timing.start>=2100 && timing.close-timing.start<2500,`Cierre como Nápoles: ${timing.close-timing.start} ms`);
      assert.deepEqual(admin.errors, []);
    });
    await t.test('doble Enter produce la misma confirmación verde y una sola inserción', async () => {
      await admin.evaluate(() => __app.openConsumptionDialog('session-consumption'));
      await admin.locator('#consumptionProductSearch').fill('Cerveza');
      await admin.locator('[data-consumption-product]').first().click();
      await admin.locator('#consumptionForm [name=quantity]').fill('4');
      const before=await admin.evaluate(()=>__mock.log.filter(l=>l.name==='insert-session-items').length);
      await admin.locator('#consumptionForm [name=quantity]').press('Enter');
      await admin.keyboard.press('Enter');
      await admin.waitForFunction(()=>document.querySelector('#tableConsumptionPreview .consumption-just-added'));
      await admin.waitForFunction(()=>!document.querySelector('#consumptionDialog').open);
      assert.equal(await admin.evaluate(()=>__mock.log.filter(l=>l.name==='insert-session-items').length),before+1);
      assert.equal(await admin.evaluate(()=>__app.state.sessions.find(s=>s.id==='session-consumption').session_items.reduce((n,i)=>n+Number(i.quantity),0)),9);
      await admin.evaluate(()=>{__app.renderTables();__app.renderAdminShell();});
      assert.match(await admin.locator('#tablesGrid [data-open-table]').first().getAttribute('class'),/\boccupied\b/);
      assert.equal(await admin.locator('#metricOpen').textContent(),'1');
      assert.deepEqual(admin.errors, []);
    });
    await t.test('el respaldo no vuelve a aparecer ni cambia el diseño al reconectarse', async () => {
      const result=await admin.evaluate(()=>{
        const badge=document.querySelector('#realtimeStatus');
        const before=badge.innerHTML;
        const observer=new MutationObserver(()=>{});
        observer.observe(badge,{childList:true,subtree:true,characterData:true});
        for(let i=0;i<10;i++){
          __mock.adminConnectionStatus('CHANNEL_ERROR');
          __mock.adminConnectionStatus('TIMED_OUT');
          __mock.adminConnectionStatus('SUBSCRIBED');
        }
        const mutations=observer.takeRecords().length;observer.disconnect();
        return {before,after:badge.innerHTML,mutations,status:badge.dataset.connectionStatus,title:badge.title};
      });
      assert.equal(result.after,result.before);assert.equal(result.mutations,0);
      assert.match(result.after,/En vivo/);
      assert.match(await admin.locator('#realtimeStatus').getAttribute('class'),/\blive\b/);
      assert.equal(result.status,'live');assert.equal(result.title,'En vivo');
    });
    await t.test('1500 consumos y confirmaciones repetidas conservan las filas y el tiempo del parpadeo', async () => {
      await admin.evaluate(()=>{
        window.__originalConsumptionSessions=__app.state.sessions;
        window.__originalMockSessions=[...__mock.sessions];
        const table=__app.state.tables[0];
        const session={id:'session-stress',table_id:table.id,restaurant_tables:table,status:'open',opened_at:new Date().toISOString(),session_items:Array.from({length:1500},(_,i)=>({id:`stress-${i}`,session_id:'session-stress',item_name:`Producto ${i}`,quantity:1,unit_price:1000,status:'served',created_at:new Date(Date.now()-i*1000).toISOString()}))};
        __app.state.sessions=[session];__mock.sessions.splice(0,__mock.sessions.length,structuredClone(session));
        __mock.sessionItemDelay=50;
      });
      const clickTimes=[];
      try {
        for(let cycle=0;cycle<3;cycle++){
          await admin.evaluate(()=>__app.openConsumptionDialog('session-stress'));
          await admin.locator('#consumptionProductSearch').fill('Cerveza');
          await admin.locator('[data-consumption-product]').first().click();
          await admin.locator('#consumptionForm [name=quantity]').fill('1');
          const clickMs=await admin.evaluate(()=>{
            const start=performance.now();
            window.__retainedConsumptionRow=document.querySelector('[data-consumption-item="stress-0"]');
            document.querySelector('#consumptionSubmitButton').click();
            window.__flashingConsumptionRow=document.querySelector('.consumption-just-added');
            return performance.now()-start;
          });
          clickTimes.push(Math.round(clickMs));
          assert(clickMs<200,`Clic con 1500 consumos: ${clickMs} ms`);
          const animation=await admin.evaluate(()=>{
            const style=getComputedStyle(__flashingConsumptionRow,'::after');
            return {duration:style.animationDuration,iterations:style.animationIterationCount};
          });
          assert.equal(animation.duration,'0.55s');assert.equal(animation.iterations,'4');
          await admin.waitForFunction(()=>__app.state.sessions[0].session_items.every(i=>!i.id.startsWith('local-batch-')));
          const refresh=await admin.evaluate(async()=>{
            const session=__app.state.sessions[0];
            const start=performance.now();__app.renderTableConsumptionPreview(session);
            const renderMs=performance.now()-start;
            const nodeRetained=__retainedConsumptionRow===document.querySelector('[data-consumption-item="stress-0"]');
            const flashRetained=__flashingConsumptionRow.isConnected && __flashingConsumptionRow.classList.contains('consumption-just-added');
            const heartbeat=performance.now();await new Promise(r=>setTimeout(r,20));
            return {renderMs,nodeRetained,flashRetained,heartbeatMs:performance.now()-heartbeat};
          });
          assert(refresh.nodeRetained);assert(refresh.flashRetained,'Actualizar datos no debe reiniciar el parpadeo');
          assert(refresh.renderMs<150,`Actualización del desglose: ${refresh.renderMs} ms`);
          assert(refresh.heartbeatMs<150,`La interfaz debe responder durante el parpadeo: ${refresh.heartbeatMs} ms (actualización ${refresh.renderMs} ms)`);
          await admin.waitForFunction(()=>!document.querySelector('#consumptionDialog').open);
          assert.equal(await admin.locator('.consumption-just-added').count(),0);
          assert.equal(await admin.evaluate(()=>document.querySelector('#consumptionForm').dataset.localSubmitInProgress),undefined);
          assert.equal(await admin.evaluate(()=>__app.state.sessions[0].session_items.length),1501+cycle);
        }
        t.diagnostic(`Respuesta del clic con 1500 consumos, tres confirmaciones: ${clickTimes.join(', ')} ms`);
      } finally {
        await admin.evaluate(()=>{
          __app.state.sessions=__originalConsumptionSessions;
          __mock.sessions.splice(0,__mock.sessions.length,...__originalMockSessions);
          __app.state.optimisticSessionStates.delete('session-stress');
          delete window.__originalConsumptionSessions;delete window.__originalMockSessions;
          delete window.__retainedConsumptionRow;delete window.__flashingConsumptionRow;
        });
      }
      assert.deepEqual(admin.errors,[]);
    });
    await t.test('la impresión se entrega al navegador sin esperas de red; iconos una vez por cuadro', async () => {
      const timing=await admin.evaluate(async () => {
        let printedAt=0;
        const start=performance.now();
        const fakeDocument={open(){},write(html){if(!html.includes('Cerveza'))throw new Error('Recibo incompleto');},close(){}};
        const popup={document:fakeDocument,closed:false,focus(){},setTimeout:(fn,ms)=>setTimeout(fn,ms),print(){printedAt=performance.now();}};
        __app.printThermalReceipt(__app.state.sessions[0],null,popup);
        const before=window.__iconRuns;
        for(let i=0;i<40;i++)__app.refreshIcons();
        await new Promise(r=>setTimeout(r,80));
        return {printMs:printedAt-start,iconRuns:window.__iconRuns-before};
      });
      assert(timing.printMs>=0 && timing.printMs<200, `Impresión: ${timing.printMs} ms`);
      assert(timing.iconRuns <= 2, `Renders de iconos: ${timing.iconRuns}`);
      assert.deepEqual(admin.errors, []);
      const popupReady=admin.waitForEvent('popup');
      const start=Date.now();
      await admin.evaluate(() => __app.printThermalReceipt(__app.state.sessions[0]));
      const popup=await popupReady;
      await popup.waitForFunction(() => window.__printCalls===1);
      assert((await popup.evaluate(() => window.__printedAt))-start<2000);
      assert.match(await popup.locator('body').textContent(),/Cerveza/);
      await popup.close();
    });
  } finally {await browser.close();await new Promise(r=>server.close(r));}
});
