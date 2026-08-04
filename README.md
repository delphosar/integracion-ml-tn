# ml-sync — Integración MercadoLibre ↔ TiendaNube

Proyecto Node.js que sincroniza productos, stock y precios entre **MercadoLibre** (fuente de verdad) y **TiendaNube** (`integraldeco5.mitiendanube.com`).

---

## Requisitos

- Node.js v18+
- PM2 (en VPS para el sync automático): `npm install -g pm2`

```bash
npm install
```

---

## Configuración

Copiar `.env.example` a `.env` y completar todas las variables:

```bash
cp .env.example .env
```

```env
# MercadoLibre
ML_ACCESS_TOKEN=APP_USR-...       # token actual (fallback si no hay tokens en DB)
ML_USER_ID=123456789              # seller ID numérico
ML_CLIENT_ID=...                  # app ID (portal developers ML)
ML_CLIENT_SECRET=...              # app secret
ML_REFRESH_TOKEN=TG-...           # refresh token inicial

# TiendaNube
TN_CLIENT_ID=...
TN_CLIENT_SECRET=...
TN_ACCESS_TOKEN=...               # token obtenido via OAuth TN
TN_STORE_ID=...                   # user_id / store ID
TN_USER_AGENT=ML-TN-Sync (tu@email.com)

# EcomExperts (ERP/PIM)
ECOM_EMAIL=...                    # email del operador EcomExperts
ECOM_PASSWORD=...                 # contraseña del operador EcomExperts

# Webhook TN → EcomExperts
WEBHOOK_PORT=3001                 # puerto del servidor HTTP de webhooks

# Throttling
ML_REQUEST_DELAY_MS=300
ML_BATCH_SIZE=20
```

---

## Scripts disponibles

| Comando | Descripción |
|---|---|
| `npm run sync` | Sync completo ML → SQLite (con descripciones) |
| `npm run sync -- --no-descriptions` | Sync rápido sin descripciones |
| `npm run import-mapping` | Importa Excel EcomExperts → tabla `ecom_ml_mapping` |
| `npm run migrate` | Migración masiva ML → TN (resumible) |
| `npm run migrate:dry` | Simula migración sin subir nada |
| `npm run fetch-categories` | Fetch nombres de categorías ML → `ml_categories` |
| `npm run sync-categories` | Crea categorías en TN y las asigna a productos |
| `npm run update-prices` | Actualiza precios en TN para todos los productos |
| `npm run update-prices:dry` | Simula actualización de precios |
| `npm run sync:delta` | **Sync delta de stock+precios** (uso en producción) |
| `npm run sync:delta:dry` | Muestra qué cambiaría sin tocar TN |
| `npm run sync:new` | **Detecta y migra productos nuevos en ML** |
| `npm run sync:new:dry` | Muestra qué productos nuevos habría sin crear nada |
| `npm run webhook` | Inicia servidor HTTP de webhooks TN → EcomExperts |
| `npm run ecom:test-auth` | Verifica login EcomExperts (refresca cookie si hace falta) |
| `npm run ecom:explore` | Exploración del schema GraphQL de EcomExperts |
| `npm run update-tn-skus` | Actualiza SKUs en TN para que coincidan con SKUs ERP |
| `npm run update-tn-skus:dry` | Muestra qué SKUs cambiaría sin aplicar nada |
| `npm run update-tn-skus:simple` | Solo productos con 1 variante (más seguro para empezar) |
| `npm run update-tn-skus:simple:dry` | Dry-run de lo anterior |

---

## Flujo completo (estado actual)

### ✅ Paso 1 — Sync ML → SQLite

Descarga todos los items del seller de ML y los guarda en `data/ml_products.db`.

```bash
npm run sync
```

- 3220 productos sincronizados
- Base de datos: `data/ml_products.db` (SQLite via sql.js)

---

### ✅ Paso 2 — Importar mapeo ERP ↔ ML

```bash
npm run import-mapping
```

Importa el Excel de Publicaciones de ML con la columna de SKU de EcomExperts.
Resultado: tabla `ecom_ml_mapping` (1214 filas, 340 combos, 60 sin SKU).

---

### ✅ Paso 3 — Migración masiva ML → TiendaNube

```bash
npm run migrate        # sube todos los activos (resumible)
npm run migrate:dry    # dry-run
```

- 1239/1239 productos activos migrados
- Mapeo `ml_item_id ↔ tn_product_id` guardado en tabla `tn_products`
- Productos simples y con variaciones soportados (máx. 3 atributos de variación en TN)

---

### ✅ Paso 4 — Sincronizar categorías

```bash
npm run fetch-categories   # fase 1: fetch nombres desde ML
npm run sync-categories    # fase 2: crea en TN y asigna a productos
```

- 56 categorías ML mapeadas en TN
- 1241 productos actualizados con su categoría

