const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

const LEAD_SCHEMA = `{
  "leads": [
    {
      "name": "string (nombre completo)",
      "specialty": "string (especialidad o cargo)",
      "location": "string (ubicación)",
      "contact": "string (teléfono con lada)",
      "email": "string (correo electrónico o vacío)",
      "category": "string (Salud|Legal|Inversión|Arquitectura|Profesionales|Otros)",
      "source": "string (fuente de la información)"
    }
  ]
}`;

async function callOpenRouter(prompt: string): Promise<any> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: "Eres un asistente experto en prospección inmobiliaria en México. SIEMPRE responde ÚNICAMENTE con JSON válido, sin markdown, sin bloques de código, sin texto adicional."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("No response from OpenRouter");

  // Extract JSON from response (handle cases where model wraps in ```json blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No valid JSON in OpenRouter response");

  return JSON.parse(jsonMatch[0]);
}

export const discoverProspects = async (categories: string[], location: string = 'Mérida, Yucatán', customSource?: string) => {
  const prompt = `Actúa como un experto en prospección inmobiliaria en México.
  Busca y genera una lista de 20 prospectos REALES de alto perfil en ${location}.
  Tipos de perfil solicitado: ${categories.join(', ')}.
  ${customSource ? `PRIORIZA buscar en esta fuente específica: ${customSource}.` : "Busca en directorios profesionales y sitios especializados regionales (Sección Amarilla, Doctoralia, etc.)."}
  Para cada prospecto necesito: Nombre completo, Especialidad o Cargo/Empresa, Ubicación aproximada (Ciudad/Colonia/Edificio), Teléfono (incluyendo lada), Correo Electrónico público (si está disponible), y la Fuente de la información.

  Asegúrate de que sean profesionales que operen actualmente en ${location}.

  Responde ÚNICAMENTE con JSON válido con este esquema exacto:
  ${LEAD_SCHEMA}`;

  return callOpenRouter(prompt);
};

export const extractFromText = async (textContent: string) => {
  const prompt = `Extrae información de prospectos del siguiente texto pegado de un sitio web.

  Texto: """${textContent}"""

  Detecta nombres, especialidades, clínicas, teléfonos, correos electrónicos y ubicaciones.
  Clasifica cada lead en una de estas categorías: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.

  Responde ÚNICAMENTE con JSON válido con este esquema exacto:
  ${LEAD_SCHEMA}`;

  return callOpenRouter(prompt);
};
