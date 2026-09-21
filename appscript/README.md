# Servicio histórico de TIENDA NÁPOLES

Este módulo usa únicamente `Code.gs`. Todo el inventario y el histórico se guarda dentro del mismo archivo de Google Sheets:

`1hjl2H0aMLUCwf3p74YbcnXviPAoVQTbNulyehfZU53s`

No crea otros libros, no divide la información por años y no necesita archivos HTML.

## Instalación

1. Abra el proyecto de Apps Script asociado al negocio.
2. Reemplace por completo su `Code.gs` con el contenido de este directorio.
3. Ejecute `CONFIGURAR_SISTEMA` una vez desde el editor y acepte los permisos. Esto crea todas las pestañas y encabezados dentro del archivo indicado.
4. Seleccione **Implementar → Nueva implementación → Aplicación web**.
5. Configure **Ejecutar como: Yo** y permita el acceso a los dispositivos del negocio.
6. Copie la URL terminada en `/exec` en la variable `APPS_SCRIPT_CONFIG.webAppUrl` de `app.js`.

Cada vez que modifique `Code.gs`, edite la implementación y publique una versión nueva. Guardar el código sin actualizar la implementación no cambia la URL `/exec` que usa la caja.

## Pestañas creadas

- `Configuracion`: conexión privada y orígenes autorizados.
- `Inventario`: existencias, costos, precios, mínimos y siglas.
- `Auditoria`: instalaciones, sincronizaciones, ventas y errores.
- `Ventas`: una fila por factura pagada.
- `Detalle_Ventas`: productos, costos y utilidad por línea.
- `Pagos`: efectivo, transferencia y Bre-B por separado.
- `Movimientos_Inventario`: trazabilidad de entradas, salidas, altas, devoluciones y correcciones con responsable y hora exacta.
- `Ingresos_Diarios`: acumulado diario por medio de pago, costos y utilidad.

El panel **Ingresos** consulta estas pestañas para calcular KPIs por hoy, ayer, 7 días, 15 días, mes, 30 días, año o fechas personalizadas. También permite filtrar por efectivo, transferencia, Bre-B y pagos mixtos, buscar facturas o productos y exportar el resultado visible en CSV.

## Funcionamiento

- El panel se comunica directamente con el servicio mediante solicitudes HTTP; no usa iframe ni puente HTML.
- Agregar, editar o eliminar consumos de una mesa abierta no modifica las existencias.
- Al confirmar el pago, la venta descuenta el inventario una sola vez y registra la salida con referencia a la factura y la sesión.
- Una venta cerrada entra primero en una cola local y se sincroniza en segundo plano.
- Las ventas individuales no crean mesa ni sesión en Supabase: su borrador permanece en el equipo y, al cobrar, Apps Script lo registra en `Ventas`, `Detalle_Ventas`, `Pagos` e `Ingresos_Diarios`.
- Las ventas cerradas se pueden corregir desde **Ingresos**; el servicio recalcula detalle, pagos, inventario e ingresos diarios y conserva el evento en `Auditoria`.
- El guardado es idempotente por `sale_id` y `session_id`, por lo que los reintentos no duplican facturas.
- Al eliminar uno o todos los movimientos, el servicio aplica el cambio inverso al inventario antes de borrar el historial.
- Después de confirmar la venta completa en el histórico, el servicio elimina de Supabase únicamente esa sesión cerrada, sus consumos y solicitudes.
- Si no hay conexión, la cola permanece en el dispositivo y reintenta automáticamente.
- La copia del navegador es solo caché operativa; el archivo indicado es el histórico persistente.

## Comprobación rápida

Después de publicar la implementación nueva, abra su URL `/exec` en el navegador. Debe responder un JSON con `"ok":true`, `"version":"2.8.0"` y el ID del archivo. Al hacerlo también se verifica y crea la estructura de pestañas.
