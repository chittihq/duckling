// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },

  // Disable SSR - build as SPA for static hosting from Express server
  ssr: false,

  // Configure Nitro to generate static files
  nitro: {
    preset: 'static'
  },

  // Use app directory as source
  srcDir: 'app/',

  // Allow Docker container to accept external connections
  devServer: {
    host: '0.0.0.0',
    port: 3000
  },

  modules: [
    '@nuxtjs/tailwindcss',
    'shadcn-nuxt'
  ],

  shadcn: {
    prefix: '',
    componentDir: './app/components/ui'
  },

  css: ['~/assets/css/main.css'],

  // Runtime config for API base URL
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3001'
    }
  },

  // TypeScript configuration
  typescript: {
    strict: false,
    shim: false
  }
})
