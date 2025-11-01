<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const config = useRuntimeConfig()
const apiBase = config.public.apiBase

interface HealthData {
  status: string
  services?: {
    mysql: string
    duckdb: string
  }
}

interface StatusData {
  uptime: number
  memory?: { rss: number }
  tables?: {
    mysql: number
    duckdb: number
    synced?: number
  }
}

const health = ref<HealthData>({ status: 'unknown' })
const status = ref<StatusData>({ uptime: 0 })
const operating = ref<string | false>(false)

// Query Editor State
const sqlQuery = ref('')
const queryResults = ref<any[]>([])
const queryResultColumns = ref<string[]>([])
const queryError = ref('')
const queryExecuting = ref(false)
const queryExecutionTime = ref<number | null>(null)
const selectedDatabase = ref<'duckdb' | 'mysql'>('duckdb')
const selectedExample = ref('')
const queryCurrentPage = ref(1)
const queryItemsPerPage = ref(100)

const refreshData = async () => {
  try {
    const [healthRes, statusRes] = await Promise.all([
      $fetch<HealthData>(`${apiBase}/health`, { credentials: 'include' }),
      $fetch<StatusData>(`${apiBase}/status`, { credentials: 'include' })
    ])
    health.value = healthRes
    status.value = statusRes
  } catch (error) {
    console.error('Failed to refresh data:', error)
  }
}

const executeQuery = async () => {
  if (!sqlQuery.value.trim()) return

  queryExecuting.value = true
  queryError.value = ''
  queryResults.value = []
  queryResultColumns.value = []
  queryExecutionTime.value = null

  const startTime = Date.now()

  try {
    const response = await $fetch<{ result: any[] }>(`${apiBase}/query`, {
      method: 'POST',
      body: { sql: sqlQuery.value.trim(), database: selectedDatabase.value },
      credentials: 'include'
    })

    queryExecutionTime.value = Date.now() - startTime
    queryResults.value = response.result || []

    if (queryResults.value.length > 0) {
      queryResultColumns.value = Object.keys(queryResults.value[0])
    }

    queryCurrentPage.value = 1
  } catch (err: any) {
    queryError.value = err.data?.error || err.message || 'Query execution failed'
  } finally {
    queryExecuting.value = false
  }
}

const clearQuery = () => {
  sqlQuery.value = ''
  queryResults.value = []
  queryResultColumns.value = []
  queryError.value = ''
  queryExecutionTime.value = null
}

const loadExampleQuery = () => {
  const examples: Record<string, string> = {
    list_tables: "SHOW TABLES;",
    table_count: "SELECT COUNT(*) as totalRecords FROM Action;",
    recent_data: `SELECT *
FROM Action
WHERE createdAt >= CURRENT_DATE - INTERVAL 7 DAY
ORDER BY createdAt DESC
LIMIT 100;`,
    aggregation: `SELECT
  DATE_TRUNC('day', createdAt) as day,
  COUNT(*) as actionCount,
  COUNT(DISTINCT adminId) as uniqueUsers
FROM Action
WHERE createdAt >= CURRENT_DATE - INTERVAL 30 DAY
GROUP BY day
ORDER BY day DESC;`,
    join: `SELECT
  o.adminId AS userId,
  o.createdAt,
  u.name AS userName
FROM Action AS o
LEFT JOIN "User" AS u
  ON o.adminId = u.userId
LIMIT 100;`
  }

  if (selectedExample.value && examples[selectedExample.value]) {
    sqlQuery.value = examples[selectedExample.value]
    selectedExample.value = ''
  }
}

const runFullSync = async () => {
  operating.value = 'full-sync'
  try {
    const response = await $fetch<{ totalRecords: number }>(`${apiBase}/sync/full`, {
      method: 'POST',
      credentials: 'include'
    })
    alert(`Full sync completed: ${response.totalRecords} records`)
  } catch (err: any) {
    alert('Full sync failed: ' + (err.data?.error || err.message))
  } finally {
    operating.value = false
    await refreshData()
  }
}

const runIncrementalSync = async () => {
  operating.value = 'incremental-sync'
  try {
    const response = await $fetch<{ totalRecords: number }>(`${apiBase}/sync/incremental`, {
      method: 'POST',
      credentials: 'include'
    })
    alert(`Incremental sync completed: ${response.totalRecords} records`)
  } catch (err: any) {
    alert('Incremental sync failed: ' + (err.data?.error || err.message))
  } finally {
    operating.value = false
    await refreshData()
  }
}

