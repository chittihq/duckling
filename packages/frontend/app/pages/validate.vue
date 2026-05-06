<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { toast } from '@/components/ui/toast'

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const { get, post, delete: del } = useApi()
const { getApiUrlWithDatabase, selectedDatabaseId } = useDatabase()

interface TableValidation {
  name: string
  loading: boolean
  syncing: boolean
  deleting: boolean
  countingMySQL: boolean // Loading state for MySQL count
  primaryKey: string | null
  duckdb: { exists: boolean; columnCount: number; recordCount: number; maxId: string | null; checksum: string | null }
  mysql: { exists: boolean; columnCount: number; recordCount: number | null; maxId: string | null; checksum: string | null } // null = not counted yet
  status: 'pending' | 'loading' | 'match' | 'mismatch' | 'missing' | 'error' | 'uncounted'
  columnsMatch?: boolean
  errorType?: string
  errorMessage?: string
  missingColumns?: string[]
  extraColumns?: string[]
  mysqlCountSkipped?: boolean
}

const tables = ref<TableValidation[]>([])
const validating = ref(false)
const initialLoading = ref(false)
const bulkDeleting = ref(false)
const countingAllMySQL = ref(false) // Loading state for "Count All MySQL" button
const searchQuery = ref('')
const errorTypeFilter = ref('all')
const showMismatchesOnly = ref(false)

