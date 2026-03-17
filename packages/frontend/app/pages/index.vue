<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { toast } from '@/components/ui/toast'

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const { get, post, delete: del } = useApi()
const { getApiUrlWithDatabase, selectedDatabaseId } = useDatabase()

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
      get<HealthData>(getApiUrlWithDatabase('/health')),
      get<StatusData>(getApiUrlWithDatabase('/status'))
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
    const response = await post<{ result: any[] }>(
      getApiUrlWithDatabase('/api/query'),
      { sql: sqlQuery.value.trim(), database: selectedDatabase.value }
    )

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
    const response = await post<{ totalRecords: number }>(
      getApiUrlWithDatabase('/sync/full')
    )
    toast({
      title: 'Success',
      description: `Full sync completed: ${response.totalRecords} records`
    })
  } catch (err: any) {
    toast({
      title: 'Error',
      description: 'Full sync failed: ' + (err.data?.error || err.message),
      variant: 'destructive'
    })
  } finally {
    operating.value = false
    await refreshData()
  }
}

const runIncrementalSync = async () => {
  operating.value = 'incremental-sync'
  try {
    const response = await post<{ totalRecords: number }>(
      getApiUrlWithDatabase('/sync/incremental')
    )
    toast({
      title: 'Success',
      description: `Incremental sync completed: ${response.totalRecords} records`
    })
  } catch (err: any) {
    toast({
      title: 'Error',
      description: 'Incremental sync failed: ' + (err.data?.error || err.message),
      variant: 'destructive'
    })
  } finally {
    operating.value = false
    await refreshData()
  }
}

const validateSync = async () => {
  operating.value = 'validate'
  try {
    const response = await get<any[]>(getApiUrlWithDatabase('/sync/validate'))
    const mismatches = response.filter(r => !r.match)
    toast({
      title: mismatches.length === 0 ? 'Success' : 'Warning',
      description: mismatches.length === 0 ? 'All tables are in sync!' : `Found ${mismatches.length} mismatches`,
      variant: mismatches.length === 0 ? undefined : 'destructive'
    })
  } catch (err: any) {
    toast({
      title: 'Error',
      description: 'Validation failed: ' + (err.data?.error || err.message),
      variant: 'destructive'
    })
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
    await del(getApiUrlWithDatabase('/sync/clear-all'))
    toast({
      title: 'Success',
      description: 'All data cleared successfully'
    })
  } catch (err: any) {
    toast({
      title: 'Error',
      description: 'Clear all data failed: ' + (err.data?.error || err.message),
      variant: 'destructive'
    })
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
  setInterval(() => {
    if (!operating.value) {
      refreshData()
    }
  }, 30000)
})

