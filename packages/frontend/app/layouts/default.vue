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

        <NuxtLink
          to="/observe"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/observe' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Observe
          </span>
        </NuxtLink>

        <NuxtLink
          to="/replication"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/replication' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 1l4 4-4 4"/>
            <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
            <path d="M7 23l-4-4 4-4"/>
            <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Replication
          </span>
        </NuxtLink>

        <NuxtLink
          to="/backups"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/backups' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
            <path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Backups
          </span>
        </NuxtLink>

        <NuxtLink
          to="/api-keys"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/api-keys' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="7.5" cy="15.5" r="5.5"/>
            <path d="m21 2-9.6 9.6"/>
            <path d="m15.5 7.5 3 3L22 7l-3-3"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            API Keys
          </span>
        </NuxtLink>

        <NuxtLink
          to="/settings"
          class="flex items-center justify-center h-12 hover:bg-accent transition-colors group relative"
          :class="{ 'bg-accent': $route.path === '/settings' }"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v6m0 6v6m5.7-13.7L14.6 8.4m-5.2 7.2-3.1 3.1M23 12h-6m-6 0H1m18.7 5.7-3.1-3.1M8.4 9.6l-3.1-3.1"/>
          </svg>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Settings
          </span>
        </NuxtLink>
      </nav>

      <!-- User -->
      <div class="border-t border-border p-2 relative profile-dropdown">
        <button
          @click="showProfileMenu = !showProfileMenu"
          class="w-full h-12 flex items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors group relative"
          :title="`Profile (${username})`"
        >
          <span class="text-xs font-semibold">{{ userInitials }}</span>
          <span class="absolute left-full ml-2 px-2 py-1 bg-popover text-popover-foreground text-sm rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            Profile
          </span>
        </button>

        <!-- Profile Dropdown Menu -->
        <div
          v-if="showProfileMenu"
          class="absolute bottom-full left-2 mb-2 w-48 bg-popover border border-border rounded-md shadow-lg z-50"
        >
          <div class="p-3 border-b border-border">
            <p class="text-sm font-medium">{{ username }}</p>
            <p class="text-xs text-muted-foreground">Logged in</p>
          </div>
          <div class="py-1">
            <button
              @click="handleLogout"
              class="w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Logout
            </button>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 overflow-hidden flex flex-col">
      <!-- Database Selector + Sync Status -->
      <div class="border-b bg-card px-4 py-2 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="text-sm text-muted-foreground">Database:</span>
          <Select :model-value="selectedDatabaseId" @update:model-value="setDatabase">
            <SelectTrigger class="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="db in databases" :key="db.id" :value="db.id">
                {{ db.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2 text-sm">
          <template v-if="statusType === 'syncing'">
            <svg class="animate-spin text-primary shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            <span class="w-64 truncate">
              Syncing {{ syncState.tablesProcessed }}/{{ syncState.totalTables }} tables<span v-if="syncState.currentTable"> &middot; {{ syncState.currentTable }}</span>
            </span>
          </template>
          <template v-else-if="statusType === 'error'">
            <button type="button" class="flex items-center gap-2 text-destructive" @click="showSyncError = !showSyncError">
              <span class="h-2 w-2 rounded-full bg-red-500" />
              <span>Sync failed</span>
            </button>
            <span v-if="showSyncError && syncState.lastError" class="text-xs text-muted-foreground max-w-md truncate" :title="syncState.lastError">
              {{ syncState.lastError }}
            </span>
          </template>
          <template v-else-if="statusType === 'scheduled'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-muted-foreground">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span class="text-muted-foreground">Next sync in {{ formatRelative(syncState.nextSync) }}</span>
          </template>
          <template v-else>
            <span class="h-2 w-2 rounded-full bg-green-500" />
            <span class="text-muted-foreground">Last sync: {{ formatRelative(syncState.lastSync) }}</span>
          </template>
        </div>
      </div>

      <!-- Page Content -->
      <div class="flex-1 overflow-hidden">
        <slot />
      </div>
    </main>

    <!-- Toast Notifications -->
    <Toaster />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const router = useRouter()
const { username, logout } = useAuth()
const { selectedDatabaseId, databases, setDatabase, loadDatabases } = useDatabase()
const { syncState, statusType, startPolling, stopPolling } = useSyncStatus()

const showProfileMenu = ref(false)
const showSyncError = ref(false)

const userInitials = computed(() => {
  if (!username.value) return 'U'
  return username.value.substring(0, 2).toUpperCase()
})

const handleLogout = async () => {
  showProfileMenu.value = false
  await logout()
  router.push('/login')
}

const formatRelative = (value: string | null) => {
  if (!value) return 'never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const target = date.getTime()
  const diffMs = target - Date.now()
  const absMinutes = Math.max(1, Math.round(Math.abs(diffMs) / 60000))
  if (diffMs >= 0) return `${absMinutes}m`
  return `${absMinutes}m ago`
}

// Close dropdown when clicking outside
const closeProfileMenu = (event: MouseEvent) => {
  const target = event.target as HTMLElement
  if (!target.closest('.profile-dropdown')) {
    showProfileMenu.value = false
  }
}

// Load databases on mount
onMounted(() => {
  loadDatabases()
  startPolling()

  // Add click outside listener
  if (process.client) {
    document.addEventListener('click', closeProfileMenu)
  }
})

onUnmounted(() => {
  stopPolling()
  if (process.client) {
    document.removeEventListener('click', closeProfileMenu)
  }
})
</script>
