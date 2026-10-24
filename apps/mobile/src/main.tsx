import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@hemi/conversation-flow/styles.css';
import '@hemi/ui/styles/touch.css';
import '@hemi/conversation-flow/styles/touch.css';
import './style.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
