<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { toast } from '@/components/ui/toast'

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const { get, post } = useApi()
const { getApiUrlWithDatabase, selectedDatabaseId } = useDatabase()

interface Table {
  name: string
  rowCount: number
  size: number
}

const loading = ref(false)
const loadingData = ref(false)
const tables = ref<Table[]>([])
const searchQuery = ref('')
const selectedTable = ref('')
const tableData = ref<any[]>([])
const tableColumns = ref<string[]>([])
const currentPage = ref(1)
const itemsPerPage = ref(50)
const syncingTable = ref<string | null>(null)
const showModal = ref(false)

const loadTables = async () => {
  loading.value = true
  try {
    const [tablesRes, countsRes] = await Promise.all([
      get<any[]>(getApiUrlWithDatabase('/api/tables')),
      get<Record<string, number>>(getApiUrlWithDatabase('/api/tables/counts/all'))
    ])

    tables.value = tablesRes
      .filter(table => table)
      .map(table => {
        if (typeof table === 'string') {
          return {
            name: table,
            rowCount: countsRes[table] || 0,
            size: 0
          }
        }
        return {
          name: table.name,
          rowCount: countsRes[table.name] || 0,
          size: table.size || 0
        }
      })
      .filter(table => table.name)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error: any) {
    console.error('Failed to load tables:', error)
    toast({
      title: 'Error',
      description: 'Failed to load tables: ' + error.message,
      variant: 'destructive'
    })
  } finally {
    loading.value = false
  }
}

const selectTable = async (tableName: string) => {
  selectedTable.value = tableName
  showModal.value = true
  await loadTableData(tableName)
}

const closeModal = () => {
  showModal.value = false
  selectedTable.value = ''
  tableData.value = []
  tableColumns.value = []
  currentPage.value = 1
}

const loadTableData = async (tableName: string) => {
  if (!tableName) return

  loadingData.value = true
  try {
    const response = await get<any[]>(getApiUrlWithDatabase(`/api/tables/${tableName}/data?limit=1000`))

    tableData.value = response

    if (tableData.value.length > 0) {
      tableColumns.value = Object.keys(tableData.value[0])
    } else {
      tableColumns.value = []
    }

    currentPage.value = 1
  } catch (error: any) {
    console.error('Failed to load table data:', error)
    toast({
      title: 'Error',
      description: 'Failed to load table data: ' + error.message,
      variant: 'destructive'
    })
    tableData.value = []
    tableColumns.value = []
  } finally {
    loadingData.value = false
  }
}

const refreshTableData = async () => {
  if (selectedTable.value) {
    await loadTableData(selectedTable.value)
  }
}