// Watch for database changes and reload data
watch(selectedDatabaseId, () => {
  refreshData()
  // Clear query results when switching databases
  queryResults.value = []
  queryResultColumns.value = []
  queryError.value = ''
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
          <Button @click="runFullSync()" :disabled="!!operating" size="sm">
            {{ operating === 'full-sync' ? 'Syncing...' : 'Full Sync' }}
          </Button>
          <Button @click="runIncrementalSync()" :disabled="!!operating" class="bg-green-600 hover:bg-green-700" size="sm">
            {{ operating === 'incremental-sync' ? 'Syncing...' : 'Incremental Sync' }}
          </Button>
          <Button @click="validateSync()" :disabled="!!operating" variant="outline" size="sm">
            {{ operating === 'validate' ? 'Validating...' : 'Validate' }}
          </Button>
          <Button @click="clearAllData()" :disabled="!!operating" variant="destructive" size="sm">
            {{ operating === 'clear-all' ? 'Clearing...' : 'Clear All Data' }}
          </Button>
        </div>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6 space-y-4">
      <!-- Query Editor Section -->
      <Card>
        <CardHeader>
          <div class="flex justify-between items-center">
            <CardTitle>SQL Query Editor</CardTitle>
            <div class="flex gap-2">
              <Select v-model="selectedDatabase">
                <SelectTrigger class="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="duckdb">DuckDB (Fast)</SelectItem>
                  <SelectItem value="mysql">MySQL (Source)</SelectItem>
                </SelectContent>
              </Select>
              <Select v-model="selectedExample" @update:modelValue="loadExampleQuery()">
                <SelectTrigger class="w-56">
                  <SelectValue placeholder="Example Queries..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="list_tables">List All Tables</SelectItem>
                  <SelectItem value="table_count">Count Records</SelectItem>
                  <SelectItem value="recent_data">Recent Records (7 days)</SelectItem>
                  <SelectItem value="aggregation">Daily Aggregation (30 days)</SelectItem>
                  <SelectItem value="join">Action with User Join</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div class="flex gap-2">
            <textarea
              v-model="sqlQuery"
              class="flex-1 h-20 px-3 py-2 border border-input rounded-md font-mono text-sm resize-none bg-background"
              placeholder="Enter your SQL query here...

Example:
SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 100;"
              @keydown.ctrl.enter="executeQuery()"
            ></textarea>
            <div class="flex flex-col gap-2">
              <Button
                @click="executeQuery()"
                :disabled="!sqlQuery.trim() || queryExecuting"
                size="icon"
                title="Execute Query (Ctrl+Enter)"
              >
                <svg v-if="!queryExecuting" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <svg v-else class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              </Button>
              <Button
                @click="clearQuery()"
                :disabled="!sqlQuery.trim()"
                variant="outline"
                size="icon"
                title="Clear Query"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </Button>
            </div>
          </div>
          <div v-if="queryExecutionTime" class="mt-2 text-sm text-muted-foreground">
            <strong>{{ queryResults.length }}</strong> rows in <strong>{{ queryExecutionTime }}</strong>ms
          </div>
        </CardContent>
      </Card>

      <!-- Query Results Section -->
      <Card class="flex flex-col" style="max-height: 50vh;">
        <CardHeader>
          <div class="flex justify-between items-center">
            <CardTitle>Query Results</CardTitle>
            <span v-if="queryResults.length > 0" class="text-sm text-muted-foreground">
              Showing <strong>{{ queryResults.length }}</strong> rows
            </span>
          </div>
        </CardHeader>
        <CardContent class="flex-1 overflow-auto p-0">
          <!-- Error Display -->
          <div v-if="queryError" class="m-4 p-4 bg-destructive/10 border border-destructive text-destructive rounded-md">
            {{ queryError }}
          </div>

          <!-- Results Table -->
          <div v-else-if="queryResults.length > 0" class="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead v-for="column in queryResultColumns" :key="column">
                    {{ column }}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(row, index) in paginatedQueryResults" :key="index">
                  <TableCell v-for="column in queryResultColumns" :key="column">
                    <div class="max-w-xs overflow-hidden text-ellipsis" :title="formatCellValue(row[column])">
                      {{ formatCellValue(row[column]) }}
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <!-- Pagination -->
            <div v-if="queryResults.length > queryItemsPerPage" class="flex items-center justify-between mt-4">
              <div class="text-sm text-muted-foreground">
                Showing <strong>{{ ((queryCurrentPage - 1) * queryItemsPerPage) + 1 }}</strong> to
                <strong>{{ Math.min(queryCurrentPage * queryItemsPerPage, queryResults.length) }}</strong> of
                <strong>{{ queryResults.length }}</strong>
              </div>
              <div class="flex gap-2">
                <Button
                  @click="queryCurrentPage > 1 && queryCurrentPage--"
                  :disabled="queryCurrentPage === 1"
                  variant="outline"
                  size="sm"
                >
                  Previous
                </Button>
                <Badge variant="secondary">
                  Page {{ queryCurrentPage }} of {{ queryTotalPages }}
                </Badge>
                <Button
                  @click="queryCurrentPage < queryTotalPages && queryCurrentPage++"
                  :disabled="queryCurrentPage === queryTotalPages"
                  variant="outline"
                  size="sm"
                >
                  Next
                </Button>
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
        </CardContent>
      </Card>

      <!-- System Stats -->
      <div class="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader class="pb-2">
            <CardDescription>System Health</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="flex items-center justify-between">
              <div class="text-2xl font-bold">{{ health.status === 'healthy' ? 'Healthy' : 'Degraded' }}</div>
              <div class="w-3 h-3 rounded-full" :class="health.status === 'healthy' ? 'bg-green-500' : 'bg-gray-400'"></div>
            </div>
            <p class="text-xs text-muted-foreground mt-2">
              MySQL: {{ health.services?.mysql || 'unknown' }} • DuckDB: {{ health.services?.duckdb || 'unknown' }}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="pb-2">
            <CardDescription>Sync Status</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="text-2xl font-bold">
              {{ status.tables?.synced || 0 }} / <span class="text-muted-foreground">{{ status.tables?.mysql || 0 }}</span>
            </div>
            <p class="text-xs text-muted-foreground mt-2">Tables Synchronized</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="pb-2">
            <CardDescription>Memory Usage</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="text-2xl font-bold">{{ formatMemory(status.memory?.rss) }}</div>
            <p class="text-xs text-muted-foreground mt-2">Uptime: {{ formatUptime(status.uptime) }}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
