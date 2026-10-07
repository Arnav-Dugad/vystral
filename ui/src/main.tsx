import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/unbounded';
import './styles/tokens.css';
import './styles/base.css';
import App from './App';
import { useStore } from './state/store';
import { markOnce, startStartupTracking } from './state/startup';
import { applyFirstPaintAppearance } from './lib/firstPaint';

// Track AA: startup marks (local log only), the first-paint snapshot's theme before the first frame.
markOnce('script');
const firstPaint = useStore.getState().firstPaint;
applyFirstPaintAppearance(firstPaint);
startStartupTracking(firstPaint);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
