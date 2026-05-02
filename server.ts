import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import cors from "cors";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

dotenv.config({ override: true });

// --- Gemini Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const geminiEnabled = GEMINI_API_KEY.length > 0;
const ai = geminiEnabled ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const LEAD_SCHEMA = {
  type: Type.OBJECT,
  required: ["leads"],
  properties: {
    leads: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["name", "specialty", "location", "contact", "email", "category", "source"],
        properties: {
          name: { type: Type.STRING },
          specialty: { type: Type.STRING },
          location: { type: Type.STRING },
          contact: { type: Type.STRING },
          email: { type: Type.STRING },
          category: { type: Type.STRING },
          source: { type: Type.STRING },
        }
      }
    }
  }
};

async function discoverWithGemini(categories: string[], location: string, customSource?: string): Promise<any> {
  if (!ai) throw new Error("Gemini not configured");

  const prompt = `Actúa como un experto en prospección de clientes en México.
  USA GOOGLE SEARCH para buscar y generar una lista de 20 prospectos REALES de alto perfil en ${location}.
  Tipos de perfil solicitado: ${categories.join(', ')}.
  ${customSource ? `PRIORIZA buscar en estas fuentes: ${customSource}.` : "Busca en Google, LinkedIn, directorios profesionales y sitios especializados regionales (Sección Amarilla, Doctoralia, etc.)."}
  Para cada prospecto necesito: Nombre completo, Especialidad o Cargo/Empresa, Ubicación aproximada (Ciudad/Colonia/Edificio), Teléfono REAL (incluyendo lada de la ciudad), Correo Electrónico público (si está disponible), y la URL o Fuente de donde obtuviste la información.

  IMPORTANTE: Usa la herramienta de búsqueda para encontrar datos REALES y VERIFICABLES. No inventes teléfonos ni datos.
  Asegúrate de que sean profesionales que operen actualmente en ${location}.

  Responde ÚNICAMENTE con JSON válido (sin markdown ni bloques de código):
  {"leads": [{"name": "", "specialty": "", "location": "", "contact": "", "email": "", "category": "", "source": ""}]}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No valid JSON in Gemini response");
  return JSON.parse(jsonMatch[0]);
}

// Try to parse CSV/TSV directly without AI
function tryParseCSV(text: string): any | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Detect separator: semicolon, comma, or tab
  // Skip BOM and "sep=X" directives
  let startIdx = 0;
  let separator = ',';
  const firstLine = lines[0].replace(/^\uFEFF/, '');
  if (firstLine.toLowerCase().startsWith('sep=')) {
    separator = firstLine.charAt(4);
    startIdx = 1;
  } else if (firstLine.includes('\t')) {
    separator = '\t';
  } else if (firstLine.includes(';')) {
    separator = ';';
  }

  const headerLine = lines[startIdx];
  const headers = headerLine.split(separator).map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());

  // Need at least a "name" or "nombre" column
  const nameIdx = headers.findIndex(h => ['name', 'nombre', 'nombre completo', 'full name'].includes(h));
  if (nameIdx === -1) return null;

  const findCol = (...names: string[]) => headers.findIndex(h => names.some(n => h.includes(n)));
  const specIdx = findCol('especialidad', 'specialty', 'cargo', 'título', 'title', 'organización', 'empresa', 'company');
  const locIdx = findCol('ubicación', 'location', 'ciudad', 'city', 'zona', 'dirección', 'address');
  const phoneIdx = findCol('teléfono', 'telefono', 'phone', 'contacto', 'tel', 'celular', 'móvil', 'movil');
  const emailIdx = findCol('email', 'correo', 'e-mail', 'mail');
  const catIdx = findCol('categoría', 'categoria', 'category', 'tipo', 'type');
  const sourceIdx = findCol('fuente', 'source', 'origen', 'url', 'sitio');

  const leads: any[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split(separator).map(c => c.replace(/^"|"$/g, '').trim());
    const name = cols[nameIdx];
    if (!name) continue;
    leads.push({
      name,
      specialty: specIdx >= 0 ? cols[specIdx] || '' : '',
      location: locIdx >= 0 ? cols[locIdx] || '' : '',
      contact: phoneIdx >= 0 ? cols[phoneIdx] || '' : '',
      email: emailIdx >= 0 ? cols[emailIdx] || '' : '',
      category: catIdx >= 0 ? cols[catIdx] || 'Otros' : 'Otros',
      source: sourceIdx >= 0 ? cols[sourceIdx] || 'CSV Import' : 'CSV Import',
    });
  }

  return leads.length > 0 ? { leads } : null;
}

async function extractWithGemini(textContent: string): Promise<any> {
  if (!ai) throw new Error("Gemini not configured");

  const prompt = `Extrae información de prospectos/contactos del siguiente texto. Puede ser contenido de un sitio web, un CSV, una lista, un directorio, correos, o cualquier formato.

  Texto: """${textContent}"""

  Para CADA persona o profesional que encuentres, extrae: nombre completo, especialidad/cargo/empresa, ubicación/ciudad, teléfono, correo electrónico, y fuente.
  Clasifica cada lead en una de estas categorías: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.
  Si el texto es un CSV o tabla, interpreta las columnas correctamente.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: LEAD_SCHEMA,
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");
  return JSON.parse(text);
}

// SQLite Setup using better-sqlite3
const db = new Database("prospectos.db");
db.exec(`CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  specialty TEXT,
  location TEXT,
  contact TEXT,
  email TEXT,
  category TEXT,
  source TEXT,
  contactQuality TEXT DEFAULT 'pending',
  notes TEXT DEFAULT '',
  url TEXT DEFAULT '',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migration: add contactQuality column if missing
try { db.exec(`ALTER TABLE prospects ADD COLUMN contactQuality TEXT DEFAULT 'pending'`); } catch {};
// Migration: add userId column
try { db.exec(`ALTER TABLE prospects ADD COLUMN userId TEXT DEFAULT 'admin'`); } catch {};
// Migration: add notes and url columns
try { db.exec(`ALTER TABLE prospects ADD COLUMN notes TEXT DEFAULT ''`); } catch {};
try { db.exec(`ALTER TABLE prospects ADD COLUMN url TEXT DEFAULT ''`); } catch {};

// --- Users table ---
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  displayName TEXT,
  role TEXT DEFAULT 'user',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migration: add role column if missing
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`); } catch {};
// Ensure admin has admin role
try { db.prepare("UPDATE users SET role = 'admin' WHERE id = 'admin'").run(); } catch {};

