import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { FlowformProvider } from './state/FlowformContext'
import { bootstrapTheme } from './state/theme'

bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlowformProvider>
      <App />
    </FlowformProvider>
  </StrictMode>,
)
