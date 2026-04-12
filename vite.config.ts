import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  appType: 'spa',
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
  plugins: [react(), {
    name: 'agentvrm-block-removed-json',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/vrm/manifest.json' || req.url === '/agentvrm.json') {
          res.statusCode = 410
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Removed. VRM selection is bundled into the app.')
          return
        }
        next()
      })
    },
  }, cloudflare()],
})