// --- Organizations table ---
db.exec(`CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  location TEXT DEFAULT '',
  website TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  userId TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migration: add organizationId and orgRole to prospects
try { db.exec(`ALTER TABLE prospects ADD COLUMN organizationId TEXT DEFAULT NULL`); } catch {};
try { db.exec(`ALTER TABLE prospects ADD COLUMN orgRole TEXT DEFAULT ''`); } catch {};

// --- Org hierarchy table ---
db.exec(`CREATE TABLE IF NOT EXISTS org_hierarchy (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  superiorId TEXT NOT NULL,
  subordinateId TEXT NOT NULL,
  relationshipType TEXT DEFAULT 'reports_to',
  confidence TEXT DEFAULT 'media',
  source TEXT DEFAULT '',
  userId TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- Relationships table (cross-org) ---
db.exec(`CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  prospectId1 TEXT NOT NULL,
  prospectId2 TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  source TEXT DEFAULT '',
  confidence TEXT DEFAULT 'media',
  userId TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- Campaigns tables ---
db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  templateBody TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'email',
  status TEXT DEFAULT 'draft',
  totalRecipients INTEGER DEFAULT 0,
  sentCount INTEGER DEFAULT 0,
  openCount INTEGER DEFAULT 0,
  clickCount INTEGER DEFAULT 0,
  replyCount INTEGER DEFAULT 0,
  unsubscribeCount INTEGER DEFAULT 0,
  userId TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  sentAt DATETIME
)`);

db.exec(`CREATE TABLE IF NOT EXISTS campaign_prospects (
  id TEXT PRIMARY KEY,
  campaignId TEXT NOT NULL,
  prospectId TEXT NOT NULL,
  personalizedSubject TEXT DEFAULT '',
  personalizedBody TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  brevoMessageId TEXT DEFAULT '',
  sentAt DATETIME,
  openedAt DATETIME,
  clickedAt DATETIME,
  userId TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  unsubscribedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- Continuous jobs table ---
db.exec(`CREATE TABLE IF NOT EXISTS continuous_jobs (
  userId TEXT PRIMARY KEY,
  active INTEGER DEFAULT 0,
  categories TEXT DEFAULT '[]',
  location TEXT DEFAULT '',
  sources TEXT DEFAULT '[]',
  rounds INTEGER DEFAULT 0,
  lastActivity DATETIME,
  startedAt DATETIME
)`);

// Seed default admin user if no users exist
const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
if (userCount === 0) {
  const defaultPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10);
  db.prepare("INSERT INTO users (id, username, password, displayName, role) VALUES (?, ?, ?, ?, ?)").run(
    "admin", process.env.ADMIN_USER || "admin", defaultPassword, "Administrador", "admin"
  );
  console.log(`[Auth] Usuario admin creado (user: ${process.env.ADMIN_USER || "admin"}, password: ${process.env.ADMIN_PASSWORD || "admin123"})`);
}

const JWT_SECRET = process.env.JWT_SECRET || "prospectos_secret_key_change_me";

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000");

  app.use(express.json());
  app.use(cors());

  // --- Auth endpoints (no middleware) ---
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Usuario y contraseña requeridos" });

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, role: user.role || 'user' }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role || 'user' } });
  });

  app.get("/api/auth/me", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
    try {
      const payload = jwt.verify(authHeader.split(" ")[1], JWT_SECRET) as any;
      res.json({ user: { id: payload.id, username: payload.username, displayName: payload.displayName, role: payload.role || 'user' } });
    } catch {
      res.status(401).json({ error: "Token inválido" });
    }
  });

  // --- Brevo webhook (no auth, must be before middleware) ---
  app.post("/api/webhooks/brevo", (req, res) => {
    try {
      const { event, email } = req.body;
      const messageId = req.body['message-id'] || req.body['messageId'] || '';
      if (!messageId && !email) return res.status(200).send('OK');

      // Find campaign_prospect by brevoMessageId
      let cp: any = null;
      if (messageId) {
        cp = db.prepare("SELECT * FROM campaign_prospects WHERE brevoMessageId = ?").get(messageId);
      }

      if (cp) {
        const statusMap: Record<string, string> = {
          delivered: 'delivered', opened: 'opened', click: 'clicked',
          unsubscribe: 'unsubscribed', hard_bounce: 'bounced', soft_bounce: 'bounced',
          spam: 'unsubscribed',
        };
        const newStatus = statusMap[event] || cp.status;
        const updates: string[] = [`status = '${newStatus}'`];
        if (event === 'opened') updates.push("openedAt = datetime('now')");
        if (event === 'click') updates.push("clickedAt = datetime('now')");
        db.prepare(`UPDATE campaign_prospects SET ${updates.join(', ')} WHERE id = ?`).run(cp.id);

        // Update campaign counters
        const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(cp.campaignId) as any;
        if (campaign) {
          const counterMap: Record<string, string> = {
            opened: 'openCount', click: 'clickCount', unsubscribe: 'unsubscribeCount',
          };
          const col = counterMap[event];
          if (col) db.prepare(`UPDATE campaigns SET ${col} = ${col} + 1 WHERE id = ?`).run(cp.campaignId);
        }

        // Track unsubscribe globally
        if (event === 'unsubscribe' && email) {
          try {
            db.prepare("INSERT OR IGNORE INTO email_unsubscribes (email, userId) VALUES (?, ?)").run(email, cp.userId);
          } catch {}
        }
      }

      res.status(200).send('OK');
    } catch (err: any) {
      console.error("[Brevo webhook] Error:", err.message);
      res.status(200).send('OK');
    }
  });

  // --- Auth middleware for all /api routes (except auth, webhooks) ---
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path.startsWith("/webhooks/")) return next();
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No autorizado" });
    try {
      const payload = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
      (req as any).user = payload;
      next();
    } catch {
      res.status(401).json({ error: "Token inválido o expirado" });
    }
  });

  // --- Admin middleware helper ---
  function requireAdmin(req: any, res: any, next: any) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: "Solo administradores" });
    next();
  }

  // --- User management (admin only) ---
  app.get("/api/users", requireAdmin, (req, res) => {
    try {
      const rows = db.prepare("SELECT id, username, displayName, role, createdAt FROM users ORDER BY createdAt").all();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/users", requireAdmin, (req, res) => {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Usuario y contraseña requeridos" });
    try {
      const id = Math.random().toString(36).substr(2, 9);
      const hashed = bcrypt.hashSync(password, 10);
      db.prepare("INSERT INTO users (id, username, password, displayName, role) VALUES (?, ?, ?, ?, ?)").run(
        id, username, hashed, displayName || username, role || 'user'
      );
      res.json({ id, username, displayName: displayName || username, role: role || 'user' });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: "El usuario ya existe" });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/users/:id", requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, displayName, role } = req.body;
    try {
      const updates: string[] = [];
      const values: any[] = [];
      if (username !== undefined) { updates.push("username = ?"); values.push(username); }
      if (displayName !== undefined) { updates.push("displayName = ?"); values.push(displayName); }
      if (role !== undefined) { updates.push("role = ?"); values.push(role); }
      if (password) { updates.push("password = ?"); values.push(bcrypt.hashSync(password, 10)); }
      if (updates.length === 0) return res.json({ message: "Nothing to update" });
      values.push(id);
      db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      res.json({ message: "Usuario actualizado" });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: "El nombre de usuario ya existe" });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/users/:id", requireAdmin, (req, res) => {
    const { id } = req.params;
    if (id === 'admin') return res.status(400).json({ error: "No se puede eliminar el admin" });
    try {
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
      res.json({ message: "Usuario eliminado" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Extract URL from source or email domain (exclude generic email services)
  function extractUrlFromSource(source?: string, email?: string): string {
    const genericDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'live.com', 'msn.com', 'icloud.com', 'aol.com', 'protonmail.com', 'mail.com', 'zoho.com', 'yandex.com', 'gmx.com', 'tutanota.com'];
    // Try to extract from source first
    if (source) {
      const urlMatch = source.match(/https?:\/\/[^\s,]+/);
      if (urlMatch) return urlMatch[0];
      const domainMatch = source.match(/(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,}/);
      if (domainMatch && !genericDomains.includes(domainMatch[0].toLowerCase())) {
        return `https://${domainMatch[0]}`;
      }
    }
    // Fallback: extract domain from email
    if (email) {
      const domain = email.split('@')[1]?.toLowerCase();
      if (domain && !genericDomains.includes(domain)) {
        return `https://${domain}`;
      }
    }
    return '';
  }

  // API Routes
  app.get("/api/prospects", (req, res) => {
    const userId = (req as any).user.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const search = (req.query.search as string || '').trim();
    const category = (req.query.category as string || '').trim();
    const sort = (req.query.sort as string || 'date');
    const all = req.query.all === 'true'; // for export

    try {
      let where = "WHERE userId = ?";
      const params: any[] = [userId];

      if (search) {
        where += " AND (name LIKE ? OR specialty LIKE ? OR location LIKE ?)";
        const like = `%${search}%`;
        params.push(like, like, like);
      }
      if (category && category !== 'All') {
        where += " AND category = ?";
        params.push(category);
      }

      const orderBy = sort === 'name' ? 'name ASC' : sort === 'quality' ? "CASE contactQuality WHEN 'qualified' THEN 0 WHEN 'direct' THEN 1 WHEN 'generic' THEN 2 WHEN 'pending' THEN 3 WHEN 'disqualified' THEN 4 ELSE 3 END" : 'createdAt DESC';

      const total = (db.prepare(`SELECT COUNT(*) as count FROM prospects ${where}`).get(...params) as any).count;

      let rows;
      if (all) {
        rows = db.prepare(`SELECT * FROM prospects ${where} ORDER BY ${orderBy}`).all(...params);
      } else {
        const offset = (page - 1) * limit;
        rows = db.prepare(`SELECT * FROM prospects ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
      }

      res.json({ data: rows, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/prospects", (req, res) => {
    const userId = (req as any).user.id;
    const prospects = Array.isArray(req.body) ? req.body : [req.body];

    // Deduplicate against existing prospects
    const existing = db.prepare("SELECT name FROM prospects WHERE userId = ?").all(userId) as any[];
    const existingNames = new Set(existing.map((r: any) => r.name.toLowerCase().trim()));
    const uniqueLeads = prospects.filter((p: any) => {
      const key = (p.name || '').toLowerCase().trim();
      if (!key || existingNames.has(key)) return false;
      existingNames.add(key); // also deduplicate within the batch
      return true;
    });

    if (uniqueLeads.length === 0) {
      return res.json({ message: "No hay prospectos nuevos (todos duplicados)", duplicates: prospects.length });
    }

    const insert = db.prepare(`INSERT INTO prospects (id, name, specialty, location, contact, email, category, source, notes, url, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const transaction = db.transaction((leads: any[]) => {
      for (const p of leads) {
        const id = Math.random().toString(36).substr(2, 9);
        const url = p.url || extractUrlFromSource(p.source, p.email);
        insert.run(id, p.name, p.specialty, p.location, p.contact, p.email, p.category, p.source, p.notes || '', url, userId);
      }
    });

    try {
      transaction(uniqueLeads);
      const skipped = prospects.length - uniqueLeads.length;
      res.json({ message: `${uniqueLeads.length} guardado(s)${skipped > 0 ? `, ${skipped} duplicado(s) omitido(s)` : ''}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Scraping + AI Discovery ---

  // Build scraping URLs dynamically from category + location + source
  function buildScrapeUrls(categories: string[], location: string, sources: string[]): string[] {
    const city = location.split(",")[0].trim().toLowerCase();
    const cityEncoded = encodeURIComponent(location);
    const urls: string[] = [];

    const categoryKeywords: Record<string, string[]> = {
      Doctores: ['doctor', 'médico', 'dentista'],
      Abogados: ['abogados'],
      Notarios: ['notarios'],
      Arquitectos: ['arquitectos'],
      Ingenieros: ['ingenieros-civiles', 'ingenieros'],
      Inversionistas: ['bienes-raices', 'inversionistas'],
      Empresarios: ['empresas', 'empresarios'],
      Candidatos: ['profesionales'],
      Especialistas: ['especialistas'],
    };

    for (const source of sources) {
      const srcLower = source.toLowerCase();
      for (const cat of categories) {
        const keywords = categoryKeywords[cat] || [cat.toLowerCase()];
        for (const kw of keywords) {
          if (srcLower.includes('doctoralia')) {
            urls.push(`https://www.doctoralia.com.mx/buscar?q=${encodeURIComponent(kw)}&loc=${cityEncoded}`);
          } else if (srcLower.includes('sección amarilla') || srcLower.includes('seccion amarilla')) {
            urls.push(`https://www.seccionamarilla.com.mx/${encodeURIComponent(city)}/${encodeURIComponent(kw)}`);
          } else if (srcLower.includes('google maps')) {
            urls.push(`https://www.google.com/maps/search/${encodeURIComponent(kw + ' ' + location)}`);
          } else if (srcLower.includes('yahoo')) {
            urls.push(`https://search.yahoo.com/search?p=${encodeURIComponent(kw + ' ' + location)}`);
          } else if (srcLower.includes('linkedin')) {
            urls.push(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw + ' ' + location)}`);
          } else if (srcLower.startsWith('http')) {
            urls.push(source);
          } else {
            // Generic: try Google search for the source + category + location
            urls.push(`https://www.google.com/search?q=${encodeURIComponent(source + ' ' + kw + ' ' + location)}`);
          }
        }
      }
    }

    // Deduplicate
    return [...new Set(urls)];
  }

  async function scrapeUrl(url: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "es-MX,es;q=0.9",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return "";
      const html = await res.text();
      const $ = cheerio.load(html);
      // Remove scripts, styles, nav, footer
      $("script, style, nav, footer, header, svg, img, link, meta").remove();
      // Extract meaningful text
      const text = $("body").text().replace(/\s+/g, " ").trim();
      // Limit to ~8000 chars to avoid token limits
      return text.slice(0, 8000);
    } catch {
      return "";
    }
  }

  async function callOpenRouterServer(prompt: string): Promise<any> {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    const model = process.env.OPENROUTER_MODEL || "openrouter/free";

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Eres un experto en prospección de clientes en México. SIEMPRE responde ÚNICAMENTE con JSON válido, sin markdown, sin bloques de código, sin texto adicional."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("No response from OpenRouter");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No valid JSON in response");

    return JSON.parse(jsonMatch[0]);
  }

  // Fallback: scraping + OpenRouter
  async function discoverWithScraping(categories: string[], loc: string, customSource?: string) {
    let scrapedTexts: string[] = [];

    const sourcesFromClient = customSource
      ? customSource.split(",").map((s: string) => s.trim()).filter(Boolean)
      : ["Doctoralia", "Sección Amarilla"];

    const urls = buildScrapeUrls(categories, loc, sourcesFromClient);

    const batchSize = 6;
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(u => scrapeUrl(u)));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled" && r.value) {
          scrapedTexts.push(`[Fuente: ${batch[j]}]\n${r.value}`);
        }
      }
    }

    const combinedText = scrapedTexts.join("\n\n---\n\n").slice(0, 15000);

    const prompt = combinedText
      ? `A partir del siguiente contenido scrapeado de directorios profesionales, extrae una lista de hasta 20 prospectos reales en ${loc}.
Tipos de perfil buscado: ${categories.join(", ")}.

CONTENIDO SCRAPEADO:
"""${combinedText}"""

Para cada prospecto necesito: Nombre completo, Especialidad o Cargo/Empresa, Ubicación, Teléfono (con lada), Correo electrónico (si aparece), y la Fuente/URL de donde se obtuvo.

Responde ÚNICAMENTE con JSON válido:
{"leads": [{"name": "", "specialty": "", "location": "", "contact": "", "email": "", "category": "", "source": ""}]}`
      : `Genera una lista de 20 prospectos de alto perfil en ${loc}.
Tipos de perfil: ${categories.join(", ")}.
Para cada uno: Nombre completo, Especialidad, Ubicación, Teléfono, Email, Categoría (Salud|Legal|Inversión|Arquitectura|Profesionales|Otros), Fuente.

Responde ÚNICAMENTE con JSON válido:
{"leads": [{"name": "", "specialty": "", "location": "", "contact": "", "email": "", "category": "", "source": ""}]}`;

    return callOpenRouterServer(prompt);
  }

  app.post("/api/discover", async (req, res) => {
    const { categories, location, customSource } = req.body;
    const loc = location || "Ciudad de México";
    try {
      // Try Gemini first (has Google Search for best results)
      if (geminiEnabled) {
        try {
          console.log(`[Discover] Intentando Gemini (Google Search) para ${loc}...`);
          const result = await discoverWithGemini(categories || [], loc, customSource);
          console.log(`[Discover] Gemini OK - ${result.leads?.length || 0} leads`);
          return res.json(result);
        } catch (geminiErr: any) {
          console.warn(`[Discover] Gemini falló: ${geminiErr.message}. Usando fallback (scraping + OpenRouter)...`);
        }
      }

      // Fallback: scraping + OpenRouter
      console.log(`[Discover] Usando scraping + OpenRouter para ${loc}...`);
      const result = await discoverWithScraping(categories || [], loc, customSource);
      console.log(`[Discover] Scraping+OpenRouter OK - ${result.leads?.length || 0} leads`);
      res.json(result);
    } catch (err: any) {
      console.error("Discovery error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/extract", async (req, res) => {
    const { text } = req.body;
    try {
      // Step 1: Try direct CSV/TSV parsing (no AI needed)
      const csvResult = tryParseCSV(text);
      if (csvResult) {
        console.log(`[Extract] CSV parseado directamente - ${csvResult.leads.length} leads`);
        return res.json(csvResult);
      }

      // Step 2: Try Gemini
      if (geminiEnabled) {
        try {
          console.log(`[Extract] Intentando Gemini...`);
          const result = await extractWithGemini(text);
          console.log(`[Extract] Gemini OK - ${result.leads?.length || 0} leads`);
          return res.json(result);
        } catch (geminiErr: any) {
          console.warn(`[Extract] Gemini falló: ${geminiErr.message}. Usando fallback (OpenRouter)...`);
        }
      }

      // Step 3: Fallback OpenRouter
      const prompt = `Extrae información de prospectos/contactos del siguiente texto. Puede ser contenido de un sitio web, CSV, lista, directorio, o cualquier formato.

Texto: """${text}"""

Para CADA persona o profesional que encuentres, extrae: nombre, especialidad/cargo, ubicación, teléfono, email, y fuente.
Clasifica cada lead en: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.

Responde ÚNICAMENTE con JSON válido:
{"leads": [{"name": "", "specialty": "", "location": "", "contact": "", "email": "", "category": "", "source": ""}]}`;

      const result = await callOpenRouterServer(prompt);
      res.json(result);
    } catch (err: any) {
      console.error("Extract error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Update a prospect
  app.patch("/api/prospects/:id", (req, res) => {
    const { id } = req.params;
    const userId = (req as any).user.id;
    const allowedFields = ['name', 'specialty', 'location', 'contact', 'email', 'category', 'source', 'contactQuality', 'notes', 'url', 'organizationId', 'orgRole'];
    try {
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      if (updates.length === 0) return res.json({ message: "Nothing to update" });
      values.push(id, userId);
      db.prepare(`UPDATE prospects SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...values);
      res.json({ message: "Actualizado" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete prospects (accepts array of IDs, scoped to user)
  app.delete("/api/prospects", (req, res) => {
    const userId = (req as any).user.id;
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    try {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM prospects WHERE id IN (${placeholders}) AND userId = ?`).run(...ids, userId);
      res.json({ message: `${ids.length} prospecto(s) eliminado(s)` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Settings (admin only) ---
  app.get("/api/settings", requireAdmin, (req, res) => {
    try {
      // Read current .env and return config (mask sensitive values)
      const envPath = path.join(process.cwd(), ".env");
      const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
      const envVars: Record<string, string> = {};
      for (const line of envContent.split("\n")) {
        const match = line.match(/^([^#=]+)=["']?(.*)["']?\s*$/);
        if (match) envVars[match[1].trim()] = match[2].replace(/^["']|["']$/g, '');
      }

      res.json({
        geminiApiKey: envVars.GEMINI_API_KEY || '',
        openrouterApiKey: envVars.OPENROUTER_API_KEY || '',
        openrouterModel: envVars.OPENROUTER_MODEL || 'openrouter/free',
        brevoApiKey: envVars.BREVO_API_KEY || '',
        brevoSenderEmail: envVars.BREVO_SENDER_EMAIL || '',
        brevoSenderName: envVars.BREVO_SENDER_NAME || '',
        aiProvider: envVars.AI_PROVIDER || 'hybrid',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/settings", requireAdmin, (req, res) => {
    try {
      const envPath = path.join(process.cwd(), ".env");
      const { geminiApiKey, openrouterApiKey, openrouterModel, brevoApiKey, brevoSenderEmail, brevoSenderName, aiProvider } = req.body;

      // Read existing .env to preserve values not being updated
      const existing: Record<string, string> = {};
      if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
          const match = line.match(/^([^#=]+)=["']?(.*)["']?\s*$/);
          if (match) existing[match[1].trim()] = match[2].replace(/^["']|["']$/g, '');
        }
      }

      // Update only provided fields
      if (geminiApiKey !== undefined) existing.GEMINI_API_KEY = geminiApiKey;
      if (openrouterApiKey !== undefined) existing.OPENROUTER_API_KEY = openrouterApiKey;
      if (openrouterModel !== undefined) existing.OPENROUTER_MODEL = openrouterModel;
      if (brevoApiKey !== undefined) existing.BREVO_API_KEY = brevoApiKey;
      if (brevoSenderEmail !== undefined) existing.BREVO_SENDER_EMAIL = brevoSenderEmail;
      if (brevoSenderName !== undefined) existing.BREVO_SENDER_NAME = brevoSenderName;
      if (aiProvider !== undefined) existing.AI_PROVIDER = aiProvider;

      // Preserve non-config keys
      const preserveKeys = ['PORT', 'ADMIN_USER', 'ADMIN_PASSWORD', 'JWT_SECRET'];
      for (const k of preserveKeys) {
        if (!existing[k] && process.env[k]) existing[k] = process.env[k]!;
      }

      // Write .env
      const envLines = Object.entries(existing).map(([k, v]) => `${k}="${v}"`);
      fs.writeFileSync(envPath, envLines.join("\n") + "\n");

      // Reload env vars in process
      dotenv.config({ override: true });

      // Update runtime variables
      process.env.GEMINI_API_KEY = existing.GEMINI_API_KEY || '';
      process.env.OPENROUTER_API_KEY = existing.OPENROUTER_API_KEY || '';
      process.env.OPENROUTER_MODEL = existing.OPENROUTER_MODEL || 'openrouter/free';
      process.env.BREVO_API_KEY = existing.BREVO_API_KEY || '';
      process.env.BREVO_SENDER_EMAIL = existing.BREVO_SENDER_EMAIL || '';
      process.env.BREVO_SENDER_NAME = existing.BREVO_SENDER_NAME || '';

      res.json({ message: "Configuración guardada. Algunos cambios (como la API key de Gemini) requieren reiniciar el servidor." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Organizations CRUD ---
  app.get("/api/organizations", (req, res) => {
    const userId = (req as any).user.id;
    const search = (req.query.search as string || '').trim();
    try {
      let where = "WHERE o.userId = ?";
      const params: any[] = [userId];
      if (search) {
        where += " AND (o.name LIKE ? OR o.type LIKE ? OR o.location LIKE ?)";
        const like = `%${search}%`;
        params.push(like, like, like);
      }
      const rows = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM prospects p WHERE p.organizationId = o.id AND p.userId = ?) as memberCount FROM organizations o ${where} ORDER BY o.name ASC`).all(userId, ...params);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/organizations/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const org = db.prepare("SELECT * FROM organizations WHERE id = ? AND userId = ?").get(id, userId);
      if (!org) return res.status(404).json({ error: "Organización no encontrada" });
      const members = db.prepare("SELECT * FROM prospects WHERE organizationId = ? AND userId = ? ORDER BY orgRole, name").all(id, userId);
      res.json({ ...org as any, members });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/organizations", (req, res) => {
    const userId = (req as any).user.id;
    const { name, type, industry, location, website, phone, email, notes } = req.body;
    if (!name) return res.status(400).json({ error: "Nombre requerido" });
    try {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO organizations (id, name, type, industry, location, website, phone, email, notes, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, name, type || '', industry || '', location || '', website || '', phone || '', email || '', notes || '', userId
      );
      res.json({ id, name, type, industry, location, website, phone, email, notes });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/organizations/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const allowedFields = ['name', 'type', 'industry', 'location', 'website', 'phone', 'email', 'notes'];
    try {
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      if (updates.length === 0) return res.json({ message: "Nothing to update" });
      values.push(id, userId);
      db.prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...values);
      res.json({ message: "Organización actualizada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/organizations/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      // Nullify prospects' organizationId
      db.prepare("UPDATE prospects SET organizationId = NULL, orgRole = '' WHERE organizationId = ? AND userId = ?").run(id, userId);
      db.prepare("DELETE FROM organizations WHERE id = ? AND userId = ?").run(id, userId);
      res.json({ message: "Organización eliminada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI: Detect organizations from prospect data
  app.post("/api/organizations/detect", async (req, res) => {
    const userId = (req as any).user.id;
    try {
      // Get unassigned prospects
      const unassigned = db.prepare("SELECT id, name, specialty, source, url, email FROM prospects WHERE userId = ? AND (organizationId IS NULL OR organizationId = '')").all(userId) as any[];
      if (unassigned.length === 0) return res.json({ message: "Todos los prospectos ya tienen organización", detected: 0 });

      // Get existing orgs for matching
      const existingOrgs = db.prepare("SELECT id, name FROM organizations WHERE userId = ?").all(userId) as any[];
      const orgNameMap = new Map<string, string>(); // lowercase name -> id
      for (const o of existingOrgs) orgNameMap.set(o.name.toLowerCase().trim(), o.id);

      // Batch prospects for AI (max 30 at a time)
      const batch = unassigned.slice(0, 30);
      const prospectSummary = batch.map((p: any) => `- ${p.name}: ${p.specialty || ''}, fuente: ${p.source || ''}, url: ${p.url || ''}, email: ${p.email || ''}`).join('\n');

      const prompt = `Analiza los siguientes prospectos y determina si pertenecen a alguna organización (empresa, hospital, despacho, institución, etc.).

Prospectos:
${prospectSummary}

Para cada prospecto donde identifiques una organización, indica:
- El nombre exacto de la organización
- El tipo (hospital, despacho, empresa, asociacion, clinica, gobierno, universidad, otro)
- El rol del prospecto en la organización (director, socio, empleado, fundador, colaborador, consultor, otro)

Responde ÚNICAMENTE con JSON válido:
{"results": [{"prospect_name": "", "organization_name": "", "organization_type": "", "role": "", "confidence": "alta|media|baja"}]}
Si no puedes determinar la organización de un prospecto, no lo incluyas.`;

      let aiResult: any;
      if (geminiEnabled) {
        try {
          const response = await ai!.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] },
          });
          const text = response.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { results: [] };
        } catch {
          aiResult = await callOpenRouterServer(prompt);
        }
      } else {
        aiResult = await callOpenRouterServer(prompt);
      }

      const results = aiResult.results || [];
      let assigned = 0;
      let orgsCreated = 0;

      for (const r of results) {
        if (!r.organization_name || !r.prospect_name) continue;

        // Find the prospect
        const prospect = batch.find((p: any) => p.name.toLowerCase().includes(r.prospect_name.toLowerCase()) || r.prospect_name.toLowerCase().includes(p.name.toLowerCase()));
        if (!prospect) continue;

        // Find or create the organization
        const orgKey = r.organization_name.toLowerCase().trim();
        let orgId = orgNameMap.get(orgKey);
        if (!orgId) {
          orgId = Math.random().toString(36).substr(2, 9);
          db.prepare("INSERT INTO organizations (id, name, type, userId) VALUES (?, ?, ?, ?)").run(orgId, r.organization_name, r.organization_type || '', userId);
          orgNameMap.set(orgKey, orgId);
          orgsCreated++;
        }

        // Assign prospect
        db.prepare("UPDATE prospects SET organizationId = ?, orgRole = ? WHERE id = ? AND userId = ?").run(orgId, r.role || '', prospect.id, userId);
        assigned++;
      }

      res.json({ message: `${assigned} prospecto(s) asignado(s), ${orgsCreated} organización(es) creada(s)`, assigned, orgsCreated });
    } catch (err: any) {
      console.error("Org detection error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Org Hierarchy ---
  app.get("/api/organizations/:id/hierarchy", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const rows = db.prepare(`
        SELECT h.*,
          s.name as superiorName, s.specialty as superiorSpecialty, s.orgRole as superiorRole,
          sub.name as subordinateName, sub.specialty as subordinateSpecialty, sub.orgRole as subordinateRole
        FROM org_hierarchy h
        JOIN prospects s ON h.superiorId = s.id
        JOIN prospects sub ON h.subordinateId = sub.id
        WHERE h.organizationId = ? AND h.userId = ?
        ORDER BY h.createdAt
      `).all(id, userId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/organizations/:id/hierarchy", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { superiorId, subordinateId, relationshipType } = req.body;
    if (!superiorId || !subordinateId) return res.status(400).json({ error: "superiorId y subordinateId requeridos" });
    try {
      const hId = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO org_hierarchy (id, organizationId, superiorId, subordinateId, relationshipType, userId) VALUES (?, ?, ?, ?, ?, ?)").run(
        hId, id, superiorId, subordinateId, relationshipType || 'reports_to', userId
      );
      res.json({ id: hId, message: "Relación jerárquica creada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/org-hierarchy/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM org_hierarchy WHERE id = ? AND userId = ?").run(id, userId);
      res.json({ message: "Relación eliminada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI: Discover hierarchy within an org
  app.post("/api/organizations/:id/discover-hierarchy", async (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const org = db.prepare("SELECT * FROM organizations WHERE id = ? AND userId = ?").get(id, userId) as any;
      if (!org) return res.status(404).json({ error: "Organización no encontrada" });

      const members = db.prepare("SELECT id, name, specialty, orgRole, contact, email FROM prospects WHERE organizationId = ? AND userId = ?").all(id, userId) as any[];
      if (members.length < 2) return res.json({ message: "Se necesitan al menos 2 miembros para descubrir jerarquía", discovered: 0 });

      // Scrape org website if available
      let websiteContent = '';
      if (org.website) {
        try { websiteContent = await scrapeUrl(org.website); } catch {}
      }

      const memberSummary = members.map((m: any) => `- ${m.name} (ID: ${m.id}): ${m.specialty || 'sin especialidad'}, rol actual: ${m.orgRole || 'desconocido'}`).join('\n');

      const prompt = `Analiza la siguiente organización y sus miembros para determinar la jerarquía interna.

Organización: ${org.name} (${org.type || 'tipo desconocido'})
${org.location ? `Ubicación: ${org.location}` : ''}

Miembros:
${memberSummary}

${websiteContent ? `Contenido del sitio web:\n"""${websiteContent.slice(0, 4000)}"""\n` : ''}

Determina quién reporta a quién o quién supervisa a quién. También sugiere roles si los actuales son desconocidos.

Responde ÚNICAMENTE con JSON válido:
{"hierarchy": [{"superior_id": "id", "subordinate_id": "id", "relationship": "reports_to", "confidence": "alta|media|baja"}], "role_updates": [{"id": "prospect_id", "role": "director|socio|jefe_area|colaborador|empleado|fundador|consultor"}]}`;

      let aiResult: any;
      if (geminiEnabled) {
        try {
          const response = await ai!.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] },
          });
          const text = response.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { hierarchy: [], role_updates: [] };
        } catch {
          aiResult = await callOpenRouterServer(prompt);
        }
      } else {
        aiResult = await callOpenRouterServer(prompt);
      }

      // Apply role updates
      const roleUpdates = aiResult.role_updates || [];
      for (const ru of roleUpdates) {
        if (ru.id && ru.role) {
          const member = members.find((m: any) => m.id === ru.id);
          if (member) {
            db.prepare("UPDATE prospects SET orgRole = ? WHERE id = ? AND userId = ?").run(ru.role, ru.id, userId);
          }
        }
      }

      // Insert hierarchy relationships (avoid duplicates)
      const existing = db.prepare("SELECT superiorId, subordinateId FROM org_hierarchy WHERE organizationId = ? AND userId = ?").all(id, userId) as any[];
      const existingPairs = new Set(existing.map((e: any) => `${e.superiorId}-${e.subordinateId}`));

      let created = 0;
      for (const h of (aiResult.hierarchy || [])) {
        if (!h.superior_id || !h.subordinate_id) continue;
        // Verify both IDs are actual members
        if (!members.find((m: any) => m.id === h.superior_id) || !members.find((m: any) => m.id === h.subordinate_id)) continue;
        const pairKey = `${h.superior_id}-${h.subordinate_id}`;
        if (existingPairs.has(pairKey)) continue;

        const hId = Math.random().toString(36).substr(2, 9);
        db.prepare("INSERT INTO org_hierarchy (id, organizationId, superiorId, subordinateId, relationshipType, confidence, source, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          hId, id, h.superior_id, h.subordinate_id, h.relationship || 'reports_to', h.confidence || 'media', 'AI', userId
        );
        existingPairs.add(pairKey);
        created++;
      }

      res.json({ message: `${created} relación(es) jerárquica(s) descubierta(s), ${roleUpdates.length} rol(es) actualizado(s)`, created, roleUpdates: roleUpdates.length });
    } catch (err: any) {
      console.error("Hierarchy discovery error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Cross-Org Relationships ---
  app.get("/api/prospects/:id/relationships", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const rows = db.prepare(`
        SELECT r.*,
          p1.name as name1, p1.specialty as specialty1,
          p2.name as name2, p2.specialty as specialty2
        FROM relationships r
        JOIN prospects p1 ON r.prospectId1 = p1.id
        JOIN prospects p2 ON r.prospectId2 = p2.id
        WHERE (r.prospectId1 = ? OR r.prospectId2 = ?) AND r.userId = ?
        ORDER BY r.createdAt DESC
      `).all(id, id, userId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/relationships", (req, res) => {
    const userId = (req as any).user.id;
    const { prospectId1, prospectId2, type, description } = req.body;
    if (!prospectId1 || !prospectId2 || !type) return res.status(400).json({ error: "prospectId1, prospectId2 y type requeridos" });
    try {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO relationships (id, prospectId1, prospectId2, type, description, source, userId) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id, prospectId1, prospectId2, type, description || '', 'manual', userId
      );
      res.json({ id, message: "Relación creada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/relationships/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM relationships WHERE id = ? AND userId = ?").run(id, userId);
      res.json({ message: "Relación eliminada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI: Discover relationships between selected prospects
  app.post("/api/relationships/discover", async (req, res) => {
    const userId = (req as any).user.id;
    const { prospectIds } = req.body;
    if (!prospectIds || prospectIds.length < 2) return res.status(400).json({ error: "Se necesitan al menos 2 prospectos" });

    try {
      const placeholders = prospectIds.map(() => '?').join(',');
      const prospects = db.prepare(`SELECT id, name, specialty, location, email, organizationId, orgRole FROM prospects WHERE id IN (${placeholders}) AND userId = ?`).all(...prospectIds, userId) as any[];

      // Get org names for context
      const orgIds = [...new Set(prospects.filter((p: any) => p.organizationId).map((p: any) => p.organizationId))];
      const orgs = orgIds.length > 0
        ? db.prepare(`SELECT id, name FROM organizations WHERE id IN (${orgIds.map(() => '?').join(',')}) AND userId = ?`).all(...orgIds, userId) as any[]
        : [];
      const orgMap = new Map(orgs.map((o: any) => [o.id, o.name]));

      const prospectSummary = prospects.map((p: any) => {
        const orgName = p.organizationId ? orgMap.get(p.organizationId) || 'desconocida' : 'independiente';
        return `- ${p.name} (ID: ${p.id}): ${p.specialty || 'sin especialidad'}, ${p.location || 'sin ubicación'}, org: ${orgName}`;
      }).join('\n');

      // Search DuckDuckGo for pairs of names
      const searchPairs: string[] = [];
      for (let i = 0; i < Math.min(prospects.length, 5); i++) {
        for (let j = i + 1; j < Math.min(prospects.length, 5); j++) {
          searchPairs.push(`"${prospects[i].name}" "${prospects[j].name}"`);
        }
      }

      let scrapedContent = '';
      for (const query of searchPairs.slice(0, 3)) {
        const links = await osintSearchDuckDuckGo(query);
        for (const link of links.slice(0, 2)) {
          const text = await scrapeUrl(link);
          if (text) scrapedContent += `\n---\n${text.slice(0, 2000)}`;
        }
      }

      const prompt = `Analiza si existe alguna relación entre estas personas:
${prospectSummary}

${scrapedContent ? `Contenido encontrado en búsqueda:\n"""${scrapedContent.slice(0, 6000)}"""\n` : ''}

Tipos de relación posibles: ex_colegas, familia, amigos, misma_asociacion, socios, compañeros_estudio, referido, mentor.
Responde ÚNICAMENTE con JSON válido:
{"relationships": [{"person1_id": "id", "person2_id": "id", "type": "tipo", "description": "contexto breve", "confidence": "alta|media|baja"}]}
Si no hay relación clara, devuelve array vacío.`;

      let aiResult: any;
      if (geminiEnabled) {
        try {
          const response = await ai!.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] },
          });
          const text = response.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { relationships: [] };
        } catch {
          aiResult = await callOpenRouterServer(prompt);
        }
      } else {
        aiResult = await callOpenRouterServer(prompt);
      }

      // Insert relationships (avoid duplicates)
      const existing = db.prepare("SELECT prospectId1, prospectId2 FROM relationships WHERE userId = ?").all(userId) as any[];
      const existingPairs = new Set(existing.map((e: any) => [e.prospectId1, e.prospectId2].sort().join('-')));

      let created = 0;
      for (const r of (aiResult.relationships || [])) {
        if (!r.person1_id || !r.person2_id) continue;
        if (!prospects.find((p: any) => p.id === r.person1_id) || !prospects.find((p: any) => p.id === r.person2_id)) continue;
        const pairKey = [r.person1_id, r.person2_id].sort().join('-');
        if (existingPairs.has(pairKey)) continue;

        const rId = Math.random().toString(36).substr(2, 9);
        db.prepare("INSERT INTO relationships (id, prospectId1, prospectId2, type, description, source, confidence, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          rId, r.person1_id, r.person2_id, r.type || 'otro', r.description || '', 'AI+OSINT', r.confidence || 'media', userId
        );
        existingPairs.add(pairKey);
        created++;
      }

      res.json({ message: `${created} relación(es) descubierta(s)`, created });
    } catch (err: any) {
      console.error("Relationship discovery error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Campaigns ---
  app.get("/api/campaigns", (req, res) => {
    const userId = (req as any).user.id;
    try {
      const rows = db.prepare("SELECT * FROM campaigns WHERE userId = ? ORDER BY createdAt DESC").all(userId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/campaigns/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND userId = ?").get(id, userId) as any;
      if (!campaign) return res.status(404).json({ error: "Campaña no encontrada" });
      const recipients = db.prepare(`
        SELECT cp.*, p.name, p.specialty, p.email as prospectEmail, p.contact, p.location, p.category
        FROM campaign_prospects cp
        JOIN prospects p ON cp.prospectId = p.id
        WHERE cp.campaignId = ? AND cp.userId = ?
        ORDER BY cp.status, p.name
      `).all(id, userId);
      res.json({ ...campaign, recipients });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/campaigns", (req, res) => {
    const userId = (req as any).user.id;
    const { name, subject, templateBody, type } = req.body;
    if (!name) return res.status(400).json({ error: "Nombre requerido" });
    try {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO campaigns (id, name, subject, templateBody, type, userId) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, name, subject || '', templateBody || '', type || 'email', userId
      );
      res.json({ id, name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/campaigns/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const allowedFields = ['name', 'subject', 'templateBody', 'status'];
    try {
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(req.body[field]);
        }
      }
      if (updates.length === 0) return res.json({ message: "Nothing to update" });
      values.push(id, userId);
      db.prepare(`UPDATE campaigns SET ${updates.join(", ")} WHERE id = ? AND userId = ?`).run(...values);
      res.json({ message: "Campaña actualizada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/campaigns/:id", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM campaign_prospects WHERE campaignId = ? AND userId = ?").run(id, userId);
      db.prepare("DELETE FROM campaigns WHERE id = ? AND userId = ?").run(id, userId);
      res.json({ message: "Campaña eliminada" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add prospects to campaign
  app.post("/api/campaigns/:id/recipients", (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { prospectIds } = req.body;
    if (!prospectIds || !Array.isArray(prospectIds)) return res.status(400).json({ error: "prospectIds array requerido" });
    try {
      // Get existing recipients to avoid duplicates
      const existing = db.prepare("SELECT prospectId FROM campaign_prospects WHERE campaignId = ? AND userId = ?").all(id, userId) as any[];
      const existingSet = new Set(existing.map((e: any) => e.prospectId));

      const insert = db.prepare("INSERT INTO campaign_prospects (id, campaignId, prospectId, userId) VALUES (?, ?, ?, ?)");
      let added = 0;
      for (const pid of prospectIds) {
        if (existingSet.has(pid)) continue;
        insert.run(Math.random().toString(36).substr(2, 9), id, pid, userId);
        added++;
      }

      // Update total
      const total = (db.prepare("SELECT COUNT(*) as c FROM campaign_prospects WHERE campaignId = ? AND userId = ?").get(id, userId) as any).c;
      db.prepare("UPDATE campaigns SET totalRecipients = ? WHERE id = ? AND userId = ?").run(total, id, userId);

      res.json({ message: `${added} destinatario(s) agregado(s)`, added, total });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove recipient
  app.delete("/api/campaign-prospects/:cpId", (req, res) => {
    const userId = (req as any).user.id;
    const { cpId } = req.params;
    try {
      const cp = db.prepare("SELECT campaignId FROM campaign_prospects WHERE id = ? AND userId = ?").get(cpId, userId) as any;
      db.prepare("DELETE FROM campaign_prospects WHERE id = ? AND userId = ?").run(cpId, userId);
      if (cp) {
        const total = (db.prepare("SELECT COUNT(*) as c FROM campaign_prospects WHERE campaignId = ? AND userId = ?").get(cp.campaignId, userId) as any).c;
        db.prepare("UPDATE campaigns SET totalRecipients = ? WHERE id = ? AND userId = ?").run(total, cp.campaignId, userId);
      }
      res.json({ message: "Destinatario eliminado" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update campaign_prospect status (for WhatsApp manual tracking)
  app.patch("/api/campaign-prospects/:cpId", (req, res) => {
    const userId = (req as any).user.id;
    const { cpId } = req.params;
    const { status } = req.body;
    try {
      db.prepare("UPDATE campaign_prospects SET status = ? WHERE id = ? AND userId = ?").run(status || 'sent', cpId, userId);
      res.json({ message: "Estado actualizado" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI: Personalize campaign messages
  app.post("/api/campaigns/:id/personalize", async (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    try {
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND userId = ?").get(id, userId) as any;
      if (!campaign) return res.status(404).json({ error: "Campaña no encontrada" });

      const recipients = db.prepare(`
        SELECT cp.id as cpId, p.name, p.specialty, p.location, p.category, p.email, p.contact
        FROM campaign_prospects cp JOIN prospects p ON cp.prospectId = p.id
        WHERE cp.campaignId = ? AND cp.userId = ? AND cp.personalizedBody = ''
      `).all(id, userId) as any[];

      if (recipients.length === 0) return res.json({ message: "Todos los mensajes ya están personalizados", personalized: 0 });

      const isWhatsApp = campaign.type === 'whatsapp';
      let personalized = 0;
      const batchSize = 5;

      for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        const batchPrompt = batch.map((r: any, idx: number) =>
          `Prospecto ${idx + 1}:\n- Nombre: ${r.name}\n- Especialidad: ${r.specialty || 'N/A'}\n- Ubicación: ${r.location || 'N/A'}\n- Categoría: ${r.category || 'N/A'}`
        ).join('\n\n');

        const prompt = isWhatsApp
          ? `Genera mensajes de WhatsApp personalizados y breves para estos prospectos usando la plantilla base.

${batchPrompt}

Plantilla base:
"""${campaign.templateBody}"""

Cada mensaje debe ser:
- Corto (máximo 300 caracteres)
- Conversacional y profesional
- Texto plano, sin HTML
- Personalizado para sentirse directo

Responde con JSON:
{"messages": [{"index": 0, "message": "texto"}, ...]}`
          : `Genera emails personalizados para estos prospectos usando la plantilla base.

${batchPrompt}

Asunto base: "${campaign.subject}"
Plantilla base:
"""${campaign.templateBody}"""

Personaliza cada mensaje adaptando el tono según el perfil. Profesional, conciso, en español.
Usa HTML simple para formato (párrafos, negritas).

Responde con JSON:
{"messages": [{"index": 0, "subject": "asunto personalizado", "body": "HTML del email"}, ...]}`;

        let aiResult: any;
        if (geminiEnabled) {
          try {
            const response = await ai!.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
            const text = response.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { messages: [] };
          } catch {
            aiResult = await callOpenRouterServer(prompt);
          }
        } else {
          aiResult = await callOpenRouterServer(prompt);
        }

        for (const msg of (aiResult.messages || [])) {
          const recipient = batch[msg.index];
          if (!recipient) continue;
          if (isWhatsApp) {
            db.prepare("UPDATE campaign_prospects SET personalizedBody = ? WHERE id = ?").run(msg.message || '', recipient.cpId);
          } else {
            db.prepare("UPDATE campaign_prospects SET personalizedSubject = ?, personalizedBody = ? WHERE id = ?").run(msg.subject || campaign.subject, msg.body || '', recipient.cpId);
          }
          personalized++;
        }

        // Small delay between batches
        if (i + batchSize < recipients.length) await new Promise(r => setTimeout(r, 1000));
      }

      res.json({ message: `${personalized} mensaje(s) personalizado(s)`, personalized });
    } catch (err: any) {
      console.error("Personalize error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Send campaign via Brevo
  app.post("/api/campaigns/:id/send", async (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const brevoApiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    const senderName = process.env.BREVO_SENDER_NAME || 'Prospectos CRM';

    if (!brevoApiKey || !senderEmail) {
      return res.status(400).json({ error: "BREVO_API_KEY y BREVO_SENDER_EMAIL no configurados en .env" });
    }

    try {
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND userId = ?").get(id, userId) as any;
      if (!campaign) return res.status(404).json({ error: "Campaña no encontrada" });
      if (campaign.type !== 'email') return res.status(400).json({ error: "Solo campañas de email pueden enviarse por Brevo" });

      // Get unsubscribed emails
      const unsubs = db.prepare("SELECT email FROM email_unsubscribes WHERE userId = ?").all(userId) as any[];
      const unsubSet = new Set(unsubs.map((u: any) => u.email.toLowerCase()));

      const recipients = db.prepare(`
        SELECT cp.id as cpId, cp.personalizedSubject, cp.personalizedBody, cp.status,
               p.email as prospectEmail, p.name
        FROM campaign_prospects cp JOIN prospects p ON cp.prospectId = p.id
        WHERE cp.campaignId = ? AND cp.userId = ? AND cp.status = 'pending'
      `).all(id, userId) as any[];

      if (recipients.length === 0) return res.json({ message: "No hay destinatarios pendientes", sent: 0 });

      db.prepare("UPDATE campaigns SET status = 'sending' WHERE id = ? AND userId = ?").run(id, userId);

      let sent = 0;
      let skipped = 0;

      for (const r of recipients) {
        if (!r.prospectEmail) { skipped++; continue; }
        if (unsubSet.has(r.prospectEmail.toLowerCase())) { skipped++; continue; }

        const subject = r.personalizedSubject || campaign.subject;
        const body = r.personalizedBody || campaign.templateBody;

        try {
          const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender: { name: senderName, email: senderEmail },
              to: [{ email: r.prospectEmail, name: r.name }],
              subject,
              htmlContent: body,
              tags: [`campaign-${id}`],
            }),
          });

          if (brevoRes.ok) {
            const brevoData = await brevoRes.json();
            const messageId = brevoData.messageId || '';
            db.prepare("UPDATE campaign_prospects SET status = 'sent', brevoMessageId = ?, sentAt = datetime('now') WHERE id = ?").run(messageId, r.cpId);
            sent++;
          } else {
            const errText = await brevoRes.text();
            console.error(`[Brevo] Error sending to ${r.prospectEmail}: ${errText}`);
            db.prepare("UPDATE campaign_prospects SET status = 'bounced' WHERE id = ?").run(r.cpId);
          }
        } catch (sendErr: any) {
          console.error(`[Brevo] Send error: ${sendErr.message}`);
        }

        // Rate limit: ~10 emails/second max
        await new Promise(r => setTimeout(r, 150));
      }

      db.prepare("UPDATE campaigns SET status = 'sent', sentCount = sentCount + ?, sentAt = datetime('now') WHERE id = ? AND userId = ?").run(sent, id, userId);

      res.json({ message: `${sent} email(s) enviado(s), ${skipped} omitido(s)`, sent, skipped });
    } catch (err: any) {
      console.error("Campaign send error:", err.message);
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND userId = ?").run(id, userId);
      res.status(500).json({ error: err.message });
    }
  });

  // Send test email
  app.post("/api/campaigns/:id/test", async (req, res) => {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { testEmail } = req.body;
    const brevoApiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    const senderName = process.env.BREVO_SENDER_NAME || 'Prospectos CRM';

    if (!brevoApiKey || !senderEmail) return res.status(400).json({ error: "Brevo no configurado" });
    if (!testEmail) return res.status(400).json({ error: "testEmail requerido" });

    try {
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND userId = ?").get(id, userId) as any;
      if (!campaign) return res.status(404).json({ error: "Campaña no encontrada" });

      const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: testEmail }],
          subject: `[TEST] ${campaign.subject}`,
          htmlContent: campaign.templateBody,
          tags: [`test-${id}`],
        }),
      });

      if (brevoRes.ok) {
        res.json({ message: `Email de prueba enviado a ${testEmail}` });
      } else {
        const errText = await brevoRes.text();
        res.status(500).json({ error: `Error de Brevo: ${errText}` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- OSINT Module (theHarvester-style) ---
  // Search DuckDuckGo HTML for links related to a person
  async function osintSearchDuckDuckGo(query: string): Promise<string[]> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const html = await res.text();
      const $ = cheerio.load(html);
      const links: string[] = [];
      $("a.result__a").each((_, el) => {
        const href = $(el).attr("href");
        if (href && href.startsWith("http")) links.push(href);
      });
      // Also extract from result__url spans (DuckDuckGo sometimes uses uddg redirects)
      $("a.result__snippet").parent().find("a").each((_, el) => {
        const href = $(el).attr("href");
        if (href && href.startsWith("http")) links.push(href);
      });
      return [...new Set(links)].slice(0, 8);
    } catch {
      return [];
    }
  }

  // Extract emails and phones from raw text using regex
  function extractContactsFromText(text: string): { emails: string[], phones: string[] } {
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const phoneRegex = /(?:\+?52\s?)?(?:\(?\d{2,3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{4})/g;
    const mxCellRegex = /\b(?:55|33|81|56)\s?\d{4}\s?\d{4}\b/g;

    const emails = [...new Set((text.match(emailRegex) || []))];
    const phonesRaw = [...(text.match(phoneRegex) || []), ...(text.match(mxCellRegex) || [])];
    const phones = [...new Set(phonesRaw.map(p => p.replace(/[\s\-().]/g, '')).filter(p => p.length >= 10))];

    return { emails, phones };
  }

  // Filter out generic emails
  function isDirectEmail(email: string): boolean {
    const genericPrefixes = ['info', 'contacto', 'atencion', 'recepcion', 'hola', 'admin', 'ventas', 'soporte', 'noreply', 'no-reply', 'contact', 'hello'];
    const prefix = email.split('@')[0].toLowerCase();
    return !genericPrefixes.some(g => prefix === g || prefix.startsWith(g + '.'));
  }

  // Full OSINT enrichment with DuckDuckGo
  async function osintSearchAndScrape(queries: string[]): Promise<{ emails: string[], phones: string[], sources: string[] }> {
    const allEmails: string[] = [];
    const allPhones: string[] = [];
    const sources: string[] = [];

    const allLinks: string[] = [];
    for (const q of queries) {
      const links = await osintSearchDuckDuckGo(q);
      allLinks.push(...links);
    }
    const uniqueLinks = [...new Set(allLinks)].slice(0, 10);

    console.log(`[OSINT] Encontrados ${uniqueLinks.length} links de DuckDuckGo`);

    const scrapeResults = await Promise.allSettled(
      uniqueLinks.map(url => scrapeUrl(url))
    );

    for (let i = 0; i < scrapeResults.length; i++) {
      const r = scrapeResults[i];
      if (r.status === "fulfilled" && r.value) {
        const { emails, phones } = extractContactsFromText(r.value);
        if (emails.length > 0 || phones.length > 0) {
          sources.push(uniqueLinks[i]);
          allEmails.push(...emails);
          allPhones.push(...phones);
        }
      }
    }

    return {
      emails: [...new Set(allEmails)],
      phones: [...new Set(allPhones)],
      sources: [...new Set(sources)],
    };
  }

  // Vuelta 1: Gemini como investigador — encuentra URLs específicas de la persona
  async function geminiDiscoverUrls(name: string, specialty: string, location: string): Promise<string[]> {
    if (!geminiEnabled) return [];

    const prompt = `Necesito encontrar las URLs de perfiles y páginas web donde aparece esta persona:
Nombre: ${name}
Especialidad: ${specialty}
Ubicación: ${location}

USA GOOGLE SEARCH para encontrar sus perfiles reales. Busca en:
- Su perfil de LinkedIn
- Su perfil en Doctoralia, Top Doctors, o directorios de su gremio
- Su página web personal o de su consultorio/despacho/empresa
- Su perfil en Facebook profesional
- Cualquier directorio donde aparezca con datos de contacto

Responde ÚNICAMENTE con un JSON con las URLs encontradas:
{"urls": ["url1", "url2", ...], "notes": "observaciones de la búsqueda"}`;

    try {
      console.log(`[Vuelta 1] Gemini buscando URLs para ${name}...`);
      const response = await ai!.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] }
      });
      const text = response.text;
      if (!text) return [];
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]);
      const urls = (parsed.urls || []).filter((u: string) => u && u.startsWith('http'));
      console.log(`[Vuelta 1] Gemini encontró ${urls.length} URLs para ${name}`);
      return urls.slice(0, 8);
    } catch (err: any) {
      console.warn(`[Vuelta 1] Gemini URL discovery falló: ${err.message}`);
      return [];
    }
  }

  // Vuelta 2: Scrape las URLs de Gemini + DuckDuckGo y extraer contactos reales
  async function osintEnrich(name: string, specialty: string, location: string): Promise<{ emails: string[], phones: string[], sources: string[] }> {
    // Paso A: DuckDuckGo queries (rápido, paralelo a Gemini)
    const ddgQueries = [
      `"${name}" ${specialty} ${location} contacto teléfono email`,
      `"${name}" ${specialty} celular correo`,
      `"${name}" ${location} linkedin`,
    ];

    // Paso B: Gemini URL discovery (primera vuelta)
    const [ddgData, geminiUrls] = await Promise.all([
      osintSearchAndScrape(ddgQueries),
      geminiDiscoverUrls(name, specialty, location),
    ]);

    // Paso C: Scrape las URLs que Gemini encontró (segunda vuelta)
    let geminiScrapedEmails: string[] = [];
    let geminiScrapedPhones: string[] = [];
    let geminiSources: string[] = [];

    if (geminiUrls.length > 0) {
      console.log(`[Vuelta 2] Scrapeando ${geminiUrls.length} URLs de Gemini para ${name}...`);
      const scrapeResults = await Promise.allSettled(
        geminiUrls.map(url => scrapeUrl(url))
      );

      for (let i = 0; i < scrapeResults.length; i++) {
        const r = scrapeResults[i];
        if (r.status === "fulfilled" && r.value) {
          const { emails, phones } = extractContactsFromText(r.value);
          if (emails.length > 0 || phones.length > 0) {
            geminiSources.push(geminiUrls[i]);
            geminiScrapedEmails.push(...emails);
            geminiScrapedPhones.push(...phones);
          }
        }
      }
      console.log(`[Vuelta 2] Extraídos ${geminiScrapedEmails.length} emails, ${geminiScrapedPhones.length} teléfonos de URLs de Gemini`);
    }

    // Combinar resultados de ambas fuentes
    return {
      emails: [...new Set([...geminiScrapedEmails, ...ddgData.emails])],
      phones: [...new Set([...geminiScrapedPhones, ...ddgData.phones])],
      sources: [...new Set([...geminiSources, ...ddgData.sources])],
    };
  }

  // Enrich endpoint: Vuelta 1 (Gemini URLs) + Vuelta 2 (Scraping) + Análisis AI
  app.post("/api/enrich", async (req, res) => {
    const { name, specialty, location, contact, email } = req.body;
    try {
      console.log(`[Enrich] Iniciando enriquecimiento para ${name}...`);

      // Vueltas 1+2: OSINT combinado (DuckDuckGo + Gemini URL discovery + scraping)
      const osintData = await osintEnrich(name, specialty || '', location || '');
      const directEmails = osintData.emails.filter(isDirectEmail);
      const currentPhone = (contact || '').replace(/[\s\-().]/g, '');
      const newPhones = osintData.phones.filter(p => p !== currentPhone);

      console.log(`[Enrich] ${name}: ${directEmails.length} emails directos, ${newPhones.length} teléfonos nuevos (de ${osintData.sources.length} fuentes)`);

      // Vuelta 3: AI analiza todo y selecciona el mejor contacto
      const osintContext = directEmails.length > 0 || newPhones.length > 0
        ? `\n\nDatos VERIFICADOS encontrados por OSINT (scraping directo de páginas web):\n- Emails encontrados: ${directEmails.slice(0, 10).join(', ') || 'ninguno'}\n- Teléfonos encontrados: ${newPhones.slice(0, 10).join(', ') || 'ninguno'}\n- Fuentes scrapeadas: ${osintData.sources.join(', ') || 'ninguna'}`
        : '';

      const prompt = `Analiza la información disponible y selecciona el MEJOR contacto directo para esta persona:
Nombre: ${name}
Especialidad: ${specialty}
Ubicación: ${location}
Teléfono actual: ${contact || "No disponible"}
Email actual: ${email || "No disponible"}
${osintContext}

CRITERIOS de selección:
1. Teléfono DIRECTO: celular personal o línea directa (NO conmutador, NO recepción, NO extensiones)
2. Email PERSONAL o DIRECTO: con nombre de la persona (NO genéricos como info@, contacto@, atencion@, hola@)
3. Si hay múltiples opciones, elige el que más probablemente sea contacto personal/directo

${osintContext ? 'IMPORTANTE: Los datos OSINT provienen de scraping real de páginas web, son VERIFICABLES. Prioriza estos datos sobre tu conocimiento general. Selecciona el mejor de los encontrados.' : 'Busca en Google, redes sociales profesionales, directorios especializados.'}

Responde ÚNICAMENTE con JSON válido:
{"direct_phone": "mejor teléfono directo o vacío", "direct_email": "mejor email directo o vacío", "phone_source": "URL o fuente del teléfono", "email_source": "URL o fuente del email", "confidence": "alta|media|baja", "notes": "razón de la selección"}`;

      let result;
      if (geminiEnabled) {
        try {
          console.log(`[Enrich] Vuelta 3: Gemini analiza resultados para ${name}...`);
          const response = await ai!.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] }
          });
          const text = response.text;
          if (!text) throw new Error("No response");
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON");
          result = JSON.parse(jsonMatch[0]);
          console.log(`[Enrich] Análisis completo para ${name}`);
        } catch (geminiErr: any) {
          console.warn(`[Enrich] Gemini análisis falló: ${geminiErr.message}, usando OpenRouter...`);
          result = await callOpenRouterServer(prompt);
        }
      } else {
        result = await callOpenRouterServer(prompt);
      }

      // Validar: si la AI devolvió un email genérico, descartarlo
      if (result.direct_email && !isDirectEmail(result.direct_email)) {
        console.log(`[Enrich] Email genérico descartado: ${result.direct_email}`);
        result.direct_email = '';
        result.email_source = '';
      }

      // Validar: teléfonos con indicadores genéricos
      if (result.direct_phone) {
        const ph = result.direct_phone.toLowerCase();
        if (ph.includes('ext') || ph.includes('conmutador') || ph.includes('0000') || ph.includes('no disponible')) {
          console.log(`[Enrich] Teléfono genérico descartado: ${result.direct_phone}`);
          result.direct_phone = '';
          result.phone_source = '';
        }
      }

      // Fallback: si AI no seleccionó nada válido pero OSINT encontró datos, usar directamente
      if (!result.direct_phone && newPhones.length > 0) {
        result.direct_phone = newPhones[0];
        result.phone_source = osintData.sources[0] || 'OSINT scraping';
      }
      if (!result.direct_email && directEmails.length > 0) {
        result.direct_email = directEmails[0];
        result.email_source = osintData.sources[0] || 'OSINT scraping';
      }

      // Metadata OSINT para el frontend
      result.osint_emails = directEmails.slice(0, 5);
      result.osint_phones = newPhones.slice(0, 5);
      result.osint_sources = osintData.sources;

      res.json(result);
    } catch (err: any) {
      console.error("Enrich error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Continuous Discovery (persistent) ---
  const runningJobs = new Map<string, { active: boolean }>();

  function startContinuousJob(userId: string, categories: string[], locations: string[], sources: string[], startRound = 0) {
    if (runningJobs.get(userId)?.active) return;
    const handle = { active: true };
    runningJobs.set(userId, handle);

    const allLocations = locations.length > 0 ? locations : ['Ciudad de México'];

    (async () => {
      let round = startRound;
      while (handle.active) {
        round++;
        // Rotate through locations: each round picks a different city
        const location = allLocations[(round - 1) % allLocations.length];
        console.log(`[Continuo] Ronda ${round} para ${userId} — ${location} (${categories.join(', ')})...`);

        // Update DB with progress
        db.prepare("UPDATE continuous_jobs SET rounds = ?, lastActivity = datetime('now') WHERE userId = ?").run(round, userId);

        try {
          let result;
          const customSource = sources.join(', ');
          if (geminiEnabled) {
            try {
              result = await discoverWithGemini(categories, location, customSource);
            } catch {
              result = await discoverWithScraping(categories, location, customSource);
            }
          } else {
            result = await discoverWithScraping(categories, location, customSource);
          }

          if (result?.leads?.length > 0) {
            const existing = db.prepare("SELECT name FROM prospects WHERE userId = ?").all(userId) as any[];
            const existingNames = new Set(existing.map((r: any) => r.name.toLowerCase().trim()));
            const newLeads = result.leads.filter((l: any) => !existingNames.has(l.name.toLowerCase().trim()));

            if (newLeads.length > 0) {
              const insert = db.prepare(`INSERT INTO prospects (id, name, specialty, location, contact, email, category, source, notes, url, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
              const tx = db.transaction((leads: any[]) => {
                for (const p of leads) {
                  const id = Math.random().toString(36).substr(2, 9);
                  const url = extractUrlFromSource(p.source, p.email);
                  insert.run(id, p.name, p.specialty, p.location, p.contact, p.email, p.category, p.source, '', url, userId);
                }
              });
              tx(newLeads);
              console.log(`[Continuo] Ronda ${round} (${location}): ${newLeads.length} nuevos prospectos guardados`);
            }

            // Qualify + OSINT for pending
            const pending = db.prepare("SELECT * FROM prospects WHERE userId = ? AND (contactQuality = 'pending' OR contactQuality IS NULL) LIMIT 5").all(userId) as any[];
            for (const p of pending) {
              if (!handle.active) break;
              const dbJob = db.prepare("SELECT active FROM continuous_jobs WHERE userId = ?").get(userId) as any;
              if (!dbJob?.active) { handle.active = false; break; }

              try {
                const osintData = await osintEnrich(p.name, p.specialty || '', p.location || '');
                const directEmails = osintData.emails.filter(isDirectEmail);
                const currentPhone = (p.contact || '').replace(/[\s\-().]/g, '');
                const newPhones = osintData.phones.filter((ph: string) => ph !== currentPhone);
                const newContact = newPhones[0] || p.contact;
                const newEmail = directEmails[0] || p.email;
                const url = p.url || extractUrlFromSource(p.source, newEmail);

                let quality = 'pending';
                if (newContact && newEmail && !['info@','contacto@','atencion@','recepcion@','hola@','admin@'].some(g => (newEmail||'').toLowerCase().startsWith(g))) {
                  quality = 'direct';
                } else if (newContact || newEmail) {
                  quality = 'generic';
                }

                db.prepare("UPDATE prospects SET contact = ?, email = ?, contactQuality = ?, url = ? WHERE id = ? AND userId = ?")
                  .run(newContact, newEmail, quality, url, p.id, userId);
              } catch (err: any) {
                console.warn(`[Continuo] OSINT falló para ${p.name}: ${err.message}`);
              }
            }
          }
        } catch (err: any) {
          console.error(`[Continuo] Error en ronda ${round}: ${err.message}`);
        }

        if (!handle.active) break;
        const dbCheck = db.prepare("SELECT active FROM continuous_jobs WHERE userId = ?").get(userId) as any;
        if (!dbCheck?.active) { handle.active = false; break; }

        await new Promise(resolve => setTimeout(resolve, 60000));
      }

      db.prepare("UPDATE continuous_jobs SET active = 0 WHERE userId = ?").run(userId);
      runningJobs.delete(userId);
      console.log(`[Continuo] Proceso terminado para ${userId} tras ${round} rondas`);
    })();
  }

  app.get("/api/continuous/status", (req, res) => {
    const userId = (req as any).user.id;
    const job = db.prepare("SELECT * FROM continuous_jobs WHERE userId = ?").get(userId) as any;
    res.json({
      active: job?.active === 1,
      rounds: job?.rounds || 0,
      lastActivity: job?.lastActivity || null,
      startedAt: job?.startedAt || null,
    });
  });

  app.post("/api/continuous/start", (req, res) => {
    const userId = (req as any).user.id;
    const { categories, locations, location, sources } = req.body;
    // Support both "locations" (array) and legacy "location" (string)
    const locArray: string[] = Array.isArray(locations) ? locations : (location ? [location] : ['Ciudad de México']);
    const locJson = JSON.stringify(locArray);

    const existing = db.prepare("SELECT active FROM continuous_jobs WHERE userId = ?").get(userId) as any;
    if (existing?.active === 1 && runningJobs.get(userId)?.active) {
      return res.json({ message: "Ya hay un proceso continuo activo" });
    }

    // Upsert job config — store locations as JSON array in the location column
    if (existing) {
      db.prepare("UPDATE continuous_jobs SET active = 1, categories = ?, location = ?, sources = ?, rounds = 0, startedAt = datetime('now'), lastActivity = datetime('now') WHERE userId = ?")
        .run(JSON.stringify(categories || []), locJson, JSON.stringify(sources || []), userId);
    } else {
      db.prepare("INSERT INTO continuous_jobs (userId, active, categories, location, sources, rounds, startedAt, lastActivity) VALUES (?, 1, ?, ?, ?, 0, datetime('now'), datetime('now'))")
        .run(userId, JSON.stringify(categories || []), locJson, JSON.stringify(sources || []));
    }

    startContinuousJob(userId, categories || [], locArray, sources || []);
    res.json({ message: "Proceso continuo iniciado" });
  });

  app.post("/api/continuous/stop", (req, res) => {
    const userId = (req as any).user.id;
    db.prepare("UPDATE continuous_jobs SET active = 0 WHERE userId = ?").run(userId);
    const handle = runningJobs.get(userId);
    if (handle) handle.active = false;
    res.json({ message: "Proceso continuo detenido" });
  });

  // Resume active jobs on server start
  const activeJobs = db.prepare("SELECT * FROM continuous_jobs WHERE active = 1").all() as any[];
  for (const job of activeJobs) {
    console.log(`[Continuo] Reanudando proceso para ${job.userId} (ronda ${job.rounds})...`);
    try {
      const categories = JSON.parse(job.categories || '[]');
      const sources = JSON.parse(job.sources || '[]');
      // location column may be a JSON array or a plain string (legacy)
      let locArray: string[];
      try { locArray = JSON.parse(job.location || '[]'); } catch { locArray = [job.location || 'Ciudad de México']; }
      if (!Array.isArray(locArray)) locArray = [locArray as any];
      if (locArray.length === 0) locArray = ['Ciudad de México'];
      startContinuousJob(job.userId, categories, locArray, sources, job.rounds || 0);
    } catch (err: any) {
      console.error(`[Continuo] Error reanudando para ${job.userId}: ${err.message}`);
      db.prepare("UPDATE continuous_jobs SET active = 0 WHERE userId = ?").run(job.userId);
    }
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de Prospección con SQLite corriendo en http://localhost:${PORT}`);
  });
}

startServer();
