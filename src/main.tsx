import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './app';
import './index.css';
import './lib/monaco-setup';
import { installAutocorrectDisabler } from './lib/disable-autocorrect';

installAutocorrectDisabler();

// Build marker — confirms a FULL bundle reload picked up the latest code
// (lazy per-tab loading + concurrency gate + dbtable→tablerelay rename). If you
// reload and DON'T see this line bump, the bundle is stale: restart
// `npm run tauri dev` rather than using the in-app ⌘+R (which is a soft
// data-reload, not a bundle reload).
// eslint-disable-next-line no-console
console.info('%c[table-relay] build: v7 (rename dbtable→tablerelay + migration)', 'color:#22c55e;font-weight:bold');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
