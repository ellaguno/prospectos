import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const _origFetch = window.fetch;
const _apiPrefix = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    input = _apiPrefix + input;
  }
  return _origFetch.call(window, input, init);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