---

### ✅ Paso 5 — Webhook TiendaNube → EcomExperts

Cuando TN registra una venta, el webhook reduce el stock en EcomExperts directamente via GraphQL.
EcomExperts luego propaga el cambio a ML de forma automática (flujo ya existente en EcomExperts).

#### Arquitectura del flujo

```
TN venta → webhook HTTP → tn-webhook.js → GraphQL EcomExperts → stock actualizado en ERP
                                                                         ↓
                                                               EcomExperts → ML (nativo)
```

#### Setup

1. Agregar `ECOM_EMAIL` y `ECOM_PASSWORD` al `.env` del VPS.
2. Iniciar el proceso webhook con PM2 (incluido en `ecosystem.config.js`):
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   ```
3. Registrar en TN admin: **Configuración → Notificaciones → Agregar webhook**
   - URL: `http://{VPS_IP}:3001/webhook` (o via Nginx en 443)
   - Evento: `order/paid`

#### Test manual

```bash
npm run ecom:test-auth   # verifica que el login a EcomExperts funciona
npm run webhook          # inicia el servidor localmente (puerto 3001)
```

El proceso `tn-webhook` en PM2 tiene `autorestart: true` — se levanta solo si cae.

Los webhooks procesados quedan registrados en la tabla `tn_order_log` con status
`ok`, `skipped`, `not-found` o `error`.

---

### ✅ Paso 6 — Sync delta automático (stock + precios)

Detecta cambios en ML y los replica en TN. Diseñado para correr cada 30 minutos en VPS.

#### Setup inicial (una sola vez)

```bash
# 1. Completar ML_CLIENT_ID, ML_CLIENT_SECRET, ML_REFRESH_TOKEN en .env
# 2. Sembrar tokens en la base de datos
node src/ml-auth.js --init
```

#### Test manual

```bash
npm run sync:delta:dry   # muestra cambios sin tocarTN
npm run sync:delta       # aplica cambios en TN
```

#### Deploy en VPS con PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 status
pm2 logs ml-tn-sync-delta       # ver logs del sync de precios/stock
pm2 logs ml-tn-sync-new-items   # ver logs de nuevos productos
```

**Auto-arranque al reiniciar el VPS** (DonWeb no permite sudo al usuario de CloudPanel):
En lugar de `pm2 startup`, usar crontab del usuario:
```bash
crontab -e
# Agregar al final:
@reboot /home/<usuario>/.nvm/versions/node/v22.22.2/bin/pm2 resurrect
```

PM2 levanta dos procesos:
- **`ml-tn-sync-delta`** — corre cada 30 minutos: detecta cambios de precio y stock en ML y los replica en TN.
- **`ml-tn-sync-new-items`** — corre cada 2 horas: obtiene la lista completa de ML, la cruza contra TN y migra cualquier producto que no esté publicado todavía.

Los tokens ML se refrescan automáticamente cuando están a menos de 7 días de expirar.

---

### Paso 7 — Activar integración nativa EcomExperts ↔ TiendaNube

EcomExperts tiene integración nativa con TiendaNube. Para activarla se usa
**"Vincular Productos Existentes"**: importa las publicaciones TN y las vincula
automáticamente si los SKUs de TN coinciden con los SKUs del ERP.

#### Diagnóstico del estado actual de SKUs (resultado de `diagnose-sku.js`)

| Tipo | Cantidad | Problema |
|---|---|---|
| Productos simples | 988 | SKU en TN = MLA code (ej: `MLA1734615983`) en lugar del SKU ERP |
| Productos con variaciones | 253 | SKU en TN = fallback `MLA_ID-variation_id`, sin `seller_custom_field` en ML |
| Productos TN duplicados a eliminar | 736 | Mismo ERP SKU publicado N veces en ML (contado, 6c, 12c...) |
| Productos TN ya correctos (1 TN por ERP SKU) | 154 | OK |

#### Plan de acción

```
1. [✅] Descargar 3430 ML listings → data/ecom-ml-listings-all.json
         node src/ecom-explore.js --ml-listings --all

2. [✅] Descargar 1643 variantes ERP → data/ecom-variants.json
         node src/ecom-explore.js --variants --all

3. [✅] Analizar SKU mapping → data/sku-mapping-analysis.json
         node src/analyze-sku-mapping.js
         (1187 productos TN con SKU ERP resuelto; 54 sin mapeo)

4. [ ] Actualizar SKUs en TiendaNube
         npm run update-tn-skus:simple:dry   # revisar
         npm run update-tn-skus:simple       # aplicar productos simples
         npm run update-tn-skus:dry          # revisar multi-variante
         npm run update-tn-skus              # aplicar todo

5. [ ] Eliminar 736 productos TN duplicados (dejar 1 por ERP SKU)

