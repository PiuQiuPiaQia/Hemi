import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@hemi/conversation-flow/styles.css';
import './style.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
