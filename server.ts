import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
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

async function extractWithGemini(textContent: string): Promise<any> {
  if (!ai) throw new Error("Gemini not configured");

  const prompt = `Extrae información de prospectos del siguiente texto pegado de un sitio web.

  Texto: """${textContent}"""

  Detecta nombres, especialidades, clínicas, teléfonos, correos electrónicos y ubicaciones.
  Clasifica cada lead en una de estas categorías: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.`;

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

  // --- Auth middleware for all /api routes (except auth) ---
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) return next();
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
    try {
      const rows = db.prepare("SELECT * FROM prospects WHERE userId = ? ORDER BY createdAt DESC").all(userId);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/prospects", (req, res) => {
    const userId = (req as any).user.id;
    const prospects = Array.isArray(req.body) ? req.body : [req.body];
    const insert = db.prepare(`INSERT INTO prospects (id, name, specialty, location, contact, email, category, source, notes, url, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const transaction = db.transaction((leads) => {
      for (const p of leads) {
        const id = Math.random().toString(36).substr(2, 9);
        const url = p.url || extractUrlFromSource(p.source, p.email);
        insert.run(id, p.name, p.specialty, p.location, p.contact, p.email, p.category, p.source, p.notes || '', url, userId);
      }
    });

    try {
      transaction(prospects);
      res.json({ message: "Guardado exitosamente" });
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
      // Try Gemini first
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

      // Fallback: OpenRouter
      const prompt = `Extrae información de prospectos del siguiente texto pegado de un sitio web.

Texto: """${text}"""

Detecta nombres, especialidades, clínicas, teléfonos, correos electrónicos y ubicaciones.
Clasifica cada lead en una de estas categorías: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.

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
    const allowedFields = ['name', 'specialty', 'location', 'contact', 'email', 'category', 'source', 'contactQuality', 'notes', 'url'];
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

  // --- Continuous Discovery SSE ---
  const continuousJobs = new Map<string, { active: boolean }>();

  app.get("/api/continuous/status", (req, res) => {
    const userId = (req as any).user.id;
    const job = continuousJobs.get(userId);
    res.json({ active: job?.active || false });
  });

  app.post("/api/continuous/start", (req, res) => {
    const userId = (req as any).user.id;
    const { categories, location, sources } = req.body;
    if (continuousJobs.get(userId)?.active) {
      return res.json({ message: "Ya hay un proceso continuo activo" });
    }
    continuousJobs.set(userId, { active: true });
    res.json({ message: "Proceso continuo iniciado" });

    // Run in background
    (async () => {
      const job = continuousJobs.get(userId)!;
      let round = 0;
      while (job.active) {
        round++;
        console.log(`[Continuo] Ronda ${round} para ${userId}...`);
        try {
          // Step 1: Discover
          let result;
          const customSource = (sources || []).join(', ');
          if (geminiEnabled) {
            try {
              result = await discoverWithGemini(categories || [], location || 'Ciudad de México', customSource);
            } catch {
              result = await discoverWithScraping(categories || [], location || 'Ciudad de México', customSource);
            }
          } else {
            result = await discoverWithScraping(categories || [], location || 'Ciudad de México', customSource);
          }

          if (result?.leads?.length > 0) {
            // Deduplicate against existing
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
              console.log(`[Continuo] Ronda ${round}: ${newLeads.length} nuevos prospectos guardados`);
            }

            // Step 2: Qualify + OSINT for pending prospects
            const pending = db.prepare("SELECT * FROM prospects WHERE userId = ? AND (contactQuality = 'pending' OR contactQuality IS NULL) LIMIT 5").all(userId) as any[];
            for (const p of pending) {
              if (!job.active) break;
              try {
                const osintData = await osintEnrich(p.name, p.specialty || '', p.location || '');
                const directEmails = osintData.emails.filter(isDirectEmail);
                const currentPhone = (p.contact || '').replace(/[\s\-().]/g, '');
                const newPhones = osintData.phones.filter((ph: string) => ph !== currentPhone);
                const newContact = newPhones[0] || p.contact;
                const newEmail = directEmails[0] || p.email;
                const url = p.url || extractUrlFromSource(p.source, newEmail);

                // Determine quality
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

        if (!job.active) break;
        // Wait 60 seconds between rounds
        await new Promise(resolve => setTimeout(resolve, 60000));
      }
      console.log(`[Continuo] Proceso terminado para ${userId} tras ${round} rondas`);
    })();
  });

  app.post("/api/continuous/stop", (req, res) => {
    const userId = (req as any).user.id;
    const job = continuousJobs.get(userId);
    if (job) job.active = false;
    res.json({ message: "Proceso continuo detenido" });
  });

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