6. [ ] Activar en EcomExperts admin → "Vincular Productos Existentes"
```

#### Script: `update-tn-skus.js`

Actualiza los SKUs de variantes TN para que coincidan con los SKUs del ERP.

**Casos que maneja:**

- **1 variante TN** (producto simple): reemplaza el SKU directamente con el ERP SKU.
- **N variantes TN** (producto con variaciones): hace matching por atributos comparando
  los valores de cada variante TN con los `variantAttributes` de las variantes ERP.
  Si alguna variante no tiene match o el match es ambiguo, la marca como `needs-review`.

**Opciones:**

```bash
--dry-run       # muestra cambios sin aplicar nada
--only-simple   # solo productos con 1 variante (más seguro para empezar)
--limit N       # procesa solo los primeros N productos
--resume        # saltea productos que ya figuran como ok en el archivo de resultados
```

**Archivo de resultados:** `data/update-tn-skus-results.json`

Cada entrada tiene:
- `status`: `ok` | `already-ok` | `dry` | `needs-review` | `skipped-multi` | `error`
- `mlaId`, `erpSku`, `tnProductId`
- `oldSku` / `updates` según el caso

#### Script: `analyze-sku-mapping.js`

Cruza ERP + ML + SQLite para determinar qué SKU ERP corresponde a cada producto TN.

Fuentes de SKU (en orden de prioridad):
1. `variant.sku` del ERP variant vinculado al listing de ML
2. `product.sku` del producto ERP padre
3. Mapeo del Excel (`ecom_ml_mapping`)

Genera `data/sku-mapping-analysis.json`: array de `{ mlaId, erpSku, tnProductId }`.

---

## Arquitectura

```
src/
├── sync.js               → sync ML → SQLite (descarga inicial y actualizaciones)
├── db.js                 → schema SQLite + todas las operaciones de DB
├── ml-api.js             → cliente ML API (scroll, batch, detalle, descripción)
├── ml-auth.js            → gestión de token ML (refresh automático desde DB)
├── tn-api.js             → cliente TN API (productos, variantes, categorías, órdenes)
├── ml-to-tn-mapper.js    → transforma item ML al formato requerido por TN
├── sync-delta.js         → ⭐ sync delta de stock+precios (cron 30 min)
├── sync-new-items.js     → ⭐ detecta y migra productos nuevos (cron 2 hs)
├── tn-webhook.js         → ⭐ servidor HTTP webhooks TN → reduce stock en EcomExperts
├── ecom-auth.js          → login EcomExperts + refresh cookie CAKEPHP
├── ecom-api.js           → cliente GraphQL EcomExperts (findVariantBySku, updateStock)
├── ecom-explore.js       → exploración schema GraphQL (--schema, --products, --ml-listings, --variants)
├── analyze-sku-mapping.js→ cruza ERP + ML + SQLite → data/sku-mapping-analysis.json
├── update-tn-skus.js     → actualiza SKUs en TN para que coincidan con SKUs ERP
├── migrate-all.js        → migración masiva ML → TN
├── sync-categories-tn.js → sincronización de categorías
├── update-prices-tn.js   → actualización masiva de precios
├── import-ml-mapping.js  → importa Excel de mapeo ERP↔ML
├── fetch-ml-categories.js→ fetch nombres de categorías desde ML
├── diagnose-sku.js       → diagnóstico estado SKUs en TN vs ERP
├── inspect-item.js       → utilidad: inspecciona item ML por ID
├── check-sku-match.js    → utilidad: analiza match EcomExperts↔ML
├── tn-auth.js            → OAuth TN automático (con servidor local)
└── tn-get-token.js       → OAuth TN manual (exchange code→token)
ecosystem.config.js       → PM2: sync-delta (30min) + sync-new-items (2hs) + webhook
data/
├── ml_products.db             → SQLite (NO commitear — datos locales)
├── ecom-ml-listings-all.json  → 3430 ML listings con productListings (ERP)
├── ecom-variants.json         → 1643 variantes ERP con sku + variantAttributes
├── ecom-schema.json           → tipos del schema GraphQL de EcomExperts
├── ecom-nube-listings.json    → nubeListings + nubeMlListings
├── sku-mapping-analysis.json  → mlaId → erpSku → tnProductId (1187 entradas)
└── update-tn-skus-results.json→ resultados del último run de update-tn-skus.js
```

---

## Base de datos SQLite

Archivo: `data/ml_products.db`

| Tabla | Descripción |
|---|---|
| `ml_items` | Productos de ML (3220 filas) |
| `ml_pictures` | Imágenes por producto |
| `ml_attributes` | Atributos por producto |
| `ml_variations` | Variaciones (precio, stock, SKU, combinaciones de atributos) |
| `ml_categories` | Nombres y paths de categorías ML |
| `ecom_ml_mapping` | Mapeo ERP SKU ↔ ML item ID (importado desde Excel) |
| `tn_products` | Mapeo ml_item_id ↔ tn_product_id |
| `tn_categories` | Mapeo ml_category_id ↔ tn_category_id |
| `ml_tokens` | Token ML activo + refresh token (singleton id=1) |
| `ecom_session` | Cookie CAKEPHP de EcomExperts + expires_at en ms (singleton id=1) |
| `tn_order_log` | Historial de webhooks TN procesados (status: ok/skipped/not-found/error) |
| `sync_log` | Historial de sincronizaciones ML → SQLite |

---

## Lógica de precios ML → TN

ML usa dos campos:
- `price` — precio de venta actual (con descuento si aplica)
- `original_price` — precio original tachado (solo cuando hay descuento)

TN usa:
- `price` — precio regular (tachado)
- `promotional_price` — precio promocional activo

Mapping:
- Si ML tiene `original_price`: TN `price = original_price`, TN `promotional_price = price`
- Si no: TN `price = price`, sin `promotional_price`

Para productos con variaciones, el precio tachado de cada variante se determina así:
- Si `variation.price === item.price` → se usa `item.original_price` **directamente** (sin cálculos), garantizando que el cliente vea exactamente el mismo valor que en ML.
- Si `variation.price` difiere del item (ej: talle premium con precio distinto) → se calcula aplicando el ratio `original_price / price` del item padre.

Esta lógica está implementada consistentemente en `ml-to-tn-mapper.js`, `sync-delta.js` y `update-prices-tn.js`.

---

## EcomExperts — API GraphQL

**URL:** `https://api.ecomexperts.com/graphql`
**Auth:** cookie `CAKEPHP` en el header. Se obtiene via login (usuario/contraseña) y expira diariamente a las 00:06 UTC. El proceso `ecom-auth.js` la refresca automáticamente y la persiste en la tabla `ecom_session`.

