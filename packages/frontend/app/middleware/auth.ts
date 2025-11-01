export default defineNuxtRouteMiddleware(async (to, from) => {
  // Skip auth check for login page
  if (to.path === '/login') {
    return
  }

  const { checkAuth } = useAuth()
  const authenticated = await checkAuth()

  if (!authenticated) {
    return navigateTo('/login')
  }
})
