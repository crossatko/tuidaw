import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname),

  plugins: [
    vue({
      features: {
        optionsAPI: false
      }
    }),
    tailwindcss()
  ],

  resolve: {
    alias: {
      // Use the vapor-aware Vue runtime so Vapor components work
      vue: resolve(
        __dirname,
        '..',
        'node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.js'
      ),
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, '..', 'src')
    }
  },

  server: {
    port: 3666,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