const validateSync = async () => {
  operating.value = 'validate'
  try {
    const response = await $fetch<any[]>(`${apiBase}/sync/validate`, { credentials: 'include' })
    const mismatches = response.filter(r => !r.match)
    alert(mismatches.length === 0 ? 'All tables are in sync!' : `Found ${mismatches.length} mismatches`)
  } catch (err: any) {
    alert('Validation failed: ' + (err.data?.error || err.message))
  } finally {
    operating.value = false
  }
}

const clearAllData = async () => {
  if (!confirm('WARNING: This will delete ALL DuckDB data and tables. This action cannot be undone. Continue?')) {
    return
  }

  operating.value = 'clear-all'
  try {
    await $fetch(`${apiBase}/storage/clear-all`, { method: 'DELETE', credentials: 'include' })
    alert('All data cleared successfully')
  } catch (err: any) {
    alert('Clear all data failed: ' + (err.data?.error || err.message))
  } finally {
    operating.value = false
    await refreshData()
  }
}

const formatCellValue = (value: any) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'string' && value.length > 100) {
    return value.substring(0, 100) + '...'
  }
  return value
}

const formatMemory = (bytes?: number) => {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

const formatUptime = (seconds: number) => {
  if (!seconds) return '0s'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  } else if (minutes > 0) {
    return `${minutes}m`
  } else {
    return `${Math.floor(seconds)}s`
  }
}

const paginatedQueryResults = computed(() => {
  const start = (queryCurrentPage.value - 1) * queryItemsPerPage.value
  const end = start + queryItemsPerPage.value
  return queryResults.value.slice(start, end)
})

const queryTotalPages = computed(() => {
  return Math.ceil(queryResults.value.length / queryItemsPerPage.value)
})

