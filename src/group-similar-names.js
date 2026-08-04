/**
 * group-similar-names.js
 *
 * Lee data/tn-all-products.json y agrupa todos los productos TN
 * cuyos títulos son muy similares (posibles duplicados).
 *
 * Similaridad: Jaccard sobre palabras normalizadas >= THRESHOLD
 *              + captura títulos que son prefijo uno del otro (diff <= 6 chars)
 *
 * Uso: node src/group-similar-names.js [--threshold 0.80]
 * Salida: data/tn-similar-groups.json
 */

const fs   = require('fs');
const path = require('path');

const IN  = path.join(__dirname, '..', 'data', 'tn-all-products.json');
const OUT = path.join(__dirname, '..', 'data', 'tn-similar-groups.json');

// Umbral de similitud Jaccard (0-1). 0.82 = al menos 82% de palabras en común.
const THRESHOLD = (() => {
  const i = process.argv.indexOf('--threshold');
  return i !== -1 ? parseFloat(process.argv[i + 1]) : 0.82;
})();

// ── helpers ─────────────────────────────────────────────────────────────────

// Quita tildes y normaliza a minúsculas
function deaccent(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Tokeniza: minúsculas, sin tildes, solo palabras de 2+ chars
function tokenize(title) {
  return deaccent(title)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

// Jaccard sobre arrays de tokens
function jaccard(tokA, tokB) {
  const setA = new Set(tokA);
  const setB = new Set(tokB);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

// ¿Un título es prefijo del otro? (diff de largo <= maxDiff chars tras normalizar)
function isPrefixPair(nA, nB, maxDiff = 6) {
  const [short, long] = nA.length <= nB.length ? [nA, nB] : [nB, nA];
  if (long.length - short.length > maxDiff) return false;
  return long.startsWith(short) || deaccent(long).startsWith(deaccent(short));
}

// Union-Find para agrupar pares en componentes conectados
function buildGroups(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a, b) { parent[find(a)] = find(b); }
  for (const [a, b] of edges) union(a, b);

  const groups = {};
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(i);
  }
  return Object.values(groups).filter(g => g.length > 1);
}

// ── main ─────────────────────────────────────────────────────────────────────

function getName(nameObj) {
  if (!nameObj) return '';
  if (typeof nameObj === 'string') return nameObj;
  return nameObj.es ?? nameObj.pt ?? nameObj.en ?? Object.values(nameObj)[0] ?? '';
}

const products = JSON.parse(fs.readFileSync(IN, 'utf8'));
console.log(`\nProductos cargados: ${products.length}`);
console.log(`Umbral Jaccard: ${THRESHOLD}\n`);

// Preparar datos normalizados
const items = products.map(p => {
  const title = getName(p.name).trim().replace(/\s+/g, ' ');
  return {
    tn_product_id: String(p.id),
    title,
    norm: deaccent(title).replace(/\s+/g, ' ').trim(),
    tokens: tokenize(title),
    sku: p.variants?.[0]?.sku ?? null,
    variant_count: p.variants?.length ?? 0,
  };
});

// Comparar todos los pares O(n²)
const n = items.length;
const edges = [];
let comparisons = 0;

process.stdout.write('Calculando similitudes...');
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    comparisons++;
    const a = items[i], b = items[j];

    // Descarte rápido: diferencia de cantidad de tokens > 3
    if (Math.abs(a.tokens.length - b.tokens.length) > 4) continue;

    const sim = jaccard(a.tokens, b.tokens);
    if (sim >= THRESHOLD || isPrefixPair(a.norm, b.norm)) {
      edges.push([i, j, sim]);
    }
  }
  if (i % 100 === 0) process.stdout.write(`\r  ${i}/${n} filas procesadas...   `);
}
console.log(`\r  ${n}/${n} filas procesadas. Pares similares: ${edges.length}   `);

// Agrupar con Union-Find
const rawGroups = buildGroups(n, edges);

// Armar resultado final
const groups = rawGroups.map(idxs => {
  const members = idxs.map(i => items[i]).sort((a, b) => a.title.localeCompare(b.title, 'es'));
  return {
    count: members.length,
    titles_preview: members.map(m => m.title),
    members: members.map(m => ({
      tn_product_id: m.tn_product_id,
      title: m.title,
      sku: m.sku,
      variant_count: m.variant_count,
    })),
  };
}).sort((a, b) => a.members[0].title.localeCompare(b.members[0].title, 'es'));

console.log(`\nGrupos con nombres similares: ${groups.length}`);

fs.writeFileSync(OUT, JSON.stringify(groups, null, 2));
console.log(`Reporte guardado en data/tn-similar-groups.json\n`);

// Preview en consola
groups.forEach((g, i) => {
  console.log(`[${String(i + 1).padStart(3)}] (${g.count} productos)`);
  g.members.forEach(m => {
    console.log(`       TN:${m.tn_product_id}  SKU:${m.sku ?? '(sin sku)'}  "${m.title}"`);
  });
});

const total = groups.reduce((s, g) => s + g.count, 0);
console.log(`\nTotal productos en grupos similares: ${total}`);
