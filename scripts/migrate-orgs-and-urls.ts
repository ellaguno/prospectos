// Standalone maintenance script: migrate org-like prospects to the
// organizations table and resolve vertexaisearch grounding-redirect URLs.
//
// Usage:
//   tsx scripts/migrate-orgs-and-urls.ts                # full run
//   tsx scripts/migrate-orgs-and-urls.ts --dry          # preview only
//   tsx scripts/migrate-orgs-and-urls.ts --orgs-only
//   tsx scripts/migrate-orgs-and-urls.ts --urls-only
//   tsx scripts/migrate-orgs-and-urls.ts --url-limit=500
//
// Operates directly on prospectos.db in the project root.
import Database from "better-sqlite3";
import path from "path";

const args = new Set(process.argv.slice(2));
const argv = process.argv.slice(2);
const flag = (n: string) => args.has(n);
const opt = (n: string, def: number) => {
  const m = argv.find(a => a.startsWith(n + "="));
  if (!m) return def;
  const v = parseInt(m.split("=")[1] || "");
  return Number.isFinite(v) ? v : def;
};

const DRY = flag("--dry");
const ORGS_ONLY = flag("--orgs-only");
const URLS_ONLY = flag("--urls-only");
const URL_LIMIT = opt("--url-limit", 5000);
const URL_CONCURRENCY = opt("--concurrency", 8);

const db = new Database(path.resolve("prospectos.db"));

// ---- Mirror of looksLikeOrganization in server.ts ----
function looksLikeOrganization(name: string, specialty?: string): { isOrg: boolean; type: string } {
  const n = (name || "").trim();
  if (!n) return { isOrg: false, type: "" };
  const spec = (specialty || "").toLowerCase();
  if (/^(dr\.?|dra\.?|lic\.?|ing\.?|arq\.?|c\.?p\.?|mtr[oa]\.?|prof\.?)\s+/i.test(n)) return { isOrg: false, type: "" };
  if (/\.(com|mx|net|org|com\.mx|gob\.mx|edu\.mx|info|biz|io|co)$/i.test(n.replace(/\s+/g, ""))) return { isOrg: true, type: "empresa" };
  if (/\b(s\.?\s*a\.?(\s*de\s*c\.?\s*v\.?)?|s\.?\s*c\.?|s\.?\s*r\.?\s*l\.?|s\.?\s*de\s*r\.?\s*l\.?|inc\.?|corp\.?|ltd\.?|llc\.?|gmbh|a\.?\s*c\.?)\b/i.test(n)) return { isOrg: true, type: "empresa" };
  const sectorMap: Array<[RegExp, string]> = [
    [/\b(hospital|clínica|clinica|sanatorio|centro\s+médico|centro\s+medico|laboratorio)\b/i, "clinica"],
    [/\b(despacho|bufete|notar[íi]a|notaria)\b/i, "despacho"],
    [/\b(universidad|instituto|tecnol[oó]gico|colegio|escuela|facultad)\b/i, "universidad"],
    [/\b(asociaci[oó]n|fundaci[oó]n|c[aá]mara|colegio\s+de|cooperativa|sindicato)\b/i, "asociacion"],
    [/\b(secretar[íi]a\s+de|gobierno|municipio|ayuntamiento|delegaci[oó]n|fiscal[íi]a|congreso)\b/i, "gobierno"],
    [/\b(grupo|corporativo|holding|consorcio|constructora|inmobiliaria|desarrolladora|consultor[íi]a|consultoria|aseguradora|seguros|financiera|banco|automotriz|farmac[eé]utica)\b/i, "empresa"],
    [/\b(arquitectos|ingenieros|consultores|asociados|abogados|contadores|hermanos)\s*$/i, "despacho"],
    [/\b(restaurante|hotel|tienda|boutique|farmacia|distribuidora|comercializadora)\b/i, "empresa"],
  ];
  for (const [re, t] of sectorMap) if (re.test(n)) return { isOrg: true, type: t };
  if (/\b(empresa|compa[ñn][íi]a|firma|despacho|hospital|cl[íi]nica)\b/i.test(spec)) return { isOrg: true, type: "empresa" };
  if (/^\d+[A-ZÁÉÍÓÚÑ]{2,}/.test(n)) return { isOrg: true, type: "empresa" };
  return { isOrg: false, type: "" };
}