onMounted(() => {
  refreshData()
  // Auto-refresh every 30 seconds
  setInterval(() => {
    if (!operating.value) {
      refreshData()
    }
  }, 30000)
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="border-b bg-card px-6 py-4">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-2xl font-bold">Dashboard</h1>
          <p class="text-sm text-muted-foreground">Execute SQL queries and manage operations</p>
        </div>
        <div class="flex gap-2">
          <button
            @click="runFullSync()"
            :disabled="!!operating"
            class="px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {{ operating === 'full-sync' ? 'Syncing...' : 'Full Sync' }}
          </button>
          <button
            @click="runIncrementalSync()"
            :disabled="!!operating"
            class="px-3 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            {{ operating === 'incremental-sync' ? 'Syncing...' : 'Incremental Sync' }}
          </button>
          <button
            @click="validateSync()"
            :disabled="!!operating"
            class="px-3 py-2 text-sm border border-border rounded-md hover:bg-accent disabled:opacity-50"
          >
            {{ operating === 'validate' ? 'Validating...' : 'Validate' }}
          </button>
          <button
            @click="clearAllData()"
            :disabled="!!operating"
            class="px-3 py-2 text-sm bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
          >
            {{ operating === 'clear-all' ? 'Clearing...' : 'Clear All Data' }}
          </button>
        </div>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6 space-y-4">
      <!-- Query Editor Section -->
      <div class="bg-card border rounded-lg">
        <div class="border-b px-4 py-3 flex justify-between items-center">
          <h2 class="font-semibold">SQL Query Editor</h2>
          <div class="flex gap-2">
            <select
              v-model="selectedDatabase"
              class="px-3 py-1 border border-input rounded-md text-sm"
              :class="selectedDatabase === 'mysql' ? 'text-orange-600' : 'text-blue-600'"
            >
              <option value="duckdb">DuckDB (Fast)</option>
              <option value="mysql">MySQL (Source)</option>
            </select>
            <select
              v-model="selectedExample"
              @change="loadExampleQuery()"
              class="px-3 py-1 border border-input rounded-md text-sm"
            >
              <option value="">Example Queries...</option>
              <option value="list_tables">List All Tables</option>
              <option value="table_count">Count Records</option>
              <option value="recent_data">Recent Records (7 days)</option>
              <option value="aggregation">Daily Aggregation (30 days)</option>
              <option value="join">Action with User Join</option>
            </select>
          </div>
        </div>
        <div class="p-4">
          <div class="flex gap-2">
            <textarea
              v-model="sqlQuery"
              class="flex-1 h-20 px-3 py-2 border border-input rounded-md font-mono text-sm resize-none"
              placeholder="Enter your SQL query here...

Example:
SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 100;"
              @keydown.ctrl.enter="executeQuery()"
            ></textarea>
            <div class="flex flex-col gap-2">
              <button
                @click="executeQuery()"
                :disabled="!sqlQuery.trim() || queryExecuting"
                class="w-10 h-10 flex items-center justify-center bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                title="Execute Query (Ctrl+Enter)"
              >
                <svg v-if="!queryExecuting" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <svg v-else class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              </button>
              <button
                @click="clearQuery()"
                :disabled="!sqlQuery.trim()"
                class="w-10 h-10 flex items-center justify-center border border-border rounded-md hover:bg-accent disabled:opacity-50"
                title="Clear Query"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </div>
          <div v-if="queryExecutionTime" class="mt-2 text-sm text-muted-foreground">
            <strong>{{ queryResults.length }}</strong> rows in <strong>{{ queryExecutionTime }}</strong>ms
          </div>
        </div>
      </div>

      <!-- Query Results Section -->
      <div class="bg-card border rounded-lg flex flex-col" style="max-height: 50vh;">
        <div class="border-b px-4 py-3 flex justify-between items-center">
          <h2 class="font-semibold">Query Results</h2>
          <span v-if="queryResults.length > 0" class="text-sm text-muted-foreground">
            Showing <strong>{{ queryResults.length }}</strong> rows
          </span>
        </div>
        <div class="flex-1 overflow-auto">
          <!-- Error Display -->
          <div v-if="queryError" class="m-4 p-4 bg-destructive/10 border border-destructive text-destructive rounded-md">
            {{ queryError }}
          </div>

          <!-- Results Table -->
          <div v-else-if="queryResults.length > 0" class="p-4">
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="border-b">
                  <tr>
                    <th v-for="column in queryResultColumns" :key="column" class="px-4 py-2 text-left font-medium">
                      {{ column }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in paginatedQueryResults" :key="index" class="border-b hover:bg-accent">
                    <td v-for="column in queryResultColumns" :key="column" class="px-4 py-2">
                      <div class="max-w-xs overflow-hidden text-ellipsis" :title="formatCellValue(row[column])">
                        {{ formatCellValue(row[column]) }}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Pagination -->
            <div v-if="queryResults.length > queryItemsPerPage" class="flex items-center justify-between mt-4">
              <div class="text-sm text-muted-foreground">
                Showing <strong>{{ ((queryCurrentPage - 1) * queryItemsPerPage) + 1 }}</strong> to
                <strong>{{ Math.min(queryCurrentPage * queryItemsPerPage, queryResults.length) }}</strong> of
                <strong>{{ queryResults.length }}</strong>
              </div>
              <div class="flex gap-2">
                <button
                  @click="queryCurrentPage > 1 && queryCurrentPage--"
                  :disabled="queryCurrentPage === 1"
                  class="px-3 py-1 border border-border rounded-md hover:bg-accent disabled:opacity-50"
                >
                  Previous
                </button>
                <span class="px-3 py-1 bg-accent rounded-md">
                  Page {{ queryCurrentPage }} of {{ queryTotalPages }}
                </span>
                <button
                  @click="queryCurrentPage < queryTotalPages && queryCurrentPage++"
                  :disabled="queryCurrentPage === queryTotalPages"
                  class="px-3 py-1 border border-border rounded-md hover:bg-accent disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else-if="!queryExecuting" class="text-center py-12 text-muted-foreground">
            <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <h3 class="font-medium mb-2">No query results</h3>
            <p class="text-sm">Execute a SQL query to see results here</p>
          </div>
        </div>
      </div>

      <!-- System Stats -->
      <div class="grid grid-cols-3 gap-4">
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">System Health</div>
          <div class="flex items-center justify-between mt-2">
            <div class="text-xl font-bold">{{ health.status === 'healthy' ? 'Healthy' : 'Degraded' }}</div>
            <div class="w-3 h-3 rounded-full" :class="health.status === 'healthy' ? 'bg-green-500' : 'bg-gray-400'"></div>
          </div>
          <div class="text-xs text-muted-foreground mt-2">
            MySQL: {{ health.services?.mysql || 'unknown' }} • DuckDB: {{ health.services?.duckdb || 'unknown' }}
          </div>
        </div>

        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Sync Status</div>
          <div class="text-xl font-bold mt-2">
            {{ status.tables?.synced || 0 }} / <span class="text-muted-foreground">{{ status.tables?.mysql || 0 }}</span>
          </div>
          <div class="text-xs text-muted-foreground mt-2">Tables Synchronized</div>
        </div>

        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Memory Usage</div>
          <div class="text-xl font-bold mt-2">{{ formatMemory(status.memory?.rss) }}</div>
          <div class="text-xs text-muted-foreground mt-2">Uptime: {{ formatUptime(status.uptime) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
