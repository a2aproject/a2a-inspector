import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// IBM Plex, as in the a2a-itk dashboard, bundled rather than loaded from Google Fonts: the
// Content-Security-Policy only allows the inspector's own fonts. Latin subsets only.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
