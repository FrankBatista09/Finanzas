import '@fontsource-variable/schibsted-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api/client';
import { App } from './App';
import { FinanzasProvider, FinanzasStores } from './store';

// By default TanStack notifies components in a setTimeout. With a microtask the optimistic edit
// is painted in the same frame as the keystroke and always before the next key.
notifyManager.setScheduler(queueMicrotask);

const queryClient = new QueryClient();
const stores = new FinanzasStores(queryClient, api);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FinanzasProvider stores={stores} api={api}>
        <App />
      </FinanzasProvider>
    </QueryClientProvider>
  </StrictMode>,
);
