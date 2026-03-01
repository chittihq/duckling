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

  // Allow Docker container to accept external connections
  devServer: {
    host: '0.0.0.0',
    port: 3000
  },

  modules: [
    'shadcn-nuxt'
  ],

  shadcn: {
    prefix: '',
    componentDir: './app/components/ui'
  },

  css: ['~/assets/css/main.css'],

  // Runtime config for API base URL
  // Empty string means relative URLs - works in production when frontend is served from same server
  // Use NUXT_PUBLIC_API_BASE env var for development or different domains
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || ''
    }
  },

  // PostCSS with Tailwind (replaces @nuxtjs/tailwindcss module for Nuxt 4)
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  // TypeScript configuration
  typescript: {
    strict: false,
    shim: false
  }
})
