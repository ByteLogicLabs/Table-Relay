import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './app';
import './index.css';
import './lib/monaco-setup';
import { installAutocorrectDisabler } from './lib/disable-autocorrect';

installAutocorrectDisabler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