const loadTables = async () => {
  initialLoading.value = true

  try {
    const [duckdbTablesRes, mysqlTablesRes] = await Promise.all([
      get<any[]>(getApiUrlWithDatabase('/api/tables')),
      get<string[]>(getApiUrlWithDatabase('/api/validation/mysql-tables'))
    ])

    const duckdbTables = duckdbTablesRes.map(t => t.name || t).filter((name: string) => !name.startsWith('temp_'))
    const mysqlTables = mysqlTablesRes.filter(name => !name.startsWith('temp_'))

    const allTableNames = new Set([...duckdbTables, ...mysqlTables])

    tables.value = Array.from(allTableNames)
      .map(name => ({
        name,
        loading: false,
        syncing: false,
        deleting: false,
        countingMySQL: false,
        primaryKey: null,
        duckdb: { exists: false, columnCount: 0, recordCount: 0, maxId: null, checksum: null },
        mysql: { exists: false, columnCount: 0, recordCount: null, maxId: null, checksum: null }, // null = not counted
        status: 'pending' as const
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (error: any) {
    console.error('Failed to load tables:', error)
    toast({
      title: 'Error',
      description: 'Failed to load tables: ' + error.message,
      variant: 'destructive'
    })
  } finally {
    initialLoading.value = false
  }
}

const startValidation = async () => {
  if (tables.value.length === 0) {
    await loadTables()
  }

  validating.value = true

  try {
    tables.value.forEach(table => {
      table.loading = true
      table.status = 'loading'
    })

    const batchSize = 10
    for (let i = 0; i < tables.value.length; i += batchSize) {
      const batch = tables.value.slice(i, i + batchSize)
      await Promise.all(batch.map(table => loadTableDetails(table)))
    }
  } catch (error: any) {
    console.error('Validation failed:', error)
    toast({
      title: 'Error',
      description: 'Validation failed: ' + error.message,
      variant: 'destructive'
    })
  } finally {
    validating.value = false
  }
}

const loadTableDetails = async (table: TableValidation, skipMySQLCount: boolean = true) => {
  try {
    const response = await post<any>(
      getApiUrlWithDatabase('/api/validation/table-details'),
      { tableName: table.name, skipMySQLCount }
    )

    table.primaryKey = response.primaryKey || null
    table.duckdb = response.duckdb
    table.mysql = response.mysql
    table.columnsMatch = response.columnsMatch
    table.errorType = response.errorType
    table.errorMessage = response.errorMessage
    table.missingColumns = response.missingColumns || []
    table.extraColumns = response.extraColumns || []
    table.mysqlCountSkipped = response.mysqlCountSkipped
    table.loading = false

    if (!response.duckdb.exists || !response.mysql.exists) {
      table.status = 'missing'
    } else if (response.errorType === 'schema_mismatch' || response.errorType === 'max_id_mismatch' || response.errorType === 'checksum_mismatch') {
      table.status = 'mismatch'
    } else if (response.mysqlCountSkipped) {
      // MySQL count was skipped - can't determine match status yet
      table.status = response.columnsMatch ? 'uncounted' : 'mismatch'
    } else if (
      response.duckdb.recordCount === response.mysql.recordCount &&
      response.columnsMatch
    ) {
      table.status = 'match'
    } else {
      table.status = 'mismatch'
    }
  } catch (error: any) {
    console.error(`Failed to load details for ${table.name}:`, error)
    table.loading = false
    table.status = 'error'
  }
}

const syncTable = async (table: TableValidation) => {
  table.syncing = true

  try {
    const response = await post<any>(getApiUrlWithDatabase(`/sync/table/${table.name}`))

    table.syncing = false
    await revalidateTable(table)
    toast({
      title: 'Success',
      description: `Table "${table.name}" synced successfully`
    })
  } catch (error: any) {
    table.syncing = false
    toast({
      title: 'Error',
      description: `Failed to sync table "${table.name}": ${error.data?.error || error.message}`,
      variant: 'destructive'
    })
  }
}

const revalidateTable = async (table: TableValidation) => {
  table.loading = true
  table.status = 'loading'
  await loadTableDetails(table, true) // Skip MySQL count by default
}

// Count MySQL records for all tables (slow operation)
const countAllMySQLRecords = async () => {
  const tablesToCount = tables.value.filter(t => t.mysql.exists && t.mysql.recordCount === null)

  if (tablesToCount.length === 0) {
    toast({
      title: 'Info',
      description: 'All MySQL tables have already been counted'
    })
    return
  }

  countingAllMySQL.value = true

  try {
    tablesToCount.forEach(table => {
      table.countingMySQL = true
    })

    // Count tables sequentially to avoid overwhelming MySQL
    for (const table of tablesToCount) {
      await countMySQLRecordsForTable(table)
    }

    toast({
      title: 'Success',
      description: `Counted ${tablesToCount.length} MySQL tables`
    })
  } catch (error: any) {
    console.error('Failed to count MySQL records:', error)
    toast({
      title: 'Error',
      description: 'Failed to count MySQL records: ' + error.message,
      variant: 'destructive'
    })
  } finally {
    countingAllMySQL.value = false
  }
}

// Count MySQL records for a single table
const countMySQLRecordsForTable = async (table: TableValidation) => {
  table.countingMySQL = true

  try {
    const response = await post<any>(
      getApiUrlWithDatabase('/api/validation/table-details'),
      { tableName: table.name, skipMySQLCount: false }
    )

    table.mysql.recordCount = response.mysql.recordCount
    table.mysqlCountSkipped = false
    table.countingMySQL = false

    // Update status now that we have MySQL count
    if (!response.duckdb.exists || !response.mysql.exists) {
      table.status = 'missing'
    } else if (
      table.duckdb.recordCount === response.mysql.recordCount &&
      table.columnsMatch
    ) {
      table.status = 'match'
      table.errorType = undefined
      table.errorMessage = undefined
    } else if (table.duckdb.recordCount !== response.mysql.recordCount) {
      table.status = 'mismatch'
      table.errorType = 'record_count_mismatch'
      table.errorMessage = `Record count mismatch: ClickHouse (${table.duckdb.recordCount}) vs MySQL (${response.mysql.recordCount})`
    }
  } catch (error: any) {
    console.error(`Failed to count MySQL records for ${table.name}:`, error)
    table.countingMySQL = false
  }
}

const deleteTable = async (table: TableValidation) => {
  const confirmMessage = `Are you sure you want to delete table "${table.name}" from ClickHouse?\n\nThis will:\n• Delete the table and all its data\n• Clear the watermark\n• Force a fresh sync on next sync operation\n\nThis is useful when MySQL schema has changed.`

  if (!confirm(confirmMessage)) {
    return
  }

  table.deleting = true

  try {
    const response = await del<{ success: boolean; message: string }>(
      getApiUrlWithDatabase(`/api/validation/table/${table.name}`)
    )

    if (response.success) {
      table.deleting = false
      table.duckdb = { exists: false, columnCount: 0, recordCount: 0, maxId: null, checksum: null }
      table.status = 'missing'
      toast({
        title: 'Success',
        description: `Table "${table.name}" deleted successfully.\n\n${response.message}`
      })
    }
  } catch (error: any) {
    table.deleting = false
    toast({
      title: 'Error',
      description: `Failed to delete table "${table.name}": ${error.data?.error || error.message}`,
      variant: 'destructive'
    })
  }
}

const resetValidation = () => {
  tables.value = []
  validating.value = false
  searchQuery.value = ''
  showMismatchesOnly.value = false
}

const bulkDeleteFiltered = async () => {
  const tablesToDelete = filteredTables.value.filter(t => t.duckdb.exists)

  if (tablesToDelete.length === 0) {
    toast({
      title: 'Info',
      description: 'No tables to delete'
    })
    return
  }

  const confirmMessage = `Are you sure you want to delete ${tablesToDelete.length} tables from ClickHouse?\n\nThis will:\n• Delete all selected tables and their data\n• Clear their watermarks\n• Force fresh sync on next sync operation\n\nTables to delete:\n${tablesToDelete.map(t => `  • ${t.name}`).slice(0, 10).join('\n')}${tablesToDelete.length > 10 ? `\n  ... and ${tablesToDelete.length - 10} more` : ''}`

  if (!confirm(confirmMessage)) {
    return
  }

  bulkDeleting.value = true
  let deleted = 0
  let failed = 0

  const batchSize = 10
  for (let i = 0; i < tablesToDelete.length; i += batchSize) {
    const batch = tablesToDelete.slice(i, i + batchSize)

    const results = await Promise.allSettled(
      batch.map(async table => {
        const response = await del<{ success: boolean }>(
          getApiUrlWithDatabase(`/api/validation/table/${table.name}`)
        )
        return { table, response }
      })
    )

    for (const promiseResult of results) {
      if (promiseResult.status === 'fulfilled') {
        const { table, response } = promiseResult.value
        if (response.success) {
          table.duckdb = { exists: false, columnCount: 0, recordCount: 0, maxId: null, checksum: null }
          table.status = 'missing'
          table.errorType = 'missing_in_duckdb'
          table.errorMessage = 'Table exists in MySQL but not in ClickHouse'
          deleted++
        } else {
          failed++
        }
      } else {
        failed++
      }
    }
  }

  bulkDeleting.value = false
  toast({
    title: 'Bulk Delete Completed',
    description: `Deleted: ${deleted}\nFailed: ${failed}\n\nNext sync will recreate these tables with current MySQL schemas.`
  })
}

const formatNumber = (num: number) => {
  if (num === null || num === undefined) return '-'
  return num.toLocaleString()
}

const formatErrorType = (errorType: string) => {
  const errorTypes: Record<string, string> = {
    schema_mismatch: 'Schema Mismatch',
    max_id_mismatch: 'Max ID Mismatch',
    checksum_mismatch: 'Checksum Mismatch',
    record_count_mismatch: 'Record Count Mismatch',
    missing_in_duckdb: 'Missing in ClickHouse',
    orphaned_in_duckdb: 'Orphaned in ClickHouse'
  }
  return errorTypes[errorType] || errorType
}

const filteredTables = computed(() => {
  let filtered = tables.value

  if (searchQuery.value) {
    filtered = filtered.filter(table =>
      table.name.toLowerCase().includes(searchQuery.value.toLowerCase())
    )
  }

  if (errorTypeFilter.value && errorTypeFilter.value !== 'all') {
    filtered = filtered.filter(table => table.errorType === errorTypeFilter.value)
  }

  if (showMismatchesOnly.value) {
    filtered = filtered.filter(
      table => table.status === 'mismatch' || table.status === 'missing'
    )
  }

  return filtered
})

const summary = computed(() => {
  const total = tables.value.length
  const loading = tables.value.filter(t => t.loading).length
  const pending = tables.value.filter(t => t.status === 'pending').length
  const matching = tables.value.filter(t => t.status === 'match').length
  const uncounted = tables.value.filter(t => t.status === 'uncounted').length
  const mismatches = tables.value.filter(
    t => t.status === 'mismatch' || t.status === 'missing'
  ).length
  const mysqlUncounted = tables.value.filter(t => t.mysql.exists && t.mysql.recordCount === null).length

  return { total, loading: loading + pending, matching, mismatches, uncounted, mysqlUncounted }
})

const validationProgress = computed(() => {
  if (tables.value.length === 0) return 0
  const completed = tables.value.filter(t => !t.loading).length
  return Math.round((completed / tables.value.length) * 100)
})

onMounted(() => {
  loadTables()
})

// Watch for database changes and reset validation
watch(selectedDatabaseId, () => {
  resetValidation()
  loadTables()
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="border-b bg-card px-6 py-4">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-2xl font-bold">Database Validation</h1>
          <p class="text-sm text-muted-foreground">Compare ClickHouse and MySQL table consistency</p>
        </div>
        <div class="text-sm text-muted-foreground">
          Progress: <strong>{{ validationProgress }}%</strong>
        </div>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6 space-y-4">
      <!-- Summary Cards -->
      <div class="grid grid-cols-5 gap-4">
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Total Tables</div>
          <div class="text-3xl font-bold mt-2">{{ summary.total }}</div>
        </div>
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Matching</div>
          <div class="text-3xl font-bold text-green-600 mt-2">{{ summary.matching }}</div>
        </div>
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Mismatches</div>
          <div class="text-3xl font-bold text-red-600 mt-2">{{ summary.mismatches }}</div>
        </div>
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Uncounted</div>
          <div class="text-3xl font-bold text-yellow-600 mt-2">{{ summary.uncounted }}</div>
        </div>
        <div class="bg-card border rounded-lg p-4">
          <div class="text-sm text-muted-foreground">Loading</div>
          <div class="text-3xl font-bold text-muted-foreground mt-2">{{ summary.loading }}</div>
        </div>
      </div>

      <!-- Controls -->
      <div class="bg-card border rounded-lg p-4">
        <div class="flex items-center justify-between">
          <div class="flex gap-2">
            <Button
              @click="startValidation()"
              :disabled="validating || countingAllMySQL"
              size="sm"
            >
              {{ validating ? 'Validating...' : tables.length > 0 ? 'Validate All Tables' : 'Start Validation' }}
            </Button>
            <Button
              @click="countAllMySQLRecords()"
              :disabled="validating || countingAllMySQL || summary.mysqlUncounted === 0"
              size="sm"
              variant="secondary"
              title="Count all MySQL records (slow operation)"
            >
              {{ countingAllMySQL ? 'Counting...' : `Count MySQL (${summary.mysqlUncounted})` }}
            </Button>
            <Button
              @click="resetValidation()"
              :disabled="validating || countingAllMySQL"
              variant="secondary"
              size="sm"
            >
              Reset
            </Button>
            <Button
              @click="bulkDeleteFiltered()"
              :disabled="validating || bulkDeleting || countingAllMySQL || filteredTables.filter(t => t.duckdb.exists).length === 0"
              variant="destructive"
              size="sm"
            >
              {{ bulkDeleting ? 'Deleting...' : `Delete Filtered (${filteredTables.filter(t => t.duckdb.exists).length})` }}
            </Button>
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Search tables..."
              class="px-3 py-2 border border-input rounded-md w-48"
            />
            <Select v-model="errorTypeFilter">
              <SelectTrigger class="w-48">
                <SelectValue placeholder="All Error Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Error Types</SelectItem>
                <SelectItem value="schema_mismatch">Schema Mismatch</SelectItem>
                <SelectItem value="max_id_mismatch">Max ID Mismatch</SelectItem>
                <SelectItem value="checksum_mismatch">Checksum Mismatch</SelectItem>
                <SelectItem value="record_count_mismatch">Record Count Mismatch</SelectItem>
                <SelectItem value="missing_in_duckdb">Missing in ClickHouse</SelectItem>
                <SelectItem value="orphaned_in_duckdb">Orphaned in ClickHouse</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label class="flex items-center gap-2">
            <input v-model="showMismatchesOnly" type="checkbox" class="rounded" />
            <span class="text-sm">Show Mismatches Only</span>
          </label>
        </div>
      </div>

      <!-- Validation Table -->
      <div class="bg-card border rounded-lg overflow-auto">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50">
            <tr>
              <th class="px-4 py-3 text-left font-medium">Table Name</th>
              <th class="px-4 py-3 text-center font-medium w-24">ClickHouse</th>
              <th class="px-4 py-3 text-center font-medium w-24">MySQL</th>
              <th class="px-4 py-3 text-right font-medium w-24">CH Cols</th>
              <th class="px-4 py-3 text-right font-medium w-24">MySQL Cols</th>
              <th class="px-4 py-3 text-right font-medium w-32">CH Records</th>
              <th class="px-4 py-3 text-right font-medium w-32">MySQL Records</th>
              <th class="px-4 py-3 text-center font-medium w-40">Max ID</th>
              <th class="px-4 py-3 text-center font-medium w-32">Checksum</th>
              <th class="px-4 py-3 text-center font-medium w-40">Error Type</th>
              <th class="px-4 py-3 text-center font-medium w-24">Status</th>
              <th class="px-4 py-3 text-center font-medium w-40">Actions</th>
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
              <td class="px-4 py-3 text-center">
                <span v-if="table.loading" class="text-muted-foreground">...</span>
                <span v-else-if="table.duckdb.exists" class="text-green-600 text-lg">✓</span>
                <span v-else class="text-red-600 text-lg">✗</span>
              </td>
              <td class="px-4 py-3 text-center">
                <span v-if="table.loading" class="text-muted-foreground">...</span>
                <span v-else-if="table.mysql.exists" class="text-green-600 text-lg">✓</span>
                <span v-else class="text-red-600 text-lg">✗</span>
              </td>
              <td class="px-4 py-3 text-right">
                <span
                  v-if="!table.loading"
                  :class="!table.columnsMatch && !table.loading ? 'text-red-600 font-semibold' : ''"
                >
                  {{ table.duckdb.columnCount || 0 }}
                </span>
                <span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-3 text-right">
                <span
                  v-if="!table.loading"
                  :class="!table.columnsMatch && !table.loading ? 'text-red-600 font-semibold' : ''"
                >
                  {{ table.mysql.columnCount || 0 }}
                </span>
                <span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-3 text-right">
                <span
                  v-if="!table.loading"
                  :class="table.duckdb.recordCount !== table.mysql.recordCount && !table.loading ? 'text-red-600 font-semibold' : ''"
                >
                  {{ formatNumber(table.duckdb.recordCount) }}
                </span>
                <span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-3 text-right">
                <span v-if="table.loading" class="text-muted-foreground">-</span>
                <span v-else-if="table.countingMySQL" class="text-muted-foreground animate-pulse">Counting...</span>
                <span v-else-if="table.mysql.recordCount === null" class="text-yellow-600 cursor-pointer hover:underline" @click="countMySQLRecordsForTable(table)">
                  Click to count
                </span>
                <span
                  v-else
                  :class="table.duckdb.recordCount !== table.mysql.recordCount ? 'text-red-600 font-semibold' : ''"
                >
                  {{ formatNumber(table.mysql.recordCount) }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <span v-if="table.loading" class="text-muted-foreground">-</span>
                <span v-else-if="!table.primaryKey" class="text-muted-foreground text-xs">No PK</span>
                <span v-else-if="table.duckdb.maxId != null || table.mysql.maxId != null">
                  <span
                    :class="table.errorType === 'max_id_mismatch' ? 'text-red-600 font-semibold' : ''"
                    class="text-xs"
                  >
                    {{ table.duckdb.maxId ?? '-' }} / {{ table.mysql.maxId ?? '-' }}
                  </span>
                </span>
                <span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-3 text-center">
                <span v-if="table.loading" class="text-muted-foreground">-</span>
                <span v-else-if="!table.primaryKey" class="text-muted-foreground text-xs">-</span>
                <span v-else-if="table.duckdb.checksum == null && table.mysql.checksum == null" class="text-muted-foreground text-xs">N/A</span>
                <span v-else-if="table.duckdb.checksum === table.mysql.checksum" class="text-green-600 text-lg">✓</span>
                <span v-else class="text-red-600 text-lg font-semibold">✗</span>
              </td>
              <td class="px-4 py-3 text-center">
                <div v-if="!table.loading && table.errorType" class="text-xs">
                  <div
                    :class="{
                      'text-red-600 font-semibold': table.errorType === 'schema_mismatch' || table.errorType === 'max_id_mismatch' || table.errorType === 'checksum_mismatch',
                      'text-orange-600 font-semibold': table.errorType === 'record_count_mismatch',
                      'text-blue-600': table.errorType === 'missing_in_duckdb',
                      'text-muted-foreground': table.errorType === 'orphaned_in_duckdb'
                    }"
                  >
                    {{ formatErrorType(table.errorType) }}
                  </div>
                  <div v-if="table.errorMessage" class="text-muted-foreground mt-1">
                    {{ table.errorMessage }}
                  </div>
                </div>
                <span v-else class="text-muted-foreground">-</span>
              </td>
              <td class="px-4 py-3 text-center">
                <span v-if="table.loading" class="inline-block px-2 py-1 bg-muted text-muted-foreground rounded text-xs">
                  Loading...
                </span>
                <span v-else-if="table.countingMySQL" class="inline-block px-2 py-1 bg-muted text-muted-foreground rounded text-xs animate-pulse">
                  Counting...
                </span>
                <span v-else-if="table.status === 'pending'" class="inline-block px-2 py-1 bg-blue-100 text-blue-600 rounded text-xs">
                  Pending
                </span>
                <span v-else-if="table.status === 'uncounted'" class="inline-block px-2 py-1 bg-yellow-100 text-yellow-600 rounded text-xs">
                  Uncounted
                </span>
                <span v-else-if="table.status === 'match'" class="inline-block px-2 py-1 bg-green-100 text-green-600 rounded text-xs">
                  Match
                </span>
                <span v-else-if="table.status === 'mismatch'" class="inline-block px-2 py-1 bg-red-100 text-red-600 rounded text-xs">
                  Mismatch
                </span>
                <span v-else-if="table.status === 'missing'" class="inline-block px-2 py-1 bg-orange-100 text-orange-600 rounded text-xs">
                  Missing
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-center gap-1">
                  <Button
                    @click="syncTable(table)"
                    :disabled="table.syncing || table.loading || validating"
                    size="sm"
                    variant="outline"
                  >
                    {{ table.syncing ? 'Syncing...' : 'Sync' }}
                  </Button>
                  <Button
                    @click="revalidateTable(table)"
                    :disabled="table.loading || table.syncing || validating"
                    size="sm"
                    variant="outline"
                  >
                    {{ table.loading ? 'Checking...' : 'Revalidate' }}
                  </Button>
                  <Button
                    @click="deleteTable(table)"
                    :disabled="table.deleting || table.loading || table.syncing || validating || !table.duckdb.exists"
                    size="sm"
                    variant="destructive"
                    title="Delete table from ClickHouse (useful for schema changes)"
                  >
                    {{ table.deleting ? 'Deleting...' : 'Delete' }}
                  </Button>
                </div>
              </td>
            </tr>

            <tr v-if="filteredTables.length === 0">
              <td colspan="12" class="px-4 py-12 text-center text-muted-foreground">
                <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span v-if="searchQuery">No tables match your search</span>
                <span v-else-if="showMismatchesOnly">No mismatches found. Click "Start Validation" to validate all tables.</span>
                <span v-else-if="tables.length === 0">Loading tables...</span>
                <span v-else>All tables are hidden by your filters.</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Loading Overlay -->
    <div
      v-if="initialLoading"
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <div class="bg-card border rounded-lg p-8 max-w-md">
        <div class="flex items-center gap-4">
          <div class="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          <div>
            <div class="text-lg font-semibold mb-1">Loading Tables</div>
            <div class="text-sm text-muted-foreground">Please wait...</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
