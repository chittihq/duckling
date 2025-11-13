const TOKEN_KEY = 'duckling_jwt_token'

/**
 * Get JWT token from localStorage
 */
export const getAuthToken = (): string | null => {
  if (process.client) {
    return localStorage.getItem(TOKEN_KEY)
  }
  return null
}

/**
 * Set JWT token in localStorage
 */
export const setAuthToken = (token: string): void => {
  if (process.client) {
    localStorage.setItem(TOKEN_KEY, token)
  }
}

/**
 * Remove JWT token from localStorage
 */
export const removeAuthToken = (): void => {
  if (process.client) {
    localStorage.removeItem(TOKEN_KEY)
  }
}

/**
 * Get authorization headers with JWT token
 */
export const getAuthHeaders = (): Record<string, string> => {
  const token = getAuthToken()
  if (token) {
    return {
      'Authorization': `Bearer ${token}`
    }
  }
  return {}
}

export const useAuth = () => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase

  const isAuthenticated = useState<boolean>('isAuthenticated', () => false)
  const username = useState<string | null>('username', () => null)
  const isLoading = useState<boolean>('authLoading', () => false)

  const checkAuth = async () => {
    try {
      isLoading.value = true
      const token = getAuthToken()

      if (!token) {
        isAuthenticated.value = false
        username.value = null
        return false
      }

      const response = await $fetch<{ authenticated: boolean; username?: string; authMethod?: string }>(`${apiBase}/api/check-auth`, {
        headers: getAuthHeaders()
      })

      isAuthenticated.value = response.authenticated
      username.value = response.username || null

      return response.authenticated
    } catch (error) {
      isAuthenticated.value = false
      username.value = null
      removeAuthToken() // Remove invalid token
      return false
    } finally {
      isLoading.value = false
    }
  }

  const login = async (loginUsername: string, password: string) => {
    try {
      isLoading.value = true
      const response = await $fetch<{
        success: boolean;
        message: string;
        username?: string;
        token?: string;
        expiresIn?: string;
      }>(`${apiBase}/api/login`, {
        method: 'POST',
        body: { username: loginUsername, password }
      })

      if (response.success && response.token) {
        // Store JWT token
        setAuthToken(response.token)

        isAuthenticated.value = true
        username.value = response.username || loginUsername

        return {
          success: true,
          message: response.message,
          expiresIn: response.expiresIn
        }
      } else {
        return { success: false, message: response.message }
      }
    } catch (error: any) {
      return {
        success: false,
        message: error.data?.message || 'Login failed. Please try again.'
      }
    } finally {
      isLoading.value = false
    }
  }

  const logout = async () => {
    try {
      const token = getAuthToken()
      if (token) {
        await $fetch(`${apiBase}/api/logout`, {
          method: 'POST',
          headers: getAuthHeaders()
        })
      }
    } catch (error) {
      console.error('Logout error:', error)
    } finally {
      // Clear token and state
      removeAuthToken()
      isAuthenticated.value = false
      username.value = null
    }
  }

  return {
    isAuthenticated,
    username,
    isLoading,
    checkAuth,
    login,
    logout,
    getAuthToken,
    getAuthHeaders
  }
}
