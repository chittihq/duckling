<template>
  <div class="min-h-screen bg-background">
    <!-- Header -->
    <header class="border-b">
      <div class="flex justify-between items-center p-6">
        <div>
          <h1 class="text-2xl font-bold">Settings</h1>
          <p class="text-sm text-muted-foreground">Manage database connections and backups</p>
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
                <Button @click="openBackupDialog(db)" variant="outline" size="sm">
                  Backups
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

              <dt class="text-muted-foreground">DuckDB Path:</dt>
              <dd class="font-mono text-xs">{{ db.duckdbPath }}</dd>

              <dt class="text-muted-foreground">Created:</dt>
              <dd>{{ formatDate(db.createdAt) }}</dd>

              <dt class="text-muted-foreground">Updated:</dt>
              <dd>{{ formatDate(db.updatedAt) }}</dd>
            </dl>

            <!-- S3 backup status -->
            <div class="mt-3 flex items-center gap-2 text-xs">
              <span class="text-muted-foreground">S3 Backup:</span>
              <span
                v-if="db.s3?.enabled"
                class="px-2 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
              >
                Enabled · {{ db.s3.bucket }}<span v-if="db.s3.s3BackupIntervalHours"> · every {{ db.s3.s3BackupIntervalHours }}h</span>
              </span>
              <span
                v-else-if="db.s3"
                class="px-2 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                Configured (disabled)
              </span>
              <span v-else class="text-muted-foreground">Not configured</span>
            </div>

            <div v-if="connectionStatus[db.id]" class="mt-4 p-3 bg-muted rounded-md">
              <p class="text-sm font-medium mb-2">Connection Status:</p>
              <div class="flex gap-4 text-sm">
                <span>MySQL: <span :class="connectionStatus[db.id].mysql === 'healthy' ? 'text-green-600' : 'text-red-600'">
                  {{ connectionStatus[db.id].mysql }}
                </span></span>
                <span>DuckDB: <span :class="connectionStatus[db.id].duckdb === 'healthy' ? 'text-green-600' : 'text-red-600'">
                  {{ connectionStatus[db.id].duckdb }}
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

    <!-- Backup Management Dialog (per database) -->
    <Dialog v-model:open="showBackupDialog">
      <DialogScrollContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Backups — {{ selectedBackupDb?.name }}</DialogTitle>
        </DialogHeader>

        <div v-if="loadingBackups" class="py-8 text-center text-sm text-muted-foreground">
          Loading...
        </div>

        <div v-else class="space-y-6 mt-2">

        <!-- S3 Configuration -->
        <div>
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold">S3 Configuration</h3>
            <div v-if="!editingS3" class="flex gap-2">
              <Button v-if="s3Config" @click="testS3Connection" :disabled="testingS3" variant="outline" size="sm">
                {{ testingS3 ? 'Testing...' : 'Test S3' }}
              </Button>
              <Button @click="startEditS3" variant="outline" size="sm">
                {{ s3Config ? 'Edit' : 'Configure' }}
              </Button>
              <Button v-if="s3Config" @click="removeS3Config" :disabled="removingS3" variant="destructive" size="sm">
                {{ removingS3 ? 'Removing...' : 'Remove' }}
              </Button>
            </div>
          </div>

          <!-- Config summary -->
          <div v-if="!editingS3">
            <p v-if="!s3Config" class="text-sm text-muted-foreground">
              S3 not configured. Click "Configure" to enable cloud backups.
            </p>
            <dl v-else class="grid grid-cols-2 gap-2 text-sm">
              <dt class="text-muted-foreground">Status:</dt>
              <dd>
                <span :class="s3Config.enabled ? 'text-green-600' : 'text-muted-foreground'">
                  {{ s3Config.enabled ? 'Enabled' : 'Disabled' }}
                </span>
              </dd>
              <dt class="text-muted-foreground">Bucket:</dt>
              <dd class="font-mono">{{ s3Config.bucket }}</dd>
              <dt class="text-muted-foreground">Region:</dt>
              <dd class="font-mono">{{ s3Config.region }}</dd>
              <dt class="text-muted-foreground">Encryption:</dt>
              <dd>
                <span :class="{
                  'text-green-600': s3Config.encryption === 'client-aes256',
                  'text-blue-600': s3Config.encryption === 'sse-s3' || s3Config.encryption === 'sse-kms',
                  'text-muted-foreground': !s3Config.encryption || s3Config.encryption === 'none',
                }">
                  {{ { 'none': 'None', 'sse-s3': 'SSE-S3', 'sse-kms': 'SSE-KMS', 'client-aes256': 'Client-side AES-256' }[s3Config.encryption ?? 'none'] ?? 'None' }}
                </span>
              </dd>
              <template v-if="s3Config.s3BackupIntervalHours">
                <dt class="text-muted-foreground">Auto Backup:</dt>
                <dd>
                  Every {{ s3Config.s3BackupIntervalHours }}h
                  <span v-if="s3Config.s3BackupRetentionDays" class="text-muted-foreground">
                    (keep {{ s3Config.s3BackupRetentionDays }} days)
                  </span>
                </dd>
              </template>
            </dl>
          </div>

          <!-- Inline S3 config form -->
          <div v-else class="space-y-4 p-4 border border-border rounded-lg">
            <div>
              <label class="text-sm font-medium">Bucket</label>
              <Input v-model="s3Form.bucket" placeholder="my-backup-bucket" class="mt-1" />
            </div>
            <div>
              <label class="text-sm font-medium">Region</label>
              <Input v-model="s3Form.region" placeholder="us-east-1" class="mt-1" />
            </div>
            <div>
              <label class="text-sm font-medium">Access Key ID</label>
              <Input v-model="s3Form.accessKeyId" placeholder="AKIAIOSFODNN7EXAMPLE" class="mt-1" />
            </div>
            <div>
              <label class="text-sm font-medium">
                Secret Access Key
                <span v-if="s3Config" class="text-muted-foreground font-normal">(leave blank to keep existing)</span>
              </label>
              <Input v-model="s3Form.secretAccessKey" type="password" placeholder="Enter secret access key" class="mt-1" />
            </div>
            <div>
              <label class="text-sm font-medium">
                Endpoint
                <span class="text-muted-foreground font-normal">(optional, for MinIO, R2, B2, Spaces…)</span>
              </label>
              <Input v-model="s3Form.endpoint" placeholder="https://s3.example.com" class="mt-1" />
            </div>
            <div class="flex items-center gap-2">
              <input type="checkbox" id="forcePathStyle" v-model="s3Form.forcePathStyle" class="w-4 h-4" />
              <label for="forcePathStyle" class="text-sm font-medium">
                Force path-style URLs
                <span class="text-muted-foreground font-normal">(required for MinIO and most self-hosted providers)</span>
              </label>
            </div>
            <div>
              <label class="text-sm font-medium">Encryption</label>
              <select v-model="s3Form.encryption" class="mt-1 w-full border rounded-md px-3 py-2 text-sm bg-background">
                <option value="none">None</option>
                <option value="sse-s3">Server-Side SSE-S3 (AWS-managed key, free)</option>
                <option value="sse-kms">Server-Side SSE-KMS (AWS KMS, audit trail)</option>
                <option value="client-aes256">Client-Side AES-256 (zero-knowledge, recommended)</option>
              </select>
            </div>
            <div v-if="s3Form.encryption === 'sse-kms'">
              <label class="text-sm font-medium">
                KMS Key ID
                <span class="text-muted-foreground font-normal">(optional, uses AWS default if blank)</span>
              </label>
              <Input v-model="s3Form.kmsKeyId" placeholder="arn:aws:kms:us-east-1:..." class="mt-1" />
            </div>
            <div v-if="s3Form.encryption === 'client-aes256'">
              <label class="text-sm font-medium">
                Encryption Key
                <span class="text-muted-foreground font-normal">
                  ({{ s3Config ? 'leave blank to keep existing' : '64-char hex / 32 bytes' }})
                </span>
              </label>
              <Input v-model="s3Form.encryptionKey" type="password" placeholder="64-character hex string" class="mt-1" />
              <p class="mt-1 text-xs text-muted-foreground">
                Generate: <code>node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</code>
              </p>
            </div>
            <div>
              <label class="text-sm font-medium">
                Path Prefix
                <span class="text-muted-foreground font-normal">(optional, defaults to <code>{{ selectedBackupDb?.id }}/</code>)</span>
              </label>
              <Input v-model="s3Form.pathPrefix" :placeholder="`${selectedBackupDb?.id}/`" class="mt-1" />
            </div>
            <div>
              <label class="text-sm font-medium">
                Automatic Backup Interval
                <span class="text-muted-foreground font-normal">(hours; 0 = disabled)</span>
              </label>
              <Input v-model.number="s3Form.s3BackupIntervalHours" type="number" min="0" placeholder="0" class="mt-1" />
            </div>
            <div v-if="s3Form.s3BackupIntervalHours > 0">
              <label class="text-sm font-medium">
                Retention
                <span class="text-muted-foreground font-normal">(days to keep S3 backups; 0 = indefinitely)</span>
              </label>
              <Input v-model.number="s3Form.s3BackupRetentionDays" type="number" min="0" placeholder="30" class="mt-1" />
            </div>
            <div class="flex items-center gap-2">
              <input type="checkbox" id="s3Enabled" v-model="s3Form.enabled" class="w-4 h-4" />
              <label for="s3Enabled" class="text-sm font-medium">Enable S3 backup</label>
            </div>
            <div class="flex gap-2 pt-2">
              <Button @click="saveS3Config" :disabled="savingS3" size="sm">
                {{ savingS3 ? 'Saving...' : 'Save' }}
              </Button>
              <Button @click="editingS3 = false" variant="outline" size="sm">Cancel</Button>
            </div>
          </div>
        </div>

        <div class="border-t border-border" />

        <!-- Actions -->
        <div>
          <h3 class="text-sm font-semibold mb-3">Actions</h3>
          <div class="flex gap-3">
            <Button @click="triggerS3Backup" :disabled="!s3Config?.enabled || backingUpS3" size="sm">
              {{ backingUpS3 ? 'Backing up...' : 'Backup to S3 Now' }}
            </Button>
            <Button @click="triggerLocalBackup" :disabled="backingUpLocal" variant="outline" size="sm">
              {{ backingUpLocal ? 'Backing up...' : 'Backup Locally' }}
            </Button>
          </div>
        </div>

        <div class="border-t border-border" />

        <!-- Backup History -->
        <div>
          <h3 class="text-sm font-semibold mb-3">Backup History</h3>
          <div v-if="backupsError" class="bg-destructive/10 text-destructive p-3 rounded text-sm">
            {{ backupsError }}
          </div>
          <div v-else-if="backups.length === 0" class="text-sm text-muted-foreground py-4 text-center">
            No backups found.
          </div>
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="border-b">
                <th class="text-left py-2 font-medium">Name</th>
                <th class="text-left py-2 font-medium">Location</th>
                <th class="text-left py-2 font-medium">Size</th>
                <th class="text-left py-2 font-medium">Date</th>
                <th class="text-right py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="backup in backups" :key="backup.key" class="border-b last:border-0 hover:bg-muted/50">
                <td class="py-2 font-mono text-xs max-w-xs truncate">{{ backup.name }}</td>
                <td class="py-2">
                  <span
                    :class="backup.location === 's3'
                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'"
                    class="px-2 py-0.5 rounded text-xs font-medium"
                  >
                    {{ backup.location === 's3' ? 'S3' : 'Local' }}
                  </span>
                </td>
                <td class="py-2 text-muted-foreground">{{ formatBytes(backup.size) }}</td>
                <td class="py-2 text-muted-foreground">{{ formatDate(backup.lastModified) }}</td>
                <td class="py-2 text-right">
                  <Button
                    v-if="backup.location === 's3'"
                    @click="executeRestore(backup)"
                    :disabled="restoring"
                    variant="outline"
                    size="sm"
                  >
                    {{ restoring ? 'Restoring...' : 'Restore' }}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        </div>
      </DialogScrollContent>
    </Dialog>

    <!-- Diagnose Results Dialog -->
    <Dialog v-model:open="showDiagnoseDialog">
      <DialogScrollContent class="max-w-3xl">
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
            <div class="space-y-2">
              <div
                v-for="tbl in sortedDiagnoseTables"
                :key="tbl.table"
                class="border border-border rounded-lg"
              >
                <button
                  @click="toggleTableExpand(tbl.table)"
                  class="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 rounded-lg"
                >
                  <div class="flex items-center gap-2">
                    <span class="font-mono font-medium">{{ tbl.table }}</span>
                    <span
                      v-if="tableHasWarning(tbl)"
                      class="px-1.5 py-0.5 rounded text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                    >!</span>
                  </div>
                  <div class="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>~{{ formatNumber(tbl.estimatedRows) }} rows</span>
                    <span>{{ expandedTables.has(tbl.table) ? '\u25B2' : '\u25BC' }}</span>
                  </div>
                </button>
                <div v-if="expandedTables.has(tbl.table)" class="px-3 pb-3 text-sm space-y-1.5">
                  <div class="flex gap-4 text-xs">
                    <span>
                      PK:
                      <strong :class="tbl.primaryKey ? '' : 'text-yellow-600'">
                        {{ tbl.primaryKey || 'none' }}
                      </strong>
                    </span>
                    <span>
                      Timestamp:
                      <strong :class="tbl.timestampColumn ? (tbl.timestampQuality === 'append-only' ? 'text-yellow-600' : '') : 'text-yellow-600'">
                        {{ tbl.timestampColumn || 'none' }}
                      </strong>
                    </span>
                    <span>Charset: <span class="font-mono">{{ tbl.charset }}</span></span>
                  </div>
                  <!-- Warnings -->
                  <div v-if="!tbl.primaryKey" class="text-xs text-yellow-600">
                    No primary key — slow sync, no CDC deletes
                  </div>
                  <div v-if="!tbl.timestampColumn" class="text-xs text-yellow-600">
                    No timestamp column — no incremental sync possible
                  </div>
                  <div v-else-if="tbl.timestampQuality === 'append-only'" class="text-xs text-yellow-600">
                    Only {{ tbl.timestampColumn }} — updates not tracked
                  </div>
                  <!-- Unsupported columns -->
                  <div v-if="tbl.unsupportedColumns.length > 0" class="text-xs text-yellow-600">
                    Unsupported types (mapped to VARCHAR):
                    <span v-for="(col, i) in tbl.unsupportedColumns" :key="col.column">
                      {{ col.column }} ({{ col.type }}){{ i < tbl.unsupportedColumns.length - 1 ? ', ' : '' }}
                    </span>
                  </div>
                  <div v-if="!tableHasWarning(tbl)" class="text-xs text-green-600">
                    All checks passed
                  </div>
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

interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  accessKeyId: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  pathPrefix?: string;
  encryption?: 'none' | 'sse-s3' | 'sse-kms' | 'client-aes256';
  kmsKeyId?: string;
  s3BackupIntervalHours?: number;
  s3BackupRetentionDays?: number;
}

interface Database {
  id: string;
  name: string;
  mysqlConnectionString: string;
  duckdbPath: string;
  createdAt: string;
  updatedAt: string;
  s3?: S3Config;
}

interface Backup {
  name: string;
  location: 'local' | 's3';
  size: number;
  lastModified: string;
  key: string;
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
const connectionStatus = ref<Record<string, { mysql: string; duckdb: string }>>({});

// --- Diagnose dialog state ---
const diagnosing = ref('');
const showDiagnoseDialog = ref(false);
const selectedDiagnoseDb = ref<Database | null>(null);
const diagnoseResult = ref<DiagnoseResult | null>(null);
const diagnoseTicks = ref<DiagnoseTick[]>([]);
const diagnoseStreamDone = ref(false);
const expandedTables = ref<Set<string>>(new Set());
let diagnoseEventSource: EventSource | null = null;

// --- Backup dialog state ---
const showBackupDialog = ref(false);
const selectedBackupDb = ref<Database | null>(null);
const loadingBackups = ref(false);
const s3Config = ref<S3Config | null>(null);
const backups = ref<Backup[]>([]);
const backupsError = ref('');

// S3 config form (inline within backup dialog)
const editingS3 = ref(false);
const s3Form = ref({
  enabled: true,
  bucket: '',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  endpoint: '',
  forcePathStyle: false,
  pathPrefix: '',
  encryption: 'none' as 'none' | 'sse-s3' | 'sse-kms' | 'client-aes256',
  kmsKeyId: '',
  encryptionKey: '',
  s3BackupIntervalHours: 0,
  s3BackupRetentionDays: 30,
});

const testingS3 = ref(false);
const savingS3 = ref(false);
const removingS3 = ref(false);
const backingUpS3 = ref(false);
const backingUpLocal = ref(false);
const restoring = ref(false);

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
    const data = await post<{ success: boolean; connections?: { mysql: string; duckdb: string }; error?: string }>(
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

// --- Backup dialog ---

async function openBackupDialog(db: Database) {
  selectedBackupDb.value = db;
  s3Config.value = null;
  backups.value = [];
  backupsError.value = '';
  editingS3.value = false;
  showBackupDialog.value = true;
  loadingBackups.value = true;
  await Promise.all([loadS3Config(db.id), loadBackups(db.id)]);
  loadingBackups.value = false;
}

async function loadS3Config(dbId: string) {
  try {
    const data = await get<{ success: boolean; s3: S3Config | null }>(`/api/databases/${dbId}/s3`);
    s3Config.value = data.success ? data.s3 : null;
  } catch {
    s3Config.value = null;
  }
}

async function loadBackups(dbId: string) {
  try {
    backupsError.value = '';
    const data = await get<{ success: boolean; backups: Backup[]; error?: string }>(
      `/api/backups?db=${dbId}`
    );
    backups.value = data.success ? data.backups : [];
    if (!data.success) backupsError.value = data.error || 'Failed to load backups';
  } catch {
    backupsError.value = 'Failed to load backups';
    backups.value = [];
  }
}

// --- S3 config ---

function startEditS3() {
  if (s3Config.value) {
    s3Form.value = {
      enabled: s3Config.value.enabled,
      bucket: s3Config.value.bucket,
      region: s3Config.value.region,
      accessKeyId: s3Config.value.accessKeyId,
      secretAccessKey: '',
      endpoint: s3Config.value.endpoint || '',
      forcePathStyle: s3Config.value.forcePathStyle ?? false,
      pathPrefix: s3Config.value.pathPrefix || '',
      encryption: s3Config.value.encryption || 'none',
      kmsKeyId: s3Config.value.kmsKeyId || '',
      encryptionKey: '',
      s3BackupIntervalHours: s3Config.value.s3BackupIntervalHours ?? 0,
      s3BackupRetentionDays: s3Config.value.s3BackupRetentionDays ?? 30,
    };
  } else {
    s3Form.value = {
      enabled: true, bucket: '', region: 'us-east-1', accessKeyId: '', secretAccessKey: '',
      endpoint: '', forcePathStyle: false, pathPrefix: '', encryption: 'none', kmsKeyId: '',
      encryptionKey: '', s3BackupIntervalHours: 0, s3BackupRetentionDays: 30,
    };
  }
  editingS3.value = true;
}

async function saveS3Config() {
  if (!selectedBackupDb.value) return;
  try {
    savingS3.value = true;
    const payload: Record<string, any> = {
      enabled: s3Form.value.enabled,
      bucket: s3Form.value.bucket,
      region: s3Form.value.region,
      accessKeyId: s3Form.value.accessKeyId,
    };
    if (s3Form.value.secretAccessKey) payload.secretAccessKey = s3Form.value.secretAccessKey;
    if (s3Form.value.endpoint) payload.endpoint = s3Form.value.endpoint;
    if (s3Form.value.forcePathStyle) payload.forcePathStyle = true;
    if (s3Form.value.pathPrefix) payload.pathPrefix = s3Form.value.pathPrefix;
    payload.encryption = s3Form.value.encryption;
    if (s3Form.value.kmsKeyId) payload.kmsKeyId = s3Form.value.kmsKeyId;
    if (s3Form.value.encryptionKey) payload.encryptionKey = s3Form.value.encryptionKey;
    if (s3Form.value.s3BackupIntervalHours > 0) {
      payload.s3BackupIntervalHours = s3Form.value.s3BackupIntervalHours;
      if (s3Form.value.s3BackupRetentionDays > 0) payload.s3BackupRetentionDays = s3Form.value.s3BackupRetentionDays;
    }

    const data = await put<{ success: boolean; error?: string }>(
      `/api/databases/${selectedBackupDb.value.id}/s3`,
      payload
    );
    if (data.success) {
      editingS3.value = false;
      await loadS3Config(selectedBackupDb.value.id);
      await loadDatabases(); // refresh card badges
      toast({ title: 'Success', description: 'S3 configuration saved' });
    } else {
      toast({ title: 'Error', description: data.error || 'Failed to save S3 config', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Failed to save S3 config', variant: 'destructive' });
  } finally {
    savingS3.value = false;
  }
}

async function testS3Connection() {
  if (!selectedBackupDb.value) return;
  try {
    testingS3.value = true;
    const data = await post<{ success: boolean; error?: string }>(
      `/api/databases/${selectedBackupDb.value.id}/s3/test`
    );
    if (data.success) {
      toast({ title: 'Success', description: 'S3 connection test passed' });
    } else {
      toast({ title: 'Error', description: data.error || 'S3 connection test failed', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'S3 connection test failed', variant: 'destructive' });
  } finally {
    testingS3.value = false;
  }
}

async function removeS3Config() {
  if (!selectedBackupDb.value) return;
  if (!confirm('Remove S3 configuration? This will disable S3 backups for this database.')) return;
  try {
    removingS3.value = true;
    const data = await del<{ success: boolean; error?: string }>(
      `/api/databases/${selectedBackupDb.value.id}/s3`
    );
    if (data.success) {
      s3Config.value = null;
      await loadDatabases();
      toast({ title: 'Success', description: 'S3 configuration removed' });
    } else {
      toast({ title: 'Error', description: data.error || 'Failed to remove S3 config', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Failed to remove S3 config', variant: 'destructive' });
  } finally {
    removingS3.value = false;
  }
}

// --- Backup actions ---

async function triggerS3Backup() {
  if (!selectedBackupDb.value) return;
  try {
    backingUpS3.value = true;
    const data = await post<{ success: boolean; key?: string; error?: string }>(
      `/api/backups/s3?db=${selectedBackupDb.value.id}`
    );
    if (data.success) {
      toast({ title: 'Success', description: `Backup uploaded: ${data.key}` });
      await loadBackups(selectedBackupDb.value.id);
    } else {
      toast({ title: 'Error', description: data.error || 'S3 backup failed', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'S3 backup failed', variant: 'destructive' });
  } finally {
    backingUpS3.value = false;
  }
}

async function triggerLocalBackup() {
  if (!selectedBackupDb.value) return;
  try {
    backingUpLocal.value = true;
    const data = await post<{ success: boolean; error?: string }>(
      `/automation/backup?db=${selectedBackupDb.value.id}`
    );
    if (data.success) {
      toast({ title: 'Success', description: 'Local backup completed' });
      await loadBackups(selectedBackupDb.value.id);
    } else {
      toast({ title: 'Error', description: data.error || 'Local backup failed', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Local backup failed', variant: 'destructive' });
  } finally {
    backingUpLocal.value = false;
  }
}

async function executeRestore(backup: Backup) {
  if (!selectedBackupDb.value) return;
  if (!confirm(`This will replace the current DuckDB database for "${selectedBackupDb.value.name}" with:\n\n${backup.name}\n\nThis cannot be undone. Continue?`)) return;
  try {
    restoring.value = true;
    const data = await post<{ success: boolean; error?: string }>(
      `/api/backups/s3/restore?db=${selectedBackupDb.value.id}`,
      { key: backup.key }
    );
    if (data.success) {
      toast({ title: 'Success', description: 'Database restored from S3 backup' });
    } else {
      toast({ title: 'Error', description: data.error || 'Restore failed', variant: 'destructive' });
    }
  } catch {
    toast({ title: 'Error', description: 'Restore failed', variant: 'destructive' });
  } finally {
    restoring.value = false;
  }
}

// --- Utilities ---

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
</script>
