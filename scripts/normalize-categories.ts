/**
 * One-off backfill: normalize free-form `category` values in prospects table
 * to one of the 6 canonical buckets.
 *
 * Usage:
 *   tsx scripts/normalize-categories.ts          # dry run, prints summary
 *   tsx scripts/normalize-categories.ts --apply  # writes changes
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const VALID_CATEGORIES = ['Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'];

function classifyProspect(name: string, specialty: string, aiCategory: string): string {
  const text = (specialty + ' ' + name + ' ' + aiCategory).toLowerCase();
  if (text.includes('notario') || text.includes('notaria') || text.includes('abogad') || text.includes('legal') || text.includes('jurídic') || text.includes('juridic') || text.includes('despacho jurídico') || text.includes('licenciado en derecho')) return 'Legal';
  if (text.includes('doctor') || text.includes('médic') || text.includes('medic') || text.includes('dentist') || text.includes('clínica') || text.includes('clinica') || text.includes('hospital') || text.includes('ciruj') || text.includes('salud') || text.includes('sanidad') || text.includes('cardiólog') || text.includes('cardiologist') || text.includes('pediatr') || text.includes('ginecólog') || text.includes('gynecolog') || text.includes('dermatólog') || text.includes('oftalmólog') || text.includes('ophthalmolog') || text.includes('neurólog') || text.includes('neurolog') || text.includes('ortoped') || text.includes('urólog') || text.includes('psiquiatr') || text.includes('psicólog') || text.includes('oncólog') || text.includes('gastro') || text.includes('neumólog') || text.includes('endocrin') || text.includes('odontólog') || text.includes('fisioter') || text.includes('nutriólog')) return 'Salud';
  if (text.includes('inversionista') || text.includes('empresari') || text.includes('emprendedor') || text.includes('dueño') || text.includes('socio') || text.includes('capital') || text.includes('bienes raíces') || text.includes('bienes raices') || text.includes('inmobiliar')) return 'Inversión';
  if (text.includes('arquitect') || text.includes('ingenier') || text.includes('construcción') || text.includes('construccion') || text.includes('civil')) return 'Arquitectura';
  if (text.includes('profesional') || text.includes('especialista') || text.includes('consult') || text.includes('contador') || text.includes('project manager')) return 'Profesionales';
  if (VALID_CATEGORIES.includes(aiCategory)) return aiCategory;
  return 'Otros';
}

function normalizeCategory(rawCategory: string | undefined, name: string, specialty: string): string {
  const c = (rawCategory || '').trim();
  if (VALID_CATEGORIES.includes(c)) return c;
  return classifyProspect(name || '', specialty || '', c);
}

const apply = process.argv.includes('--apply');
const dbPath = path.join(process.cwd(), 'prospectos.db');
const db = new Database(dbPath);

const rows = db.prepare("SELECT id, name, specialty, category FROM prospects").all() as any[];
const transitions: Record<string, Record<string, number>> = {};
const toUpdate: Array<{ id: string; from: string; to: string }> = [];

for (const r of rows) {
  const from = r.category || '';
  const to = normalizeCategory(from, r.name, r.specialty);
  if (from !== to) toUpdate.push({ id: r.id, from, to });
  transitions[from] = transitions[from] || {};
  transitions[from][to] = (transitions[from][to] || 0) + 1;
}

console.log(`Total prospects: ${rows.length}`);
console.log(`Rows needing update: ${toUpdate.length}`);
console.log('\nTransitions (from → to: count):');
const sorted = Object.entries(transitions).sort((a, b) => {
  const aCount = Object.values(a[1]).reduce((s, n) => s + n, 0);
  const bCount = Object.values(b[1]).reduce((s, n) => s + n, 0);
  return bCount - aCount;
});
for (const [from, tos] of sorted) {
  for (const [to, count] of Object.entries(tos)) {
    const marker = from === to ? '  ' : '→ ';
    console.log(`  ${marker}${from || '(empty)'} → ${to}: ${count}`);
  }
}

const finalCounts: Record<string, number> = {};
for (const r of rows) {
  const final = normalizeCategory(r.category, r.name, r.specialty);
  finalCounts[final] = (finalCounts[final] || 0) + 1;
}
console.log('\nFinal distribution after normalization:');
for (const cat of VALID_CATEGORIES) {
  console.log(`  ${cat}: ${finalCounts[cat] || 0}`);
}

if (!apply) {
  console.log('\n(dry run — pass --apply to write changes)');
  process.exit(0);
}

const update = db.prepare("UPDATE prospects SET category = ? WHERE id = ?");
const tx = db.transaction((items: typeof toUpdate) => {
  for (const it of items) update.run(it.to, it.id);
});
tx(toUpdate);
console.log(`\nUpdated ${toUpdate.length} rows.`);
