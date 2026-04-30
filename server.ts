import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import cors from "cors";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";

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
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migration: add contactQuality column if missing
try { db.exec(`ALTER TABLE prospects ADD COLUMN contactQuality TEXT DEFAULT 'pending'`); } catch {};

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000");

  app.use(express.json());
  app.use(cors());

  // API Routes
  app.get("/api/prospects", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM prospects ORDER BY createdAt DESC").all();
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/prospects", (req, res) => {
    const prospects = Array.isArray(req.body) ? req.body : [req.body];
    const insert = db.prepare(`INSERT INTO prospects (id, name, specialty, location, contact, email, category, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    
    const transaction = db.transaction((leads) => {
      for (const p of leads) {
        const id = Math.random().toString(36).substr(2, 9);
        insert.run(id, p.name, p.specialty, p.location, p.contact, p.email, p.category, p.source);
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
    const { contact, email, contactQuality } = req.body;
    try {
      const updates: string[] = [];
      const values: any[] = [];
      if (contact !== undefined) { updates.push("contact = ?"); values.push(contact); }
      if (email !== undefined) { updates.push("email = ?"); values.push(email); }
      if (contactQuality !== undefined) { updates.push("contactQuality = ?"); values.push(contactQuality); }
      if (updates.length === 0) return res.json({ message: "Nothing to update" });
      values.push(id);
      db.prepare(`UPDATE prospects SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      res.json({ message: "Actualizado" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enrich a prospect - search for direct contact info
  app.post("/api/enrich", async (req, res) => {
    const { name, specialty, location, contact, email } = req.body;
    try {
      const prompt = `Busca información de contacto DIRECTO para esta persona específica:
Nombre: ${name}
Especialidad: ${specialty}
Ubicación: ${location}
Teléfono actual: ${contact || "No disponible"}
Email actual: ${email || "No disponible"}

NECESITO encontrar:
1. Un número de teléfono DIRECTO (celular personal o línea directa, NO conmutador ni recepción)
2. Un email PERSONAL o DIRECTO (NO correos genéricos como info@, contacto@, atencion@, recepcion@, hola@)

Si el teléfono actual parece ser un conmutador o el email es genérico, busca alternativas más directas.
Busca en Google, redes sociales profesionales, directorios especializados.

Responde ÚNICAMENTE con JSON válido:
{"direct_phone": "teléfono directo encontrado o vacío", "direct_email": "email directo encontrado o vacío", "phone_source": "dónde encontraste el teléfono", "email_source": "dónde encontraste el email", "confidence": "alta|media|baja", "notes": "notas sobre la búsqueda"}`;

      let result;
      if (geminiEnabled) {
        try {
          console.log(`[Enrich] Buscando contacto directo para ${name} con Gemini...`);
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
          console.log(`[Enrich] Gemini OK para ${name}`);
        } catch (geminiErr: any) {
          console.warn(`[Enrich] Gemini falló: ${geminiErr.message}, usando OpenRouter...`);
          result = await callOpenRouterServer(prompt);
        }
      } else {
        result = await callOpenRouterServer(prompt);
      }

      res.json(result);
    } catch (err: any) {
      console.error("Enrich error:", err.message);
      res.status(500).json({ error: err.message });
    }
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
