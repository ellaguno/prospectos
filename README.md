# Prospectos — CRM de Prospección con IA

CRM multiusuario para descubrir, calificar y enriquecer prospectos. Combina búsqueda con IA, OSINT automático y flujos manuales.

## Funcionalidades

### Descubrimiento y captura
- **Descubrimiento AI** — Busca prospectos reales por categoría y ubicación con Gemini + Google Search
- **Búsqueda continua en background** — Cerrar el modal no interrumpe; indicador flotante muestra el progreso
- **Buscar persona** — Alta + OSINT automático en un solo paso
- **Importar texto** — Pega CSV/TSV o texto libre; parseo directo o extracción con IA
- **Registro manual** — Alta a mano de prospectos
- **Segmentos dinámicos** — Categorías personalizables (perfiles de mercado)
- **Fuentes** — Facebook, Instagram, LinkedIn y web por default
- **Deduplicación** — Omite nombres ya existentes al guardar

### Calificación y enriquecimiento (OSINT)
- **Pipeline OSINT en dos vueltas** — Gemini encuentra URLs, scraping extrae datos
- **Calificación automática** — Detecta contactos genéricos (emails/teléfonos) y los descarta post-AI
- **Calificar/descalificar manual** — Override del veredicto de la IA
- **Evaluación masiva** — Aplica el pipeline a múltiples prospectos
- **Columna de confianza** — Semáforo visual + ordenamiento
- **Notas** y **URL auto-extraída** por prospecto

### Tabla y operaciones
- **Paginación server-side** — 15/50/100/200 por página (con persistencia)
- **Búsqueda y filtros** ejecutados en backend
- **Acciones rápidas** — Edición, borrado, selección múltiple
- **Cambio rápido de categoría** desde la tabla
- **Filas clickables** abren modal de detalle
- **Sidebar colapsable**

### Exportación
- **Excel con estilos** — Encabezados negro/blanco, agrupado por categoría, columna de calidad con color, autofilter
- **CSV** y **VCF** (contactos)

### Organizaciones, jerarquía y relaciones
- **Organizaciones** — CRUD + detección AI desde prospectos
- **Jerarquía intra-org** — Descubrimiento AI de roles y relación superior/subordinado
- **Relaciones cross-org** — Ex colegas, familia, amigos, socios (OSINT + AI)

### Campañas
- **Email vía Brevo** — Personalización AI por prospecto, envío y tracking (opens / clicks / unsubs vía webhook)
- **WhatsApp** — Generación de mensajes personalizados (envío manual con tracking)
- **Lista de destinatarios** por campaña, edición individual de copy

### Descubrimiento continuo persistente
- Sobrevive reinicios del servidor — el job se reanuda al volver a levantar el proceso

### Multiusuario y autenticación
- **JWT** — Login, rutas protegidas, pantalla de login
- **Prospectos aislados por usuario** — Cada usuario ve solo los suyos
- **Admin** puede crear, editar y borrar usuarios

## Proveedores de IA

3 modos vía `AI_PROVIDER` en `.env`:

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
   Edita `.env` con tus API keys (ver `.env.example`).

3. Ejecutar:
   ```
   npm run dev
   ```

## Tech Stack

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS + Framer Motion
- **Backend:** Express + tsx (mismo proceso que Vite en dev)
- **DB:** SQLite (better-sqlite3) — `prospectos.db`
- **Auth:** JWT + bcrypt
- **IA:** Google Gemini (`@google/genai`) + OpenRouter
- **Scraping:** cheerio
- **Export:** xlsx-js-style
- **Email:** Brevo (transactional API + webhook tracking)

## Endpoints principales

- `POST /api/auth/login`, `GET /api/auth/me`
- `GET/POST/PATCH/DELETE /api/users` (admin)
- `GET/POST/PATCH /api/prospects`, `DELETE /api/prospects` (bulk)
- `POST /api/discover` — descubrimiento AI
- `POST /api/extract` — extracción desde texto
- `POST /api/enrich` — pipeline OSINT
- `GET/POST /api/continuous/{status,start,stop}` — búsqueda continua (persistente entre reinicios)
- `GET/POST/PATCH/DELETE /api/organizations` + `/api/organizations/detect`
- `GET/POST /api/organizations/:id/hierarchy`, `POST /api/organizations/:id/discover-hierarchy`
- `GET /api/prospects/:id/relationships`, `POST /api/relationships`, `POST /api/relationships/discover`
- `GET/POST/PATCH/DELETE /api/campaigns` + `/recipients`, `/personalize`, `/send`, `/test`
- `POST /api/webhooks/brevo` — tracking de aperturas/clicks/unsubs (sin auth)
