/**
 * Mapea un item de ML (tal como viene de la DB) al formato de producto TiendaNube.
 *
 * TN structure:
 * {
 *   name: { es: "..." },
 *   description: { es: "..." },
 *   attributes: [{ es: "Color" }, { es: "Talle" }],   // ejes de variación
 *   variants: [
 *     { price, stock, sku, values: [{ es: "Rojo" }, { es: "XL" }] }
 *   ],
 *   images: [{ src: "https://..." }]
 * }
 */
function mapMlItemToTn(item) {
  const variations = item.variations ?? [];
  const pictures   = item.pictures   ?? [];

  // --- Imágenes ---
  // Usamos secure_url si está, sino url
  const images = pictures
    .map((p) => ({ src: p.secure_url ?? p.url }))
    .filter((p) => p.src);

  // --- Helper: precios con soporte de precio promocional ---
  // Si ML tiene original_price → hay descuento activo:
  //   TN price             = original_price (precio regular/tachado)
  //   TN promotional_price = price (precio con descuento)
  // Si no hay original_price → precio normal, sin promoción.
  function buildPrices(sellingPrice, originalPrice) {
    if (originalPrice && originalPrice > sellingPrice) {
      return {
        price:             String(originalPrice),
        promotional_price: String(sellingPrice),
      };
    }
    return { price: String(sellingPrice ?? 0) };
  }

  // --- Producto sin variaciones ---
  if (variations.length === 0) {
    return {
      name:        { es: item.title },
      description: { es: item.description ?? '' },
      images,
      variants: [
        {
          ...buildPrices(item.price, item.original_price),
          stock:           item.available_quantity ?? 0,
          sku:             item.id,                    // ID de ML como SKU
          inventory_management: 'default',
        },
      ],
    };
  }

  // --- Producto con variaciones ---

  // 1. Extraer los ejes de variación (ej: ["Color del colchón"])
  //    TN soporta máximo 3 atributos de variación
  const MAX_ATTRS = 3;
  const attributeNames = (variations[0].attribute_combinations ?? [])
    .map((c) => c.name)
    .slice(0, MAX_ATTRS);

  const attributes = attributeNames.map((name) => ({ es: name }));

  // 2. Construir cada variant de TN
  // original_price en ML vive a nivel del item, no de la variación.
  // Si la variación tiene el mismo precio que el item, usamos original_price directo
  // para evitar diferencias de redondeo. Solo calculamos por ratio cuando el precio
  // de la variación difiere del item (ej: distintos talles con distinto precio base).
  function computeVarOriginal(varPrice) {
    if (!item.original_price || item.original_price <= item.price) return null;
    if (varPrice === item.price) return item.original_price;
    const ratio = item.original_price / item.price;
    return Math.round(varPrice * ratio * 100) / 100;
  }

  const variants = variations.map((v) => {
    // values en el mismo orden que attributes (máximo MAX_ATTRS)
    const values = (v.attribute_combinations ?? [])
      .slice(0, MAX_ATTRS)
      .map((c) => ({ es: c.value_name }));

    // Imágenes específicas de esta variación (referenciadas por picture_id)
    const variationImages = (v.picture_ids ?? [])
      .map((picId) => {
        const pic = pictures.find((p) => p.id === picId);
        return pic ? { src: pic.secure_url ?? pic.url } : null;
      })
      .filter(Boolean);

    const varSellingPrice = v.price ?? item.price ?? 0;
    const varOriginalPrice = computeVarOriginal(varSellingPrice);

    return {
      ...buildPrices(varSellingPrice, varOriginalPrice),
      stock:           v.available_quantity ?? 0,
      sku:             v.seller_custom_field ?? `${item.id}-${v.id}`,
      values,
      // Si la variación tiene imágenes propias las pasamos, sino TN usa las del producto
      ...(variationImages.length > 0 && { image: variationImages[0] }),
      inventory_management: 'default',
    };
  });

  return {
    name:        { es: item.title },
    description: { es: item.description ?? '' },
    attributes,
    variants,
    images,
  };
}

module.exports = { mapMlItemToTn };
