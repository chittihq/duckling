<template>
  <div class="flex h-screen bg-background">
    <!-- Sidebar -->
    <aside class="w-16 bg-card border-r border-border flex flex-col">
      <!-- Logo -->
      <NuxtLink to="/" class="flex items-center justify-center h-16 border-b border-border hover:bg-accent transition-colors">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          <polyline points="7.5 4.21 12 6.81 16.5 4.21"/>
          <polyline points="7.5 19.79 7.5 14.6 3 12"/>
          <polyline points="21 12 16.5 14.6 16.5 19.79"/>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
          <line x1="12" y1="22.08" x2="12" y2="12"/>
        </svg>
      </NuxtLink>

      <!-- Navigation -->
      <nav class="flex-1 py-4">
        <NuxtLink
          to="/"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7"/>
            <rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Dashboard
          </span>
        </NuxtLink>

        <NuxtLink
          to="/tables"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/tables' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3h18v18H3V3z"/>
            <path d="M3 9h18M3 15h18M9 3v18"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Tables
          </span>
        </NuxtLink>

        <NuxtLink
          to="/logs"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/logs' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Logs
          </span>
        </NuxtLink>

        <NuxtLink
          to="/validate"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/validate' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Validate
          </span>
        </NuxtLink>
      </nav>

      <!-- User -->
      <div class="border-t border-border p-2">
        <button
          @click="handleLogout"
          class="w-full h-12 flex items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors group relative"
          :title="`Logout (${username})`"
        >
          <span class="text-xs font-semibold">{{ userInitials }}</span>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Logout
          </span>
        </button>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-hidden">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
const router = useRouter()
const { username, logout } = useAuth()

const userInitials = computed(() => {
  if (!username.value) return 'U'
  return username.value.substring(0, 2).toUpperCase()
})

const handleLogout = async () => {
  await logout()
  router.push('/login')
}
</script>
