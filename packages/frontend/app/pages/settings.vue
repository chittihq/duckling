<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="border-b">
      <div class="flex justify-between items-center p-6">
        <div>
          <h1 class="text-2xl font-bold">Settings</h1>
          <p class="text-sm text-muted-foreground">Manage database connections</p>
        </div>
        <Button @click="showAddDialog = true" size="sm">
          Add Database
        </Button>
      </div>
    </header>

    <!-- Content -->
    <div class="p-6">
      <div v-if="loading" class="text-center py-12">
        <p>Loading databases...</p>
      </div>

      <div v-else-if="error" class="bg-destructive/10 text-destructive p-4 rounded-lg">
        {{ error }}
      </div>

      <div v-else class="grid gap-4">
        <Card v-for="db in databases" :key="db.id">
          <CardHeader>
            <CardTitle class="flex items-center justify-between">
              <span>{{ db.name }}</span>
              <div class="flex gap-2">
                <Button @click="testConnection(db.id)" :disabled="testing === db.id" variant="outline" size="sm">
                  {{ testing === db.id ? 'Testing...' : 'Test Connection' }}
                </Button>
                <Button @click="editDatabase(db)" variant="outline" size="sm">
                  Edit
                </Button>
                <Button @click="runDiagnose(db)" :disabled="diagnosing === db.id" variant="outline" size="sm">
                  {{ diagnosing === db.id ? 'Diagnosing...' : 'Diagnose' }}
                </Button>
                <Button
                  @click="deleteDatabase(db.id)"
                  variant="destructive"
                  size="sm"
                  :disabled="deleting === db.id"
                >
                  {{ deleting === db.id ? 'Deleting...' : 'Delete' }}
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl class="grid grid-cols-2 gap-2 text-sm">
              <dt class="text-muted-foreground">Database ID:</dt>
              <dd class="font-mono">{{ db.id }}</dd>

              <dt class="text-muted-foreground">ClickHouse DB:</dt>
              <dd class="font-mono text-xs">{{ db.clickhouseDatabase || db.id }}</dd>

              <dt class="text-muted-foreground">Created:</dt>
              <dd>{{ formatDate(db.createdAt) }}</dd>

              <dt class="text-muted-foreground">Updated:</dt>
              <dd>{{ formatDate(db.updatedAt) }}</dd>
            </dl>
            <div v-if="connectionStatus[db.id]" class="mt-4 p-3 bg-muted rounded-md">
              <p class="text-sm font-medium mb-2">Connection Status:</p>
              <div class="flex gap-4 text-sm">
                <span>MySQL: <span :class="connectionStatus[db.id].mysql === 'healthy' ? 'text-green-600' : 'text-red-600'">
                  {{ connectionStatus[db.id].mysql }}
                </span></span>
                <span>ClickHouse: <span :class="connectionStatus[db.id].clickhouse === 'healthy' ? 'text-green-600' : 'text-red-600'">
                  {{ connectionStatus[db.id].clickhouse }}
                </span></span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Add/Edit Database Dialog -->
    <Dialog v-model:open="showAddDialog">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editingDb ? 'Edit Database' : 'Add Database' }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <div>
            <label class="text-sm font-medium">Database Name</label>
            <Input v-model="formData.name" placeholder="My Database" class="mt-1" />
          </div>
          <div>
            <label class="text-sm font-medium">MySQL Connection String</label>
            <Input
              v-model="formData.mysqlConnectionString"
              placeholder="mysql://user:pass@host:3306/dbname"
              type="password"
              class="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button @click="showAddDialog = false" variant="outline" size="sm">
            Cancel
          </Button>
          <Button @click="saveDatabase" :disabled="saving" size="sm">
            {{ saving ? 'Saving...' : 'Save' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Diagnose Results Dialog -->
    <Dialog v-model:open="showDiagnoseDialog">
      <DialogScrollContent class="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Diagnose — {{ selectedDiagnoseDb?.name }}</DialogTitle>
        </DialogHeader>

        <div class="space-y-6 mt-2">
        <div>
          <h3 class="text-sm font-semibold mb-3">Realtime Progress</h3>
          <div v-if="diagnoseTicks.length === 0" class="text-sm text-muted-foreground">
            Waiting for diagnose updates...
          </div>
          <div v-else class="space-y-1.5">
            <div v-for="tick in diagnoseTicks" :key="tick.id" class="flex items-center gap-2 text-sm">
              <span
                :class="{
                  'text-green-600': tick.status === 'pass',
                  'text-yellow-600': tick.status === 'warn',
                  'text-red-600': tick.status === 'fail',
                }"
                class="w-4 text-center font-bold"
              >
                {{ tick.status === 'pass' ? '\u2713' : tick.status === 'warn' ? '!' : '\u2717' }}
              </span>
              <span class="w-40 text-muted-foreground">{{ tick.name }}</span>
              <span :class="{ 'text-yellow-600': tick.status === 'warn', 'text-red-600': tick.status === 'fail' }">
                {{ tick.detail }}
              </span>
            </div>
          </div>
          <p v-if="diagnosing === selectedDiagnoseDb?.id && !diagnoseStreamDone" class="text-xs text-muted-foreground mt-2">
            Running diagnose...
          </p>
        </div>

        <template v-if="diagnoseResult">
          <div class="border-t border-border" />

          <!-- Server Checks -->
          <div>
            <h3 class="text-sm font-semibold mb-3">Server Checks</h3>
            <div class="space-y-1.5">
              <div v-for="check in diagnoseResult.server" :key="check.name" class="flex items-center gap-2 text-sm">
                <span
                  :class="{
                    'text-green-600': check.status === 'pass',
                    'text-yellow-600': check.status === 'warn',
                    'text-red-600': check.status === 'fail',
                  }"
                  class="w-4 text-center font-bold"
                >
                  {{ check.status === 'pass' ? '\u2713' : check.status === 'warn' ? '!' : '\u2717' }}
                </span>
                <span class="w-40 text-muted-foreground">{{ check.name }}</span>
                <span :class="{ 'text-yellow-600': check.status === 'warn', 'text-red-600': check.status === 'fail' }">
                  {{ check.detail }}
                </span>
              </div>
            </div>
          </div>

          <div class="border-t border-border" />

          <!-- Summary -->
          <div>
            <h3 class="text-sm font-semibold mb-3">Summary</h3>
            <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>Tables: <strong>{{ diagnoseResult.summary.totalTables }}</strong></span>
              <span>With PK: <strong :class="diagnoseResult.summary.tablesWithPrimaryKey < diagnoseResult.summary.totalTables ? 'text-yellow-600' : ''">{{ diagnoseResult.summary.tablesWithPrimaryKey }}</strong></span>
              <span>With timestamp: <strong :class="diagnoseResult.summary.tablesWithTimestamp < diagnoseResult.summary.totalTables ? 'text-yellow-600' : ''">{{ diagnoseResult.summary.tablesWithTimestamp }}</strong></span>
              <span>Columns: <strong>{{ diagnoseResult.summary.totalColumns }}</strong></span>
              <span>Unsupported types: <strong :class="diagnoseResult.summary.unsupportedColumns > 0 ? 'text-yellow-600' : ''">{{ diagnoseResult.summary.unsupportedColumns }}</strong></span>
            </div>
          </div>

          <div class="border-t border-border" />

          <!-- Per-table results -->
          <div>
            <h3 class="text-sm font-semibold mb-3">Tables</h3>
            <div class="space-y-1">
              <div
                v-for="tbl in sortedDiagnoseTables"
                :key="tbl.table"
                class="flex items-start gap-3 px-3 py-1.5 text-sm rounded hover:bg-muted/50"
              >
                <span class="font-mono font-medium w-48 shrink-0 truncate" :title="tbl.table">{{ tbl.table }}</span>
                <span class="text-xs text-muted-foreground w-20 shrink-0 text-right tabular-nums">~{{ formatNumber(tbl.estimatedRows) }}</span>
                <span class="text-xs w-28 shrink-0" :class="tbl.primaryKey ? 'text-muted-foreground' : 'text-yellow-600'">
                  PK: {{ tbl.primaryKey || 'none' }}
                </span>
                <span class="text-xs w-32 shrink-0" :class="tbl.timestampColumn ? (tbl.timestampQuality === 'append-only' ? 'text-yellow-600' : 'text-muted-foreground') : 'text-yellow-600'">
                  TS: {{ tbl.timestampColumn || 'none' }}
                </span>
                <span class="text-xs text-muted-foreground truncate" :title="tbl.charset">{{ tbl.charset }}</span>
                <div v-if="tableHasWarning(tbl)" class="flex items-center gap-1 shrink-0">
                  <span
                    v-if="!tbl.primaryKey"
                    class="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    title="No primary key — slow sync, no CDC deletes"
                  >no PK</span>
                  <span
                    v-if="!tbl.timestampColumn"
                    class="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    title="No timestamp column — no incremental sync possible"
                  >no TS</span>
                  <span
                    v-else-if="tbl.timestampQuality === 'append-only'"
                    class="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    :title="`Only ${tbl.timestampColumn} — updates not tracked`"
                  >append-only</span>
                  <span
                    v-if="tbl.unsupportedColumns.length > 0"
                    class="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    :title="`Unsupported: ${tbl.unsupportedColumns.map(c => c.column + ' (' + c.type + ')').join(', ')}`"
                  >{{ tbl.unsupportedColumns.length }} unsupported</span>
                </div>
              </div>
            </div>
          </div>
        </template>
        </div>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { toast } from '@/components/ui/toast';