### Patrones clave

```graphql
# Variantes
variants { find(page: N) { data { id sku variantAttributes { name options } product { id title sku } } pageInfo { page pageCount nextPage } } }

# Listings ML
mlListings { find(page: N) { data { id ownerId productListings { productId productVariantId } } pageInfo { ... } } }

# Paginación
# Usar pageInfo.nextPage (null cuando termina). NO usar total/current_page/last_page (no existen).
```

### Campos relevantes

| Campo | Nota |
|---|---|
| `mlListing.ownerId` | MLA item ID (ej: `"MLA3267956078"`) |
| `productListing.productVariantId` | ID de variante ERP vinculada al listing |
| `productListing.productId` | ID de producto ERP |
| `variant.sku` | SKU de la variante (puede ser null) |
| `variant.product.sku` | SKU del producto padre (fallback) |
| `variantAttribute.options` | Valor del atributo (ej: `"Rojo"`) |

### Depósito del cliente

El depósito del cliente en EcomExperts se llama **"Herrera"**.

---

## Notas importantes

- **TN API**: siempre incluir header `User-Agent`. El campo `categories` en PUT espera `[123]` (enteros), no objetos.
- **Actualizar variantes TN**: usar `PUT /products/{id}/variants/{varId}` — TN rechaza con 422 si se envían `variants[]` en `PUT /products/{id}`.
- **Máximo 3 atributos de variación en TN**. Dos productos se subieron con 3 de 4 atributos; requieren ajuste manual.
- **sql.js**: no acepta `undefined` — usar `?? null` en todas las queries.
- **ML paginación**: usa `scroll_id`, no `offset/limit`.
- **EcomExperts paginación GraphQL**: usar `pageInfo.nextPage`; los campos `total`, `current_page` y `last_page` no existen en `ListingFindResult`.
- **EcomExperts `productVariantListings`**: siempre vacío — el mapeo a variaciones ML no existe a nivel de variante; solo a nivel de listing.
- **EcomExperts variantes sin SKU**: muchas variantes tienen `sku: null`; usar `product.sku` como fallback.
- **EcomExperts `ProductSimple`**: el campo se llama `title`, no `name`. El tipo `VariantAttribute` tiene `name` y `options`, no `attribute_title`/`attribute_value`.

---

## Productos que requieren ajuste manual en TN

TN soporta máximo 3 atributos de variación. Estos productos tenían 4 en ML y se migró con los primeros 3 (se omitió "Largo"):

| ML ID | TN ID | SKU | Título |
|---|---|---|---|
| MLA1480345811 | 337772522 | PAF-0004 | Alfombra Pie De Cama Nórdicas Pelo Largo |
| MLA2023875496 | 337772748 | PAF-0001 | Alfombra Nórdica Pelo Largo Varios Colores |

El atributo "Largo" era constante en todas las variaciones, por lo que el impacto es bajo.
