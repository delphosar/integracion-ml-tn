/**
 * tn-webhook.js — Servidor HTTP que recibe webhooks de TiendaNube.
 *
 * Cuando TN notifica una orden pagada (order/paid):
 *  1. Descarga la orden completa de la API de TN
 *  2. Por cada item, resuelve el SKU de TN → SKU del ERP
 *  3. Busca el variant correspondiente en EcomExperts
 *  4. Descuenta el stock vendido en el depósito "Herrera"
 *
 * Deploy: se registra en PM2 como proceso permanente (no cron).
 * TN debe poder alcanzar el servidor en: http://{VPS_IP}:{WEBHOOK_PORT}/webhook
 * (o vía Nginx reverse proxy en puerto 80/443)
 *
 * Registrar en TN admin:
 *   Configuración → Notificaciones → Agregar webhook
 *   URL: https://tu-dominio/webhook
 *   Evento: order/paid
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const axios = require('axios');
const { getDb, getErpMapping, logTnOrder } = require('./db');
const { findVariantBySku, updateStock } = require('./ecom-api');

const PORT = process.env.WEBHOOK_PORT ?? 3001;

// ---------- TN API ----------

async function getTnOrder(orderId) {
  const storeId = process.env.TN_STORE_ID;
  const { data } = await axios.get(
    `https://api.tiendanube.com/v1/${storeId}/orders/${orderId}`,
    {
      headers: {
        Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
        'User-Agent': process.env.TN_USER_AGENT ?? 'ML-TN-Sync (dev)',
      },
    }
  );
  return data;
}

// ---------- Mapeo SKU ----------

// TN SKU puede ser:
//   1. "MLA1234567"         → producto simple (SKU = ML item ID)
//   2. "PAF-0001"           → variación con seller_custom_field (SKU = ERP SKU directo)
//   3. "MLA1234567-9876543" → variación sin seller_custom_field (no hay ERP SKU)
//
// Retorna { erpSku } o { erpSku: null, reason, detail? }
function resolveErpSku(tnSku) {
  // Caso 1: producto simple → SKU es el ML item ID
  if (/^MLA\d+$/.test(tnSku)) {
    const mapping = getErpMapping(tnSku);
    if (!mapping?.erp_sku) return { erpSku: null, reason: 'sin-mapeo-erp' };
    if (mapping.is_combo) return { erpSku: null, reason: 'combo-no-soportado', detail: mapping.erp_sku };
    return { erpSku: mapping.erp_sku };
  }

  // Caso 3: variación sin seller_custom_field (formato "{ML_ID}-{variation_id}")
  if (/^MLA\d+-\d+$/.test(tnSku)) {
    return { erpSku: null, reason: 'variacion-sin-sku-erp' };
  }

  // Caso 2: ya es el ERP SKU directamente (seller_custom_field estaba seteado)
  return { erpSku: tnSku };
}

// ---------- Procesamiento ----------

async function processOrderItem(orderId, item) {
  const tnSku = item.sku;
  const qtySold = item.quantity ?? 1;

  if (!tnSku) {
    console.warn(`[webhook] Orden ${orderId} - item sin SKU, ignorado`);
    return;
  }

  const { erpSku, reason, detail } = resolveErpSku(tnSku);

  if (!erpSku) {
    console.warn(`[webhook] Orden ${orderId} - SKU "${tnSku}" sin ERP SKU (${reason}${detail ? ': ' + detail : ''})`);
    logTnOrder({
      tn_order_id: String(orderId),
      tn_sku: tnSku,
      erp_sku: null,
      qty_sold: qtySold,
      status: 'skipped',
      error: reason,
    });
    return;
  }

  let variant;
  try {
    variant = await findVariantBySku(erpSku);
  } catch (err) {
    console.error(`[webhook] Orden ${orderId} - error buscando SKU "${erpSku}" en EcomExperts:`, err.message);
    logTnOrder({
      tn_order_id: String(orderId),
      tn_sku: tnSku,
      erp_sku: erpSku,
      qty_sold: qtySold,
      status: 'error',
      error: err.message,
    });
    return;
  }

  if (!variant) {
    console.warn(`[webhook] Orden ${orderId} - ERP SKU "${erpSku}" no encontrado en EcomExperts`);
    logTnOrder({
      tn_order_id: String(orderId),
      tn_sku: tnSku,
      erp_sku: erpSku,
      qty_sold: qtySold,
      status: 'not-found',
      error: 'SKU no encontrado en EcomExperts',
    });
    return;
  }

  const { productId, variantId, currentQty } = variant;
  const newQty = Math.max(0, currentQty - qtySold);

  try {
    await updateStock(productId, variantId, newQty);
    console.log(`[webhook] Orden ${orderId} - SKU "${erpSku}" stock ${currentQty} → ${newQty} (-${qtySold})`);
    logTnOrder({
      tn_order_id: String(orderId),
      tn_sku: tnSku,
      erp_sku: erpSku,
      qty_sold: qtySold,
      qty_before: currentQty,
      qty_after: newQty,
      status: 'ok',
    });
  } catch (err) {
    console.error(`[webhook] Orden ${orderId} - error actualizando stock de "${erpSku}":`, err.message);
    logTnOrder({
      tn_order_id: String(orderId),
      tn_sku: tnSku,
      erp_sku: erpSku,
      qty_sold: qtySold,
      qty_before: currentQty,
      status: 'error',
      error: err.message,
    });
  }
}

async function handleWebhook(body) {
  const { store_id, event, id: orderId } = body;

  if (String(store_id) !== String(process.env.TN_STORE_ID)) {
    console.warn(`[webhook] store_id inesperado: ${store_id}`);
    return;
  }

  if (event !== 'order/paid') {
    console.log(`[webhook] Evento ignorado: ${event}`);
    return;
  }

  console.log(`[webhook] Orden pagada: ${orderId}`);

  let order;
  try {
    order = await getTnOrder(orderId);
  } catch (err) {
    console.error(`[webhook] Error obteniendo orden ${orderId} de TN:`, err.message);
    return;
  }

  for (const item of order.products ?? []) {
    await processOrderItem(orderId, item);
  }
}

// ---------- Servidor HTTP ----------

async function main() {
  await getDb();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      // TN espera respuesta rápida — respondemos 200 antes de procesar
      res.writeHead(200);
      res.end('OK');

      try {
        const body = JSON.parse(raw);
        await handleWebhook(body);
      } catch (err) {
        console.error('[webhook] Error procesando payload:', err.message, '| raw:', raw.slice(0, 200));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`[webhook] Servidor escuchando en http://0.0.0.0:${PORT}/webhook`);
  });
}

main().catch(err => {
  console.error('[webhook] Error fatal al iniciar:', err.message);
  process.exit(1);
});