interface Database {
  id: string;
  name: string;
  mysqlConnectionString: string;
  clickhouseDatabase?: string;
  createdAt: string;
  updatedAt: string;
}

interface DiagnoseCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

interface TableDiagnosis {
  table: string;
  estimatedRows: number;
  primaryKey: string | null;
  timestampColumn: string | null;
  timestampQuality: 'best' | 'append-only' | 'none';
  unsupportedColumns: Array<{ column: string; type: string; mapping: string }>;
  charset: string;
}

interface DiagnoseResult {
  server: DiagnoseCheck[];
  tables: TableDiagnosis[];
  summary: {
    totalTables: number;
    tablesWithPrimaryKey: number;
    tablesWithTimestamp: number;
    totalColumns: number;
    unsupportedColumns: number;
  };
}

interface DiagnoseTick {
  id: number;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

const { get, post, put, delete: del } = useApi();
const { getAuthToken } = useAuth();
const runtimeConfig = useRuntimeConfig();
const apiBase = runtimeConfig.public.apiBase || '';

// --- Database list state ---
const databases = ref<Database[]>([]);
const loading = ref(true);
const error = ref('');
const showAddDialog = ref(false);
const editingDb = ref<Database | null>(null);
const formData = ref({ name: '', mysqlConnectionString: '' });
const saving = ref(false);
const testing = ref('');
const deleting = ref('');
const connectionStatus = ref<Record<string, { mysql: string; clickhouse: string }>>({});

// --- Diagnose dialog state ---
const diagnosing = ref('');
const showDiagnoseDialog = ref(false);
const selectedDiagnoseDb = ref<Database | null>(null);
const diagnoseResult = ref<DiagnoseResult | null>(null);
const diagnoseTicks = ref<DiagnoseTick[]>([]);
const diagnoseStreamDone = ref(false);
const expandedTables = ref<Set<string>>(new Set());
let diagnoseEventSource: EventSource | null = null;

onMounted(loadDatabases);
onBeforeUnmount(() => {
  if (diagnoseEventSource) {
    diagnoseEventSource.close();
    diagnoseEventSource = null;
  }
});

watch(showDiagnoseDialog, (open) => {
  if (!open && diagnoseEventSource) {
    diagnoseEventSource.close();
    diagnoseEventSource = null;
    diagnosing.value = '';
  }
});

// --- Database management ---

async function loadDatabases() {
  try {
    loading.value = true;
    error.value = '';
    const data = await get<{ success: boolean; databases: Database[]; error?: string }>('/api/databases');
    if (data.success) {
      databases.value = data.databases;
    } else {
      error.value = data.error || 'Failed to load databases';
    }
  } catch {
    error.value = 'Failed to load databases';
  } finally {
    loading.value = false;
  }
}

function editDatabase(db: Database) {
  editingDb.value = db;
  formData.value = { name: db.name, mysqlConnectionString: db.mysqlConnectionString };
  showAddDialog.value = true;
}

async function saveDatabase() {
  try {
    saving.value = true;
    const data = editingDb.value
      ? await put<{ success: boolean; error?: string }>(`/api/databases/${editingDb.value.id}`, formData.value)
      : await post<{ success: boolean; error?: string }>('/api/databases', formData.value);

    if (data.success) {
      showAddDialog.value = false;
      editingDb.value = null;
      formData.value = { name: '', mysqlConnectionString: '' };
      await loadDatabases();
      toast({ title: 'Success', description: 'Database saved successfully' });
    } else {
      toast({ title: 'Error', description: data.error || 'Failed to save database', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Failed to save database', variant: 'destructive' });
  } finally {
    saving.value = false;
  }
}

async function deleteDatabase(id: string) {
  if (!confirm('Are you sure you want to delete this database?')) return;
  try {
    deleting.value = id;
    const data = await del<{ success: boolean; error?: string }>(`/api/databases/${id}`);
    if (data.success) {
      await loadDatabases();
      toast({ title: 'Success', description: 'Database deleted successfully' });
    } else {
      toast({ title: 'Error', description: data.error || 'Failed to delete database', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Failed to delete database', variant: 'destructive' });
  } finally {
    deleting.value = '';
  }
}

async function testConnection(id: string) {
  try {
    testing.value = id;
    const data = await post<{ success: boolean; connections?: { mysql: string; clickhouse: string }; error?: string }>(
      `/api/databases/${id}/test`
    );
    if (data.success && data.connections) {
      connectionStatus.value[id] = data.connections;
      toast({ title: 'Success', description: 'Connection test successful' });
    } else {
      toast({ title: 'Error', description: data.error || 'Failed to test connection', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Failed to test connection', variant: 'destructive' });
  } finally {
    testing.value = '';
  }
}

// --- Diagnose ---

async function runDiagnose(db: Database) {
  try {
    diagnosing.value = db.id;
    selectedDiagnoseDb.value = db;
    showDiagnoseDialog.value = true;
    diagnoseResult.value = null;
    diagnoseTicks.value = [];
    diagnoseStreamDone.value = false;
    expandedTables.value = new Set();

    if (diagnoseEventSource) {
      diagnoseEventSource.close();
      diagnoseEventSource = null;
    }

    const token = getAuthToken();
    if (!token) {
      throw new Error('Missing authentication token');
    }

    // EventSource does not support custom Authorization headers, so token is passed in query string for SSE.
    diagnoseEventSource = new EventSource(`${apiBase}/api/databases/${db.id}/diagnose/stream?token=${encodeURIComponent(token)}`);

    diagnoseEventSource.addEventListener('tick', (event) => {
      const tick = JSON.parse((event as MessageEvent).data) as DiagnoseTick;
      diagnoseTicks.value.push(tick);
    });

    diagnoseEventSource.addEventListener('result', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { diagnosis: DiagnoseResult };
      diagnoseResult.value = payload.diagnosis;
    });

    diagnoseEventSource.addEventListener('done', () => {
      diagnoseStreamDone.value = true;
      diagnosing.value = '';
      if (diagnoseEventSource) {
        diagnoseEventSource.close();
        diagnoseEventSource = null;
      }
    });

    diagnoseEventSource.addEventListener('diagnose-error', (event) => {
      const payload = (() => {
        try {
          return JSON.parse((event as MessageEvent).data) as { error?: string };
        } catch (parseError) {
          console.error('Failed to parse diagnose-error payload', parseError);
          return null;
        }
      })();
      if (!diagnoseStreamDone.value) {
        toast({ title: 'Error', description: payload?.error || 'Diagnose failed', variant: 'destructive' });
      }
      diagnosing.value = '';
      if (diagnoseEventSource) {
        diagnoseEventSource.close();
        diagnoseEventSource = null;
      }
    });

    diagnoseEventSource.onerror = () => {
      if (!diagnoseStreamDone.value) {
        toast({ title: 'Error', description: 'Diagnose stream disconnected', variant: 'destructive' });
      }
      diagnosing.value = '';
      if (diagnoseEventSource) {
        diagnoseEventSource.close();
        diagnoseEventSource = null;
      }
    };
  } catch {
    toast({ title: 'Error', description: 'Diagnose failed', variant: 'destructive' });
    diagnosing.value = '';
  }
}

function tableHasWarning(tbl: TableDiagnosis): boolean {
  return !tbl.primaryKey || !tbl.timestampColumn || tbl.timestampQuality === 'append-only' || tbl.unsupportedColumns.length > 0;
}

const sortedDiagnoseTables = computed(() => {
  if (!diagnoseResult.value) return [];
  return [...diagnoseResult.value.tables].sort((a, b) => {
    const aWarn = tableHasWarning(a) ? 0 : 1;
    const bWarn = tableHasWarning(b) ? 0 : 1;
    if (aWarn !== bWarn) return aWarn - bWarn;
    return a.table.localeCompare(b.table);
  });
});

function toggleTableExpand(table: string) {
  if (expandedTables.value.has(table)) {
    expandedTables.value.delete(table);
  } else {
    expandedTables.value.add(table);
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// --- Utilities ---

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

</script>
