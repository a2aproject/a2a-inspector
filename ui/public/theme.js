// Applies the saved color theme before the first paint, so a light or dark choice doesn't flash.
// It's a separate file because the Content-Security-Policy doesn't allow inline scripts.
try {
  document.documentElement.dataset.theme = localStorage.getItem('a2a-inspector.theme') || 'auto';
} catch {
  document.documentElement.dataset.theme = 'auto';
}