async function resolveRedirectUrl(rawUrl: string): Promise<string | null> {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(rawUrl, {
      redirect: "follow",
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-MX,es;q=0.9",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok || res.status >= 400) return null;
    const finalUrl = (res as any).url || rawUrl;
    if (/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i.test(finalUrl)) return null;
    return finalUrl;
  } catch {
    return null;
  }
}

function getOrCreateOrgIdByName(userId: string, name: string, type: string, opts: { website?: string; phone?: string; email?: string; location?: string }): { id: string; created: boolean } {
  const trimmed = (name || "").trim();
  const found = db.prepare("SELECT id FROM organizations WHERE userId = ? AND LOWER(name) = LOWER(?)").get(userId, trimmed) as any;
  if (found?.id) return { id: found.id, created: false };
  const id = Math.random().toString(36).substr(2, 9);
  db.prepare("INSERT INTO organizations (id, name, type, location, website, phone, email, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, trimmed, type || "", opts.location || "", opts.website || "", opts.phone || "", opts.email || "", userId);
  return { id, created: true };
}

async function migrateOrgs() {
  const rows = db.prepare(
    "SELECT id, userId, name, specialty, location, contact, email, url FROM prospects WHERE organizationId IS NULL OR organizationId = ''"
  ).all() as any[];
  const matches = rows.map(p => ({ p, ...looksLikeOrganization(p.name, p.specialty) })).filter(x => x.isOrg);
  console.log(`[migrate-orgs] candidatos: ${matches.length} de ${rows.length} prospectos sin org`);
  if (matches.length === 0) return;

  // Show some samples
  console.log("[migrate-orgs] muestra:");
  for (const m of matches.slice(0, 15)) console.log(`  • [${m.type}] ${m.p.name}`);

  if (DRY) {
    console.log("[migrate-orgs] DRY-RUN — no se escribió nada");
    return;
  }

  let created = 0, migrated = 0;
  const tx = db.transaction(() => {
    for (const m of matches) {
      const r = getOrCreateOrgIdByName(m.p.userId, m.p.name, m.type, {
        website: m.p.url || "", phone: m.p.contact || "", email: m.p.email || "", location: m.p.location || "",
      });
      if (r.created) created++;
      db.prepare("DELETE FROM prospects WHERE id = ?").run(m.p.id);
      migrated++;
    }
  });
  tx();
  console.log(`[migrate-orgs] migrados: ${migrated}, organizaciones nuevas: ${created}`);
}

async function resolveUrls() {
  const rows = db.prepare(
    "SELECT id, url FROM prospects WHERE url LIKE '%vertexaisearch.cloud.google.com/grounding-api-redirect/%' LIMIT ?"
  ).all(URL_LIMIT) as any[];
  console.log(`[resolve-urls] a procesar: ${rows.length} (concurrencia ${URL_CONCURRENCY})`);
  if (rows.length === 0) return;

  if (DRY) {
    console.log("[resolve-urls] DRY-RUN — no se hace fetch ni se escribe");
    return;
  }

  let resolved = 0, cleared = 0, done = 0;
  // Simple worker pool
  const queue = rows.slice();
  const workers = Array.from({ length: URL_CONCURRENCY }, async () => {
    while (queue.length) {
      const r = queue.shift();
      if (!r) break;
      const finalUrl = await resolveRedirectUrl(r.url);
      if (finalUrl) {
        db.prepare("UPDATE prospects SET url = ? WHERE id = ?").run(finalUrl, r.id);
        resolved++;
      } else {
        db.prepare("UPDATE prospects SET url = '' WHERE id = ?").run(r.id);
        cleared++;
      }
      done++;
      if (done % 25 === 0) console.log(`[resolve-urls] ${done}/${rows.length} (resueltas: ${resolved}, eliminadas: ${cleared})`);
    }
  });
  await Promise.all(workers);
  console.log(`[resolve-urls] terminado: ${resolved} resueltas, ${cleared} eliminadas`);
}

(async () => {
  console.log(`[migrate] DB: prospectos.db | dry=${DRY} orgsOnly=${ORGS_ONLY} urlsOnly=${URLS_ONLY}`);
  if (!URLS_ONLY) await migrateOrgs();
  if (!ORGS_ONLY) await resolveUrls();
  db.close();
  console.log("[migrate] Listo.");
})().catch((err) => {
  console.error("[migrate] ERROR:", err);
  process.exit(1);
});
