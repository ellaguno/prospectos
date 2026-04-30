# Prospectos - CRM de Prospección

CRM de prospección con IA. Descubre prospectos de alto perfil usando scraping + IA y extrae leads de texto pegado.

## Funcionalidades

- **Descubrimiento AI** — Busca prospectos reales por categoría y ubicación (Gemini con Google Search)
- **Extracción de texto** — Pega contenido de directorios/web y extrae leads automáticamente (OpenRouter)
- **Registro manual** — Agrega prospectos a mano
- **Exportación** — Excel y CSV
- **Base de datos** — SQLite con persistencia local

## Proveedores de IA

El proyecto soporta 3 modos vía `AI_PROVIDER` en `.env`:

| Modo | Descubrimiento | Extracción | Ideal para |
|------|---------------|------------|------------|
| `gemini` | Gemini | Gemini | Máxima calidad |
| `openrouter` | OpenRouter | OpenRouter | 100% gratuito |
| `hybrid` | Gemini (Google Search) | OpenRouter (gratis) | Balance costo/calidad |

## Instalación

**Requisitos:** Node.js

1. Instalar dependencias:
   ```
   npm install
   ```

2. Copiar y configurar variables de entorno:
   ```
   cp .env.example .env
   ```
   Edita `.env` con tus API keys (ver `.env.example` para documentación).

3. Ejecutar:
   ```
   npm run dev
   ```

## Tech Stack

- React + TypeScript + Vite
- Tailwind CSS + Framer Motion
- Express + SQLite (better-sqlite3)
- Google Gemini API + OpenRouter API