const syncTable = async (tableName: string) => {
  syncingTable.value = tableName
  try {
    const response = await post<{ recordsProcessed: number }>(getApiUrlWithDatabase(`/sync/table/${tableName}`))

    toast({
      title: 'Success',
      description: `Table "${tableName}" synced successfully: ${response.recordsProcessed || 0} records`
    })
    await loadTables()
    if (selectedTable.value === tableName) {
      await refreshTableData()
    }
  } catch (error: any) {
    toast({
      title: 'Error',
      description: `Failed to sync table "${tableName}": ${error.data?.error || error.message}`,
      variant: 'destructive'
    })
  } finally {
    syncingTable.value = null
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

const formatNumber = (num: number) => {
  if (!num) return '0'
  return num.toLocaleString()
}

const formatFileSize = (bytes: number) => {
  if (!bytes) return '0 B'
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`
}

const filteredTables = computed(() => {
  if (!searchQuery.value) {
    return tables.value
  }
  return tables.value.filter(table =>
    table.name.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
})

const paginatedData = computed(() => {
  const start = (currentPage.value - 1) * itemsPerPage.value
  const end = start + itemsPerPage.value
  return tableData.value.slice(start, end)
})

const totalPages = computed(() => {
  return Math.ceil(tableData.value.length / itemsPerPage.value)
})

onMounted(() => {
  loadTables()
})

// Watch for database changes and reload tables
watch(selectedDatabaseId, () => {
  loadTables()
  // Close modal if open
  showModal.value = false
  tableData.value = []
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="border-b bg-card px-6 py-4">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-2xl font-bold">Tables</h1>
          <p class="text-sm text-muted-foreground">View and manage synchronized database tables</p>
        </div>
        <Button
          @click="loadTables()"
          :disabled="loading"
          size="sm"
        >
          {{ loading ? 'Loading...' : 'Refresh Tables' }}
        </Button>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6">
      <div class="bg-card border rounded-lg">
        <div class="border-b px-4 py-3 flex justify-between items-center">
          <div>
            <h2 class="font-semibold">All Tables</h2>
            <p class="text-xs text-muted-foreground mt-1">
              <strong>{{ tables.length }}</strong> tables synchronized
            </p>
          </div>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search tables..."
            class="px-3 py-2 border border-input rounded-md w-64"
          />
        </div>
        <div class="overflow-auto">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50">
              <tr>
                <th class="px-4 py-3 text-left font-medium">Table Name</th>
                <th class="px-4 py-3 text-right font-medium">Records</th>
                <th class="px-4 py-3 text-right font-medium">Size</th>
                <th class="px-4 py-3 text-center font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="table in filteredTables"
                :key="table.name"
                class="border-b hover:bg-accent"
              >
                <td class="px-4 py-3">
                  <div class="font-medium">{{ table.name }}</div>
                </td>
                <td class="px-4 py-3 text-right">{{ formatNumber(table.rowCount) }}</td>
                <td class="px-4 py-3 text-right">{{ formatFileSize(table.size) }}</td>
                <td class="px-4 py-3">
                  <div class="flex items-center justify-center gap-2">
                    <Button
                      @click="selectTable(table.name)"
                      :disabled="loadingData"
                      size="sm"
                    >
                      View
                    </Button>
                    <Button
                      @click="syncTable(table.name)"
                      :disabled="syncingTable === table.name"
                      variant="outline"
                      size="sm"
                    >
                      {{ syncingTable === table.name ? 'Syncing...' : 'Sync' }}
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- Empty State -->
          <div v-if="!tables.length && !loading" class="text-center py-12 text-muted-foreground">
            <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 3h18v18H3V3z"/>
              <path d="M3 9h18M3 15h18M9 3v18"/>
            </svg>
            <h3 class="font-medium mb-2">No tables found</h3>
            <p class="text-sm">Click "Refresh Tables" to load your database tables</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Table Data Modal -->
    <Teleport to="body">
      <div
        v-if="showModal"
        @click.self="closeModal()"
        class="fixed inset-0 bg-black/95 backdrop-blur-sm flex items-center justify-center z-50 p-5"
      >
        <div @click.stop class="bg-card border rounded-lg w-full max-w-6xl max-h-[85vh] flex flex-col shadow-2xl">
          <!-- Modal Header -->
          <div class="border-b px-6 py-4 flex justify-between items-center">
            <div>
              <h2 class="text-xl font-bold">{{ selectedTable }}</h2>
              <p class="text-sm text-muted-foreground mt-1">
                <strong>{{ tableData.length }}</strong> rows loaded
              </p>
            </div>
            <div class="flex gap-2">
              <Button
                @click="refreshTableData()"
                :disabled="loadingData"
                variant="outline"
                size="sm"
              >
                {{ loadingData ? 'Loading...' : 'Refresh' }}
              </Button>
              <Button
                @click="closeModal()"
                variant="outline"
                size="sm"
              >
                Close
              </Button>
            </div>
          </div>

          <!-- Modal Body -->
          <div class="flex-1 overflow-auto p-6">
            <!-- Loading State -->
            <div v-if="loadingData" class="text-center py-12">
              <div class="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
              <p class="text-muted-foreground">Loading table data...</p>
            </div>

            <!-- Table Data -->
            <div v-else-if="tableData.length > 0">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="border-b bg-muted/50">
                    <tr>
                      <th v-for="column in tableColumns" :key="column" class="px-4 py-2 text-left font-medium">
                        {{ column }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, index) in paginatedData" :key="index" class="border-b hover:bg-accent">
                      <td v-for="column in tableColumns" :key="column" class="px-4 py-2">
                        <div class="max-w-xs overflow-hidden text-ellipsis" :title="formatCellValue(row[column])">
                          {{ formatCellValue(row[column]) }}
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Empty State -->
            <div v-else class="text-center py-12 text-muted-foreground">
              <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
              </svg>
              <h3 class="font-medium mb-2">No data in this table</h3>
              <p class="text-sm">This table exists but contains no records</p>
            </div>
          </div>

          <!-- Modal Footer with Pagination -->
          <div v-if="tableData.length > itemsPerPage" class="border-t px-6 py-4 flex justify-between items-center">
            <div class="text-sm text-muted-foreground">
              Showing <strong>{{ ((currentPage - 1) * itemsPerPage) + 1 }}</strong> to
              <strong>{{ Math.min(currentPage * itemsPerPage, tableData.length) }}</strong> of
              <strong>{{ tableData.length }}</strong>
            </div>
            <div class="flex gap-2">
              <Button
                @click="currentPage > 1 && currentPage--"
                :disabled="currentPage === 1"
                variant="outline"
                size="sm"
              >
                Previous
              </Button>
              <span class="px-3 py-1 bg-accent rounded-md text-sm">
                Page {{ currentPage }} of {{ totalPages }}
              </span>
              <Button
                @click="currentPage < totalPages && currentPage++"
                :disabled="currentPage === totalPages"
                variant="outline"
                size="sm"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
