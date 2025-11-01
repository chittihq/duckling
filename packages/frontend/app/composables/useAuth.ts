export const useAuth = () => {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase

  const isAuthenticated = useState<boolean>('isAuthenticated', () => false)
  const username = useState<string | null>('username', () => null)
  const isLoading = useState<boolean>('authLoading', () => false)

  const checkAuth = async () => {
    try {
      isLoading.value = true
      const response = await $fetch<{ authenticated: boolean; username?: string }>(`${apiBase}/api/check-auth`, {
        credentials: 'include'
      })

      isAuthenticated.value = response.authenticated
      username.value = response.username || null

      return response.authenticated
    } catch (error) {
      isAuthenticated.value = false
      username.value = null
      return false
    } finally {
      isLoading.value = false
    }
  }

  const login = async (loginUsername: string, password: string) => {
    try {
      isLoading.value = true
      const response = await $fetch<{ success: boolean; message: string; username?: string }>(`${apiBase}/api/login`, {
        method: 'POST',
        body: { username: loginUsername, password },
        credentials: 'include'
      })

      if (response.success) {
        isAuthenticated.value = true
        username.value = response.username || loginUsername
        return { success: true, message: response.message }
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
      await $fetch(`${apiBase}/api/logout`, {
        method: 'POST',
        credentials: 'include'
      })
    } catch (error) {
      console.error('Logout error:', error)
    } finally {
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
    logout
  }
}
