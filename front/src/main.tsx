import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';

function applyMobileHeight() {
  if (window.innerWidth <= 768) {
    document.documentElement.style.setProperty('--root-height', `${window.innerHeight - 50}px`);
    document.documentElement.style.setProperty('--root-width', `${window.innerWidth - 50}px`);
  } else {
    document.documentElement.style.removeProperty('--root-height');
    document.documentElement.style.removeProperty('--root-width');
  }
}
applyMobileHeight();
window.addEventListener('resize', applyMobileHeight);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Failed to find root element');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
