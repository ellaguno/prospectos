import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "" 
});

export const discoverProspects = async (categories: string[], location: string = 'Mérida, Yucatán', customSource?: string) => {
  const prompt = `Actúa como un experto en prospección inmobiliaria en México. 
  Busca y genera una lista de 20 prospectos REALES de alto perfil en ${location}.
  Tipos de perfil solicitado: ${categories.join(', ')}.
  ${customSource ? `PRIORIZA buscar en esta fuente específica: ${customSource}.` : "Puedes buscar en Google, LinkedIn, directorios profesionales y sitios especializados regionales (Sección Amarilla, Doctoralia, etc.)."}
  Para cada prospecto necesito: Nombre completo, Especialidad o Cargo/Empresa, Ubicación aproximada (Ciudad/Colonia/Edificio), Teléfono (incluyendo lada), Correo Electrónico público (si está disponible), y la Fuente de la información.
  
  Asegúrate de que sean profesionales que operen actualmente en ${location}.`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
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
                source: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");
  return JSON.parse(text);
};

export const extractFromText = async (textContent: string) => {
  const prompt = `Extrae información de prospectos del siguiente texto pegado de un sitio web.
  
  Texto: """${textContent}"""
  
  Detecta nombres, especialidades, clínicas, teléfonos, correos electrónicos y ubicaciones.
  Clasifica cada lead en una de estas categorías: 'Salud', 'Legal', 'Inversión', 'Arquitectura', 'Profesionales', 'Otros'.`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
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
                source: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");
  return JSON.parse(text);
};
