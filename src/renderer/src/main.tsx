import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { exposeFullTrustPluginRegistry } from './full-trust-plugin-registry'
import './styles.css'

exposeFullTrustPluginRegistry()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
