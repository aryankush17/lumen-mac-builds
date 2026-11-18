import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuditProvider } from './store/auditStore'
import Layout from './components/layout/Layout'
import WebsiteAudit from './pages/WebsiteAudit'
import Blueprint from './pages/Blueprint'
import WebsiteInspiration from './modules/website-inspiration/WebsiteInspiration'
import { lazy, Suspense } from 'react'
const WebsiteBuilder = lazy(() => import('./builder/WebsiteBuilder'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5 * 60 * 1000 } }
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuditProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<Navigate to="/build" replace />} />
              <Route path="build" element={<Suspense fallback={<p>Opening Website Studio…</p>}><WebsiteBuilder /></Suspense>} />
              <Route path="audit" element={<WebsiteAudit />} />
              <Route path="blueprint" element={<Blueprint />} />
              <Route path="inspiration" element={<WebsiteInspiration />} />
              <Route path="*" element={<Navigate to="/build" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuditProvider>
    </QueryClientProvider>
  )
}
