/**
 * Composable for making authenticated API calls with JWT
 */
export const useApi = () => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase
  const { getAuthHeaders } = useAuth()

  /**
   * Make an authenticated API request with JWT token
   */
  const apiCall = async <T>(
    endpoint: string,
    options: RequestInit & { method?: string; body?: any } = {}
  ): Promise<T> => {
    const headers = {
      ...getAuthHeaders(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }

    const fetchOptions: any = {
      ...options,
      headers
    }

    // Handle body serialization
    if (options.body && typeof options.body === 'object') {
      fetchOptions.body = JSON.stringify(options.body)
    }

    try {
      const response = await $fetch<T>(`${apiBase}${endpoint}`, fetchOptions)
      return response
    } catch (error: any) {
      // Handle 401 errors by redirecting to login
      if (error.response?.status === 401 || error.statusCode === 401) {
        if (process.client) {
          localStorage.removeItem('duckling_jwt_token')
          if (window.location.pathname !== '/login') {
            window.location.href = '/login'
          }
        }
      }
      throw error
    }
  }

  /**
   * Convenience methods for common HTTP verbs
   */
  const get = <T>(endpoint: string, options = {}) =>
    apiCall<T>(endpoint, { ...options, method: 'GET' })

  const post = <T>(endpoint: string, body?: any, options = {}) =>
    apiCall<T>(endpoint, { ...options, method: 'POST', body })

  const put = <T>(endpoint: string, body?: any, options = {}) =>
    apiCall<T>(endpoint, { ...options, method: 'PUT', body })

  const del = <T>(endpoint: string, options = {}) =>
    apiCall<T>(endpoint, { ...options, method: 'DELETE' })

  return {
    apiCall,
    get,
    post,
    put,
    delete: del
  }
}
