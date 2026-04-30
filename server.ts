import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import cors from "cors";

dotenv.config();

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
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

async function startServer() {
  const app = express();
  const PORT = 3000;

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
