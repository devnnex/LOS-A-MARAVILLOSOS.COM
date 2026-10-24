import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await fs.readFile(new URL('./fixtures/supabase-browser.js', import.meta.url), 'utf8');
const app = (await fs.readFile(process.env.PAYMENT_APP_PATH || path.join(root, 'app.js'), 'utf8'))
  .replace('return { init };', 'return { init, state, openPaymentDialog };') + '\nwindow.__app = App;';

test('inventario insuficiente: advertencia visible y cobro bloqueado', async (t) => {
  const server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1)) || 'admin.html';
      const absolute = path.resolve(root, name);
      if (!absolute.startsWith(root + path.sep)) {res.writeHead(403); res.end(); return;}
      let body = name === 'app.js' ? app : await fs.readFile(absolute);
      if (name.endsWith('.html')) body = body.toString().replace(/<script src="https:[^"]+"><\/script>/g, '');
      res.writeHead(200, {'Content-Type': {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'}[path.extname(name)] || 'application/octet-stream'});
      res.end(body);
    } catch {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {try {await fs.access(candidate); executablePath = candidate; break;} catch {}}
  assert(executablePath, 'Configura CHROME_PATH para ejecutar las pruebas de navegador.');
  const browser = await chromium.launch({executablePath, headless: true});
  const context = await browser.newContext();
  const errors = [];
  const sales = [];
  try {
    await context.addInitScript({content:fixture});
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin)) return route.continue();
      try {const request=JSON.parse(route.request().postData()); if(request?.action==='record_sale') sales.push(request.payload.invoice);} catch {}
      return route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{ok:true,version:'2.10.0',items:[],records:[],movements:[],totals:{},summary:{}}});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/admin.html`);
    await page.locator('#loginForm [name=username]').fill('prueba');
    await page.locator('#loginForm [name=pin]').fill('1234');
    await page.locator('#loginSubmit').click();
    await page.waitForFunction(() => document.body.classList.contains('admin-authenticated') && document.querySelector('#inventorySyncStatus').textContent.includes('Inventario sincronizado'));
    await page.evaluate(() => {
      __mock.items.push({id:'product-2',name:'GINGER',price:7000,is_available:true},{id:'product-3',name:'Agua',price:3000,is_available:true});
      __app.state.items=structuredClone(__mock.items);
      window.__preparePayment = (id, tableIndex=33, local=false, sufficient=false) => {
        document.querySelector('#paymentDialog').close();
        const table=__mock.tables[tableIndex] || {id:`point-${tableIndex}`,table_number:tableIndex+1,table_name:tableIndex<68?`Barra ${tableIndex-64}`:`Matera ${tableIndex-67}`};
        const session={id,table_id:local?null:table.id,restaurant_tables:local?null:table,sale_channel:local?'walk_in':'table',local_only:local,status:'open',opened_at:new Date().toISOString(),session_items:[
          {id:`a-${id}`,menu_item_id:'product-1',item_name:'Cerveza',quantity:2,unit_price:5000,status:'served'},
          {id:`b-${id}`,menu_item_id:'product-1',item_name:'Cerveza',quantity:1,unit_price:5000,status:'served'},
          {id:`c-${id}`,menu_item_id:'product-2',item_name:'GINGER',quantity:4,unit_price:7000,status:'served'},
          {id:`d-${id}`,menu_item_id:'product-3',item_name:'Agua',quantity:1,unit_price:3000,status:'served'}]};
        __mock.sessions.splice(0,__mock.sessions.length,...(local?[]:[session]));
        __app.state.sessions=[structuredClone(session)];
        if(local)__app.state.optimisticSessionStates.set(id,{mode:'upsert',localOnly:true,session:structuredClone(session)});
        __app.state.inventoryMeta={'product-1':{stock:sufficient?20:1},'product-2':{stock:sufficient?20:0},'product-3':{stock:20}};
        __app.openPaymentDialog(id);
      };
      window.__selectPayment = method => {
        const form=document.querySelector('#paymentForm');
        const mixed=method.includes('-');
        form.querySelector(`[name=payment_method][value=${mixed?'mixed':method}]`).click();
        if(mixed) {
          [form.mixed_method_one.value,form.mixed_method_two.value]=method.split('-');
          form.mixed_amount_one.value='10000';
          form.mixed_amount_one.dispatchEvent(new Event('input',{bubbles:true}));
        }
      };
      window.open=()=>({closed:false,document:{open(){},write(){},close(){}},close(){this.closed=true;},focus(){},setTimeout(fn){fn();},print(){window.__printed=true;}});
    });

    await t.test('Mesa 34: lista todos los faltantes delante del modal, anima y desaparece a los 5 segundos', async () => {
      await page.evaluate(()=>__preparePayment('mesa-34'));
      await page.locator('#paymentForm button[value=save]').click();
      const warning=page.locator('#paymentInventoryWarning');
      assert(await warning.isVisible());
      assert(await warning.evaluate(el=>el.matches(':popover-open')),'La advertencia debe estar en la capa superior del navegador');
      assert.deepEqual(await warning.locator('li').allTextContents(),[
        'Cerveza: aumenta 2 unidades (inventario: 1; necesarias: 3).',
        'GINGER: aumenta 4 unidades (inventario: 0; necesarias: 4).'
      ]);
      assert.match(await warning.textContent(),/no podemos cobrar porque faltan existencias/);
      assert.match(await warning.textContent(),/cuenta sigue abierta/);
      assert.equal(await warning.locator('.error').count(),0);
      assert.equal(await warning.locator('.system-modal').evaluate(el=>getComputedStyle(el).animationName),'paymentInventoryNudge');
      assert(await warning.locator('.system-modal').evaluate(el=>{const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el.contains(hit);}), 'La advertencia debe verse por encima de la cuenta');
      await page.waitForTimeout(4500);
      assert(await warning.isVisible(),'La advertencia debe permanecer visible durante 5 segundos');
      await warning.waitFor({state:'detached',timeout:1500});
      assert.equal(await page.evaluate(()=>__mock.sessions[0].status),'open');
      assert.equal(await page.evaluate(()=>__app.state.invoiceHistory.length),0);
      assert.equal(sales.length,0);
    });

    await t.test('70 mesas y puntos de servicio: efectivo, transferencia, Bre-B y todos los mixtos, con ambos botones', async () => {
      const results=await page.evaluate(() => {
        const results=[];
        for(let table=0;table<70;table++) for(const method of ['cash','transfer','breb','cash-transfer','cash-breb','transfer-breb']) for(const action of ['save','print']) {
          __preparePayment(`matrix-${table}-${method}-${action}`,table);
          __selectPayment(method);
          document.querySelector(`#paymentForm button[value=${action}]`).click();
          const warning=document.querySelector('#paymentInventoryWarning');
          results.push({table:table+1,method,action,visible:warning?.matches(':popover-open'),count:warning?.querySelectorAll('li').length,status:__mock.sessions[0].status,busy:__app.state.paymentProcessing,disabled:document.querySelector('#paymentForm button[value=save]').disabled});
        }
        return results;
      });
      assert.equal(results.length,840);
      for(const result of results) {
        assert.equal(result.visible,true,JSON.stringify(result));
        assert.equal(result.count,2,JSON.stringify(result));
        assert.equal(result.status,'open',JSON.stringify(result));
        assert.equal(result.busy,false,JSON.stringify(result));
        assert.equal(result.disabled,false,JSON.stringify(result));
      }
      assert.equal(await page.evaluate(()=>__app.state.invoiceHistory.length),0);
      assert.equal(sales.length,0);
    });

    await t.test('venta individual y clics repetidos renuevan el aviso sin duplicarlo', async () => {
      await page.evaluate(()=>__preparePayment('walk-in-warning',33,true));
      await page.locator('#paymentForm button[value=save]').click();
      await page.waitForTimeout(3000);
      await page.locator('#paymentForm button[value=save]').click();
      assert.equal(await page.locator('#paymentInventoryWarning').count(),1);
      await page.waitForTimeout(2500);
      assert(await page.locator('#paymentInventoryWarning').isVisible(),'Cada clic debe mostrar el aviso durante 5 segundos de nuevo');
      assert.equal(await page.evaluate(()=>__app.state.invoiceHistory.length),0);
    });

    await t.test('al reponer existencias se puede cobrar por cualquier método, con y sin propina', async () => {
      for(const tip of ['disabled','without','with','manual']) for(const method of ['cash','transfer','breb','cash-transfer','cash-breb','transfer-breb']) {
        const id=`paid-${tip}-${method}`;
        await page.evaluate(({id,tip})=>{__app.state.tipSettings={enabled:tip!=='disabled',percentage:10};__preparePayment(id,33,false,true);},{id,tip});
        if(tip!=='disabled') await page.locator(`#paymentForm [name=tip_choice][value=${tip==='manual'?'with':tip}]`).locator('..').click();
        if(tip==='manual') await page.locator('#paymentForm [name=tip_amount]').fill('1500');
        await page.evaluate(method=>__selectPayment(method),method);
        await page.locator('#paymentForm button[value=save]').click();
        await page.waitForFunction(id=>__app.state.invoiceHistory.some(i=>i.sessionId===id),id);
        const result=await page.evaluate(id=>({invoice:__app.state.invoiceHistory.find(i=>i.sessionId===id),status:__mock.sessions[0].status,stock:__app.state.inventoryMeta['product-1'].stock}),id);
        assert.equal(result.status,'closed');
        assert.equal(result.stock,17);
        assert.equal(result.invoice.totals.total,tip==='with'?50600:tip==='manual'?47500:46000);
        assert.equal(result.invoice.payments.reduce((sum,p)=>sum+p.amount,0),result.invoice.totals.total);
      }
    });
    assert.deepEqual(errors,[]);
  } finally {await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
});
