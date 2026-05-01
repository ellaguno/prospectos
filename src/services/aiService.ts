// All AI calls go through the server (scraping + OpenRouter)
// No API keys needed in the frontend

function getToken(): string | null {
  return localStorage.getItem('prospectos_token');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

export const discoverProspects = async (categories: string[], location: string = 'Ciudad de México', customSource?: string) => {
  const response = await fetch('/api/discover', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ categories, location, customSource }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Discovery failed');
  }

  return response.json();
};

export const extractFromText = async (textContent: string) => {
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ text: textContent }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Extraction failed');
  }

  return response.json();
};
