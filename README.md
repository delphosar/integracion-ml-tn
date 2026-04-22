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

### ✅ Paso 5 — Sync delta automático (stock + precios)

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
pm2 start ecosystem.config.js
pm2 status
pm2 logs ml-tn-sync-delta       # ver logs del sync de precios/stock
pm2 logs ml-tn-sync-new-items   # ver logs de nuevos productos
```

PM2 levanta dos procesos:
- **`ml-tn-sync-delta`** — corre cada 30 minutos: detecta cambios de precio y stock en ML y los replica en TN.
- **`ml-tn-sync-new-items`** — corre cada 2 horas: obtiene la lista completa de ML, la cruza contra TN y migra cualquier producto que no esté publicado todavía.

Los tokens ML se refrescan automáticamente cuando están a menos de 7 días de expirar.

---

## Arquitectura

```
src/
├── sync.js              → sync ML → SQLite (descarga inicial y actualizaciones)
├── db.js                → schema SQLite + todas las operaciones de DB
├── ml-api.js            → cliente ML API (scroll, batch, detalle, descripción)
├── ml-auth.js           → gestión de token ML (refresh automático desde DB)
├── tn-api.js            → cliente TN API (productos, variantes, categorías)
├── ml-to-tn-mapper.js   → transforma item ML al formato requerido por TN
├── sync-delta.js        → ⭐ sync delta de stock+precios (cron 30 min)
├── sync-new-items.js    → ⭐ detecta y migra productos nuevos (cron 2 hs)
├── migrate-all.js       → migración masiva ML → TN
├── sync-categories-tn.js→ sincronización de categorías
├── update-prices-tn.js  → actualización masiva de precios
├── import-ml-mapping.js → importa Excel de mapeo ERP↔ML
├── fetch-ml-categories.js→ fetch nombres de categorías desde ML
├── inspect-item.js      → utilidad: inspecciona item ML por ID
├── check-sku-match.js   → utilidad: analiza match EcomExperts↔ML
├── tn-auth.js           → OAuth TN automático (con servidor local)
└── tn-get-token.js      → OAuth TN manual (exchange code→token)
ecosystem.config.js      → PM2 config para sync delta
data/
└── ml_products.db       → SQLite (NO commitear — datos locales)
```

---

## Base de datos SQLite

Archivo: `data/ml_products.db`

| Tabla | Descripción |
|---|---|
| `ml_items` | Productos de ML (3220 filas) |
| `ml_pictures` | Imágenes por producto |
| `ml_attributes` | Atributos por producto |
| `ml_variations` | Variaciones (precio, stock, SKU, combinaciones) |
| `ml_categories` | Nombres y paths de categorías ML |
| `ecom_ml_mapping` | Mapeo ERP SKU ↔ ML item ID |
| `tn_products` | Mapeo ml_item_id ↔ tn_product_id |
| `tn_categories` | Mapeo ml_category_id ↔ tn_category_id |
| `ml_tokens` | Token ML activo + refresh token (singleton) |
| `sync_log` | Historial de sincronizaciones |

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

## Notas importantes

- **TN API**: siempre incluir header `User-Agent`. El campo `categories` en PUT espera `[123]` (enteros), no objetos.
- **Actualizar variantes**: usar `PUT /products/{id}/variants/{varId}` — TN rechaza con 422 si se envían `variants[]` en `PUT /products/{id}`.
- **Máximo 3 atributos de variación en TN**. Dos productos se subieron con 3 de 4 atributos; requieren ajuste manual.
- **sql.js**: no acepta `undefined` — usar `?? null` en todas las queries.
- **ML paginación**: usa `scroll_id`, no `offset/limit`.

---

## Productos que requieren ajuste manual en TN

TN soporta máximo 3 atributos de variación. Estos productos tenían 4 en ML y se migró con los primeros 3 (se omitió "Largo"):

| ML ID | TN ID | SKU | Título |
|---|---|---|---|
| MLA1480345811 | 337772522 | PAF-0004 | Alfombra Pie De Cama Nórdicas Pelo Largo |
| MLA2023875496 | 337772748 | PAF-0001 | Alfombra Nórdica Pelo Largo Varios Colores |

El atributo "Largo" era constante en todas las variaciones, por lo que el impacto es bajo.
