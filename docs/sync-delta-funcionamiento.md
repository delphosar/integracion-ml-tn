# sync-delta.js — Qué hace y cómo funciona

## Propósito

`sync-delta` es el proceso de sincronización que corre en el VPS cada **30 minutos** (via PM2 + cron).

Su única responsabilidad es **actualizar los precios en TiendaNube cuando cambian en MercadoLibre**.
No crea productos, no modifica stock, no toca nada fuera de los pares ya vinculados.

---

## Qué sincroniza (y qué NO)

| ¿Qué? | ¿Lo sincroniza? |
|---|---|
| Precio de venta ML → TN | ✅ sí |
| Precio tachado (descuento) ML → TN | ✅ sí |
| Promociones ML (SMART, DEAL, etc.) → TN | ✅ sí |
| Stock | ❌ no (`PRICES_ONLY = true` hardcodeado) |
| Creación de productos nuevos | ❌ no |
| Imágenes, descripciones, atributos | ❌ no |

El stock lo gestiona la integración nativa EcomExperts ↔ TiendaNube directamente (ver sección más abajo).

---

## Flujo paso a paso

```
1. Obtiene token ML válido (con refresh automático si venció)
2. Carga de SQLite todos los pares:  ml_item_id ↔ tn_product_id  (solo items con status = 'active')
3. Para cada batch de 20 items:
   a. Llama a GET /items?ids=...  → obtiene price, original_price, variations, status
   b. Llama a GET /seller-promotions/items/{id}  → detecta promos activas (SMART, DEAL, etc.)
   c. Si hay promo activa con status='started': sobreescribe price/original_price del item
   d. Compara los valores obtenidos con los guardados en SQLite (última sincronización)
   e. Si no hubo cambio → salta al siguiente
   f. Si hubo cambio → actualiza TiendaNube + actualiza SQLite
4. Si un producto TN devuelve 404 → lo elimina de la tabla tn_products (auto-limpieza)
5. Al final: loguea estadísticas (verificados / cambiados / actualizados / errores)
```

---

## Lógica de precios

MercadoLibre y TiendaNube usan convenciones distintas:

| Campo | MercadoLibre | TiendaNube |
|---|---|---|
| Precio de venta (lo que paga el cliente) | `price` | `promotional_price` |
| Precio tachado (mayor, referencia) | `original_price` | `price` |

**Regla de mapeo:**

```
Si original_price existe Y original_price > price:
    TN price             = ML original_price   ← precio tachado
    TN promotional_price = ML price             ← precio con descuento

Si no hay descuento real:
    TN price             = ML price
    TN promotional_price = null                 ← se limpia el descuento en TN
```

### Caso especial: Promociones de ML (Central de Promociones)

Las promociones creadas en el panel de ML (SMART, DEAL, LIGHTNING, etc.) **no modifican
los campos `price`/`original_price` del item** → por eso no se detectaban antes.

El script resuelve esto consultando `/seller-promotions/items/{id}?app_version=v2` por
cada item y, si encuentra una promo con `status = 'started'`, sobreescribe los valores
antes de continuar con la detección de cambios.

En el log aparece como: `[CAMBIO] MLA123456 → TN:337xxxxxx [PROMO:SMART]`

---

## Productos con variaciones

Para items **sin variaciones** (producto simple):
- Detecta cambio en `price` y `original_price` a nivel item
- Actualiza la única variante TN con el precio correspondiente

Para items **con variaciones**:
- `original_price` vive a nivel item (no de variante) → se detecta por separado
- Cada variante ML se compara con su registro en `ml_variations` en SQLite
- El precio del item padre ML se aplica a **todas** las variantes TN (no hay match por SKU para precios)
- El log indica cuántas variaciones cambiaron

---

## Dónde corre

- **VPS**, proceso PM2 llamado `ml-tn-sync-delta`
- Cron: `*/30 * * * *` (cada 30 minutos, los :00 y los :30)
- `autorestart: false` — es un script puntual, no un daemon; PM2 solo lo relanza por cron
- No tiene `--dry-run` activado en producción → escribe cambios reales en TN y SQLite

---

## Base de datos SQLite involucrada

Archivo: `data/ml_products.db`

| Tabla | Uso en sync-delta |
|---|---|
| `tn_products` | Fuente de pares ml_item_id ↔ tn_product_id |
| `ml_items` | Precio/stock anterior (referencia para detectar cambios) |
| `ml_variations` | Precio/stock anterior de cada variante |
| `ml_tokens` | Token ML con refresh automático |

---

## Integración nativa EcomExperts ↔ TiendaNube (stock)

Esta parte **no depende de ningún script nuestro** — es una integración propia de la plataforma EcomExperts.

### Cómo funciona

EcomExperts tiene un módulo de integración con TiendaNube que sincroniza el stock automáticamente.
El mecanismo que usa es **"Vincular Productos Existentes"**: empareja los productos de TN con los
del ERP usando el **SKU** como clave de matching.

Una vez que un producto TN está vinculado al ERP:
- Cuando baja el stock en EcomExperts (por una venta, ajuste, etc.) → EcomExperts actualiza el stock en TN
- Cuando sube el stock (por una reposición) → ídem

### Por qué nuestro script no toca el stock

`sync-delta` tiene `PRICES_ONLY = true` hardcodeado precisamente para **no pisar** lo que hace
la integración nativa. Si sincronizáramos stock desde ML también, habría conflicto entre dos
fuentes de verdad (ML vs ERP).

La fuente de verdad para el stock es **EcomExperts ERP**, no MercadoLibre.

### Estado actual de los productos vinculados

De los 828 productos en TN:

| Estado | Cantidad | Detalle |
|---|---|---|
| Vinculados con ML activo | 520 | Tienen ML ID + están activos en ML |
| Vinculados con ML pausado | 179 | Tienen ML ID pero la publicación está pausada |
| Sin ML ID (solo ERP↔TN) | 129 | Creados por EcomExperts directamente, sin publicación ML asociada |

Los 129 productos sin ML ID igual pueden estar vinculados ERP↔TN y tener stock sincronizado
por EcomExperts — simplemente no tienen publicación en MercadoLibre.

---

## Proceso paralelo: tn-webhook

El otro proceso corriendo en PM2 (`tn-webhook`) es independiente:
- Escucha webhooks de TiendaNube (puerto 3001)
- Cuando llega una orden TN → descuenta stock en EcomExperts ERP
- No tiene interacción con sync-delta

---

## Comandos útiles

```bash
# Ver estado de los procesos en VPS
pm2 status

# Ver logs en tiempo real
pm2 logs ml-tn-sync-delta

# Correr manualmente con dry-run (sin escribir en TN)
node src/sync-delta.js --dry-run

# Correr con debug de un item específico
node src/sync-delta.js --dry-run --debug-item=MLA1234567890
```
