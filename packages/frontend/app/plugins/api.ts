/**
 * API plugin to automatically add JWT token to all requests
 */
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase

  // Create a custom $fetch instance with JWT token
  const apiFetch = $fetch.create({
    baseURL: apiBase,
    onRequest({ options }) {
      // Add JWT token to all requests if available
      if (process.client) {
        const token = localStorage.getItem('duckling_jwt_token')
        if (token) {
          options.headers = {
            ...options.headers,
            Authorization: `Bearer ${token}`
          }
        }
      }
    },
    onResponseError({ response }) {
      // Handle 401 errors by clearing token and redirecting to login
      if (response.status === 401 && process.client) {
        localStorage.removeItem('duckling_jwt_token')

        // Redirect to login if not already there
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
      }
    }
  })

  return {
    provide: {
      api: apiFetch
    }
  }
})
