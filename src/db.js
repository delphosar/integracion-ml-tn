const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'ml_products.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema();
  runMigrations();
  return db;
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS ml_items (
      id TEXT PRIMARY KEY,
      title TEXT,
      category_id TEXT,
      price REAL,
      original_price REAL,
      currency_id TEXT,
      available_quantity INTEGER,
      sold_quantity INTEGER,
      condition TEXT,
      listing_type_id TEXT,
      status TEXT,
      permalink TEXT,
      thumbnail TEXT,
      secure_thumbnail TEXT,
      seller_id INTEGER,
      site_id TEXT,
      buying_mode TEXT,
      warranty TEXT,
      date_created TEXT,
      last_updated TEXT,
      description TEXT,
      raw_json TEXT,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ml_pictures (
      id TEXT,
      item_id TEXT NOT NULL,
      url TEXT,
      secure_url TEXT,
      size TEXT,
      max_size TEXT,
      quality TEXT,
      position INTEGER,
      PRIMARY KEY (id, item_id)
    );

    CREATE TABLE IF NOT EXISTS ml_attributes (
      item_id TEXT NOT NULL,
      attribute_id TEXT NOT NULL,
      name TEXT,
      value_id TEXT,
      value_name TEXT,
      PRIMARY KEY (item_id, attribute_id)
    );

    CREATE TABLE IF NOT EXISTS ml_variations (
      id INTEGER,
      item_id TEXT NOT NULL,
      price REAL,
      available_quantity INTEGER,
      sold_quantity INTEGER,
      seller_custom_field TEXT,
      user_product_id TEXT,
      attributes_label TEXT,
      picture_ids TEXT,
      attribute_combinations TEXT,
      PRIMARY KEY (id, item_id)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      finished_at TEXT,
      total_fetched INTEGER,
      total_saved INTEGER,
      status TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_status ON ml_items(status);
    CREATE INDEX IF NOT EXISTS idx_items_category ON ml_items(category_id);
    CREATE INDEX IF NOT EXISTS idx_items_last_updated ON ml_items(last_updated);
    CREATE TABLE IF NOT EXISTS ecom_ml_mapping (
      ml_item_id      TEXT PRIMARY KEY,
      erp_sku         TEXT,
      titulo_articulo TEXT,
      is_combo        INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_variations_item ON ml_variations(item_id);
    CREATE INDEX IF NOT EXISTS idx_variations_label ON ml_variations(attributes_label);

    CREATE TABLE IF NOT EXISTS tn_products (
      ml_item_id    TEXT PRIMARY KEY,
      tn_product_id TEXT,
      uploaded_at   TEXT,
      last_synced_at TEXT
    );
  `);
}

// Agrega columnas nuevas a tablas existentes si no están (para DBs ya creadas)
function runMigrations() {
  const migrations = [
    `ALTER TABLE ml_variations ADD COLUMN user_product_id TEXT`,
    `ALTER TABLE ml_variations ADD COLUMN attributes_label TEXT`,
    `CREATE TABLE IF NOT EXISTS ml_categories (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      full_path  TEXT,
      fetched_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tn_categories (
      ml_category_id  TEXT PRIMARY KEY,
      tn_category_id  TEXT,
      name            TEXT,
      synced_at       TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ml_tokens (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      updated_at    TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ecom_session (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      cookie     TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tn_order_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tn_order_id  TEXT NOT NULL,
      tn_sku       TEXT,
      erp_sku      TEXT,
      qty_sold     INTEGER,
      qty_before   INTEGER,
      qty_after    INTEGER,
      status       TEXT,
      error        TEXT,
      processed_at TEXT
    )`,
    `ALTER TABLE tn_products ADD COLUMN ecom_link_pending INTEGER DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) { /* ya existe, ignorar */ }
  }
}

function saveMlCategory(cat) {
  db.run(
    `INSERT INTO ml_categories (id, name, full_path, fetched_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, full_path = excluded.full_path, fetched_at = excluded.fetched_at`,
    [n(cat.id), n(cat.name), n(cat.full_path)]
  );
}

function getDistinctCategoryIds() {
  const result = db.exec(`
    SELECT category_id, COUNT(*) as count
    FROM ml_items
    WHERE category_id IS NOT NULL
    GROUP BY category_id
    ORDER BY count DESC
  `);
  if (!result[0]?.values?.length) return [];
  return result[0].values.map(([id, count]) => ({ id, count }));
}

function getExistingCategoryIds() {
  const result = db.exec(`SELECT id FROM ml_categories`);
  if (!result[0]?.values?.length) return new Set();
  return new Set(result[0].values.map(([id]) => id));
}

function getAllCategories() {
  const result = db.exec(`SELECT id, name, full_path FROM ml_categories ORDER BY name`);
  if (!result[0]?.values?.length) return [];
  return result[0].values.map(([id, name, full_path]) => ({ id, name, full_path }));
}

function saveTnCategory(mlCategoryId, tnCategoryId, name) {
  db.run(
    `INSERT INTO tn_categories (ml_category_id, tn_category_id, name, synced_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ml_category_id) DO UPDATE SET
       tn_category_id = excluded.tn_category_id,
       name           = excluded.name,
       synced_at      = excluded.synced_at`,
    [n(mlCategoryId), n(tnCategoryId), n(name)]
  );
}

function getTnCategoryByMlId(mlCategoryId) {
  const result = db.exec(
    `SELECT ml_category_id, tn_category_id, name FROM tn_categories WHERE ml_category_id = ?`,
    [mlCategoryId]
  );
  if (!result[0]?.values?.length) return null;
  const [cols, row] = [result[0].columns, result[0].values[0]];
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
}

function getExistingTnCategoryMlIds() {
  const result = db.exec(`SELECT ml_category_id FROM tn_categories`);
  if (!result[0]?.values?.length) return new Set();
  return new Set(result[0].values.map(([id]) => id));
}

// Devuelve todos los productos TN con su ml_category_id pendientes de asignar
// (o todos si force=true)
function getProductsForCategoryUpdate(force = false) {
  const filter = force ? '' : `AND tp.last_synced_at IS NULL`;
  const result = db.exec(`
    SELECT tp.ml_item_id, tp.tn_product_id, i.category_id
    FROM   tn_products tp
    JOIN   ml_items i ON i.id = tp.ml_item_id
    WHERE  i.category_id IS NOT NULL
    ${filter}
    ORDER  BY tp.ml_item_id
  `);
  if (!result[0]?.values?.length) return [];
  return result[0].values.map(([ml_item_id, tn_product_id, category_id]) => ({
    ml_item_id, tn_product_id, category_id,
  }));
}

function markProductSynced(mlItemId) {
  db.run(
    `UPDATE tn_products SET last_synced_at = datetime('now') WHERE ml_item_id = ?`,
    [mlItemId]
  );
}

function getTokens() {
  const result = db.exec(
    `SELECT access_token, refresh_token, expires_at, updated_at FROM ml_tokens WHERE id = 1`
  );
  if (!result[0]?.values?.length) return null;
  const [cols, row] = [result[0].columns, result[0].values[0]];
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
}

function saveEcomSession(cookie, expires_at) {
  db.run(
    `INSERT INTO ecom_session (id, cookie, expires_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cookie = excluded.cookie, expires_at = excluded.expires_at`,
    [cookie, expires_at]
  );
  saveToFile();
}

function getEcomSession() {
  const result = db.exec(`SELECT cookie, expires_at FROM ecom_session WHERE id = 1`);
  if (!result[0]?.values?.length) return null;
  const [cols, row] = [result[0].columns, result[0].values[0]];
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
}

function logTnOrder(entry) {
  db.run(
    `INSERT INTO tn_order_log
       (tn_order_id, tn_sku, erp_sku, qty_sold, qty_before, qty_after, status, error, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      n(entry.tn_order_id), n(entry.tn_sku),    n(entry.erp_sku),
      n(entry.qty_sold),    n(entry.qty_before), n(entry.qty_after),
      n(entry.status),      n(entry.error),
    ]
  );
  saveToFile();
}

function saveTokens({ access_token, refresh_token, expires_at }) {
  db.run(
    `INSERT INTO ml_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       updated_at    = excluded.updated_at`,
    [access_token, refresh_token, expires_at]
  );
  saveToFile();
}

function saveToFile() {
  const data = db.export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Convierte undefined a null para sql.js
function n(v) { return v ?? null; }

// Construye label legible de attribute_combinations
// Ej: "Color del colchón: Gris oscuro | Talle: XL"
function buildAttributesLabel(combinations) {
  if (!combinations?.length) return null;
  return combinations
    .map((c) => `${c.name}: ${c.value_name}`)
    .join(' | ');
}

function upsertItem(item) {
  db.run(`
    INSERT INTO ml_items (
      id, title, category_id, price, original_price, currency_id,
      available_quantity, sold_quantity, condition, listing_type_id,
      status, permalink, thumbnail, secure_thumbnail, seller_id, site_id,
      buying_mode, warranty, date_created, last_updated, description, raw_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      price = excluded.price,
      original_price = excluded.original_price,
      available_quantity = excluded.available_quantity,
      sold_quantity = excluded.sold_quantity,
      status = excluded.status,
      last_updated = excluded.last_updated,
      description = excluded.description,
      raw_json = excluded.raw_json,
      synced_at = datetime('now')
  `, [
    n(item.id), n(item.title), n(item.category_id), n(item.price),
    n(item.original_price), n(item.currency_id),
    n(item.available_quantity), n(item.sold_quantity),
    n(item.condition), n(item.listing_type_id), n(item.status),
    n(item.permalink), n(item.thumbnail), n(item.secure_thumbnail),
    n(item.seller_id), n(item.site_id), n(item.buying_mode),
    n(item.warranty), n(item.date_created), n(item.last_updated),
    n(item._description),
    JSON.stringify(item),
  ]);

  // --- Imágenes ---
  // Caso 1: el item tiene pictures propias (con o sin variaciones)
  if (item.pictures?.length) {
    for (const [i, pic] of item.pictures.entries()) {
      db.run(`
        INSERT OR REPLACE INTO ml_pictures (id, item_id, url, secure_url, size, max_size, quality, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [n(pic.id), n(item.id), n(pic.url), n(pic.secure_url), n(pic.size), n(pic.max_size), n(pic.quality), i]);
    }
  } else if (item.thumbnail) {
    // Caso 2: no hay pictures pero sí thumbnail — lo guardamos como única imagen
    db.run(`
      INSERT OR REPLACE INTO ml_pictures (id, item_id, url, secure_url, size, max_size, quality, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [n(item.thumbnail_id ?? item.id + '_thumb'), n(item.id), n(item.thumbnail), n(item.thumbnail?.replace('http://', 'https://')), null, null, null, 0]);
  }

  // --- Atributos ---
  if (item.attributes?.length) {
    for (const attr of item.attributes) {
      db.run(`
        INSERT OR REPLACE INTO ml_attributes (item_id, attribute_id, name, value_id, value_name)
        VALUES (?, ?, ?, ?, ?)
      `, [n(item.id), n(attr.id), n(attr.name), n(attr.value_id), n(attr.value_name)]);
    }
  }

  // --- Variaciones ---
  if (item.variations?.length) {
    for (const v of item.variations) {
      const label = buildAttributesLabel(v.attribute_combinations);
      db.run(`
        INSERT OR REPLACE INTO ml_variations (
          id, item_id, price, available_quantity, sold_quantity,
          seller_custom_field, user_product_id, attributes_label,
          picture_ids, attribute_combinations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        n(v.id), n(item.id), n(v.price), n(v.available_quantity), n(v.sold_quantity),
        n(v.seller_custom_field), n(v.user_product_id),
        n(label),
        JSON.stringify(v.picture_ids ?? []),
        JSON.stringify(v.attribute_combinations ?? []),
      ]);
    }
  }
}

function startSyncLog() {
  db.run(`INSERT INTO sync_log (started_at, status) VALUES (datetime('now'), 'running')`);
  const result = db.exec('SELECT last_insert_rowid() as id');
  return result[0].values[0][0];
}

function finishSyncLog(logId, { total_fetched, total_saved, status, error }) {
  db.run(
    `UPDATE sync_log SET finished_at = datetime('now'), total_fetched = ?, total_saved = ?, status = ?, error = ? WHERE id = ?`,
    [total_fetched, total_saved, status, error ?? null, logId]
  );
}

function getStats() {
  const total = db.exec("SELECT COUNT(*) FROM ml_items")[0]?.values[0][0] ?? 0;
  const active = db.exec("SELECT COUNT(*) FROM ml_items WHERE status = 'active'")[0]?.values[0][0] ?? 0;
  const paused = db.exec("SELECT COUNT(*) FROM ml_items WHERE status = 'paused'")[0]?.values[0][0] ?? 0;
  const withVariations = db.exec("SELECT COUNT(DISTINCT item_id) FROM ml_variations")[0]?.values[0][0] ?? 0;
  const lastSync = db.exec("SELECT MAX(synced_at) FROM ml_items")[0]?.values[0][0] ?? null;
  return { total, active, paused, withVariations, lastSync };
}

function getErpMapping(mlItemId) {
  const result = db.exec(
    `SELECT ml_item_id, erp_sku, titulo_articulo, is_combo FROM ecom_ml_mapping WHERE ml_item_id = ?`,
    [mlItemId]
  );
  if (!result[0]?.values?.length) return null;
  const [cols, row] = [result[0].columns, result[0].values[0]];
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
}

// Guarda un nuevo producto TN creado por el nuevo flujo (con link pendiente en EcomExperts)
function saveTnProductPending(mlItemId, tnProductId) {
  db.run(
    `INSERT INTO tn_products (ml_item_id, tn_product_id, uploaded_at, ecom_link_pending)
     VALUES (?, ?, datetime('now'), 1)
     ON CONFLICT(ml_item_id) DO UPDATE SET
       tn_product_id     = excluded.tn_product_id,
       uploaded_at       = excluded.uploaded_at,
       last_synced_at    = NULL,
       ecom_link_pending = 1`,
    [mlItemId, tnProductId]
  );
  saveToFile();
}

// Retorna todos los items con ecom_link_pending = 1
function getPendingEcomLinks() {
  return rawQuery(`SELECT ml_item_id, tn_product_id FROM tn_products WHERE ecom_link_pending = 1`);
}

// Marca un item como linkeado en EcomExperts (ecom_link_pending = 0)
function markEcomLinked(mlItemId) {
  db.run(`UPDATE tn_products SET ecom_link_pending = 0 WHERE ml_item_id = ?`, [mlItemId]);
  saveToFile();
}

function saveTnProduct(mlItemId, tnProductId) {
  db.run(
    `INSERT INTO tn_products (ml_item_id, tn_product_id, uploaded_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(ml_item_id) DO UPDATE SET
       tn_product_id  = excluded.tn_product_id,
       uploaded_at    = excluded.uploaded_at,
       last_synced_at = NULL`,
    [mlItemId, tnProductId]
  );
  saveToFile();
}

function getTnProduct(mlItemId) {
  const result = db.exec(
    `SELECT ml_item_id, tn_product_id, uploaded_at, last_synced_at
     FROM tn_products WHERE ml_item_id = ?`,
    [mlItemId]
  );
  if (!result[0]?.values?.length) return null;
  const [cols, row] = [result[0].columns, result[0].values[0]];
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
}

// Ejecuta una query SQL y retorna array de objetos.
function rawQuery(sql, params = []) {
  const rows = db.exec(sql, params);
  if (!rows.length) return [];
  const { columns, values } = rows[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

module.exports = {
  getDb, upsertItem, saveToFile, startSyncLog, finishSyncLog, getStats,
  getErpMapping, saveTnProduct, getTnProduct, saveTnProductPending, getPendingEcomLinks, markEcomLinked,
  saveMlCategory, getDistinctCategoryIds, getExistingCategoryIds, getAllCategories,
  saveTnCategory, getTnCategoryByMlId, getExistingTnCategoryMlIds,
  getProductsForCategoryUpdate, markProductSynced,
  getTokens, saveTokens,
  saveEcomSession, getEcomSession,
  logTnOrder,
  rawQuery,
};
