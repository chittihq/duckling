<template>
  <div class="p-6 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Backups</h1>
      <p class="text-sm text-muted-foreground">
        ClickHouse-native <code>BACKUP TO S3</code> for
        <span class="font-mono">{{ selectedDatabaseId }}</span>.
        Works against AWS S3 and S3-compatible providers (MinIO, R2, B2, RustFS).
      </p>
    </div>

    <!-- S3 config -->
    <div class="border rounded-lg p-4 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-semibold">S3 destination</h2>
          <p class="text-xs text-muted-foreground">
            Credentials are stored server-side and masked here as <code>***</code>. Re-typing replaces them.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="text-xs px-2 py-1 border rounded hover:bg-accent"
            @click="testConfig"
            :disabled="saving || testing"
          >
            {{ testing ? 'Testing…' : 'Test connection' }}
          </button>
          <button
            class="text-xs px-2 py-1 border rounded hover:bg-accent"
            @click="deleteConfig"
            v-if="hasSavedConfig"
            :disabled="saving"
          >
            Remove config
          </button>
        </div>
      </div>

      <div v-if="configError" class="text-sm text-destructive">{{ configError }}</div>
      <div v-if="testMessage" class="text-sm" :class="testOk ? 'text-green-600' : 'text-destructive'">
        {{ testMessage }}
      </div>

      <div class="grid grid-cols-2 gap-3 text-sm">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Bucket</span>
          <input v-model="form.bucket" class="border rounded px-2 py-1 font-mono text-sm" placeholder="my-duckling-backups"/>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Region</span>
          <input v-model="form.region" class="border rounded px-2 py-1 font-mono text-sm" placeholder="us-east-1"/>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Access key ID</span>
          <input v-model="form.accessKeyId" class="border rounded px-2 py-1 font-mono text-sm" placeholder="AKIA…"/>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Secret access key</span>
          <input v-model="form.secretAccessKey" type="password" class="border rounded px-2 py-1 font-mono text-sm" placeholder="…"/>
        </label>
        <label class="flex flex-col gap-1 col-span-2">
          <span class="text-xs text-muted-foreground">Endpoint (S3-compatible providers only; leave blank for AWS)</span>
          <input v-model="form.endpoint" class="border rounded px-2 py-1 font-mono text-sm" placeholder="https://minio.internal:9000"/>
        </label>
        <label class="flex flex-col gap-1 col-span-2">
          <span class="text-xs text-muted-foreground">Path prefix</span>
          <input v-model="form.pathPrefix" class="border rounded px-2 py-1 font-mono text-sm" :placeholder="`${selectedDatabaseId}/`"/>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Backup every (hours, 0 = manual only)</span>
          <input v-model.number="form.intervalHours" type="number" min="0" class="border rounded px-2 py-1 font-mono text-sm"/>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Retention (days, 0 = keep forever)</span>
          <input v-model.number="form.retentionDays" type="number" min="0" class="border rounded px-2 py-1 font-mono text-sm"/>
        </label>
        <label class="flex items-center gap-2 col-span-2">
          <input v-model="form.enabled" type="checkbox"/>
          <span class="text-sm">Enable scheduled backups</span>
        </label>
      </div>

      <div class="flex justify-end">
        <button
          class="text-sm px-3 py-1.5 border rounded bg-primary text-primary-foreground hover:opacity-90"
          @click="saveConfig"
          :disabled="saving"
        >
          {{ saving ? 'Saving…' : 'Save config' }}
        </button>
      </div>
    </div>

    <!-- Actions -->
    <div class="border rounded-lg p-4 space-y-3" v-if="hasSavedConfig">
      <h2 class="font-semibold">Take a backup now</h2>
      <p class="text-xs text-muted-foreground">
        Runs <code>BACKUP DATABASE ... TO S3(...)</code> immediately. Existing backups beyond
        retention are pruned after a successful run.
      </p>
      <div class="flex gap-2">
        <button
          class="text-sm px-3 py-1.5 border rounded hover:bg-accent"
          @click="takeBackup"
          :disabled="taking"
        >
          {{ taking ? 'Backing up…' : 'Backup now' }}
        </button>
      </div>
      <div v-if="actionMessage" class="text-sm" :class="actionOk ? 'text-green-600' : 'text-destructive'">
        {{ actionMessage }}
      </div>
    </div>

    <!-- Backup history -->
    <div class="border rounded-lg p-4 space-y-3" v-if="hasSavedConfig">
      <div class="flex items-start justify-between">
        <h2 class="font-semibold">Backups in S3</h2>
        <button
          class="text-xs px-2 py-1 border rounded hover:bg-accent"
          @click="refreshBackups"
          :disabled="loadingBackups"
        >
          {{ loadingBackups ? 'Loading…' : 'Refresh' }}
        </button>
      </div>
      <div v-if="backupsError" class="text-sm text-destructive">{{ backupsError }}</div>
      <table v-if="backups.length" class="text-sm w-full">
        <thead class="text-left text-muted-foreground">
          <tr>
            <th class="font-normal pb-1">Name</th>
            <th class="font-normal pb-1">Last modified</th>
            <th class="font-normal pb-1 text-right">Size</th>
            <th class="font-normal pb-1 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in backups" :key="b.key" class="border-t">
            <td class="py-1 font-mono text-xs">{{ b.name }}</td>
            <td class="py-1 text-xs">{{ formatDate(b.lastModified) }}</td>
            <td class="py-1 text-xs text-right">{{ formatBytes(b.sizeBytes) }}</td>
            <td class="py-1 text-right space-x-1">
              <button
                class="text-xs px-2 py-0.5 border rounded hover:bg-accent"
                @click="restoreBackup(b.key)"
                :disabled="restoring === b.key"
              >
                {{ restoring === b.key ? 'Restoring…' : 'Restore' }}
              </button>
              <button
                class="text-xs px-2 py-0.5 border rounded hover:bg-destructive hover:text-destructive-foreground"
                @click="deleteBackup(b.key)"
                :disabled="deleting === b.key"
              >
                {{ deleting === b.key ? 'Deleting…' : 'Delete' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loadingBackups" class="text-xs text-muted-foreground">No backups yet.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted, computed } from 'vue';

definePageMeta({
  middleware: 'auth',
  layout: 'default',
});

type BackupEntry = {
  key: string;
  name: string;
  sizeBytes: number;
  lastModified: string;
};

const { selectedDatabaseId } = useDatabase();
const { get, post, put, del } = useApi();

const form = reactive({
  bucket: '',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  endpoint: '',
  pathPrefix: '',
  intervalHours: 0,
  retentionDays: 0,
  enabled: false,
});

const hasSavedConfig = ref(false);
const saving = ref(false);
const testing = ref(false);
const testOk = ref(false);
const testMessage = ref<string | null>(null);
const configError = ref<string | null>(null);

const backups = ref<BackupEntry[]>([]);
const loadingBackups = ref(false);
const backupsError = ref<string | null>(null);
const taking = ref(false);
const restoring = ref<string | null>(null);
const deleting = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionOk = ref(false);

async function refreshConfig() {
  configError.value = null;
  try {
    const res = await get<{ success: boolean; s3Backup?: any }>(`/api/databases/${selectedDatabaseId.value}/s3-backup`);
    if (res?.s3Backup) {
      hasSavedConfig.value = true;
      form.bucket = res.s3Backup.bucket ?? '';
      form.region = res.s3Backup.region ?? 'us-east-1';
      form.accessKeyId = res.s3Backup.accessKeyId ?? '';
      form.secretAccessKey = res.s3Backup.secretAccessKey ?? '';
      form.endpoint = res.s3Backup.endpoint ?? '';
      form.pathPrefix = res.s3Backup.pathPrefix ?? '';
      form.intervalHours = Number(res.s3Backup.intervalHours ?? 0);
      form.retentionDays = Number(res.s3Backup.retentionDays ?? 0);
      form.enabled = Boolean(res.s3Backup.enabled);
    } else {
      hasSavedConfig.value = false;
    }
  } catch (error: any) {
    configError.value = error?.data?.error ?? error?.message ?? 'failed';
  }
}

async function saveConfig() {
  saving.value = true;
  configError.value = null;
  try {
    await put(`/api/databases/${selectedDatabaseId.value}/s3-backup`, { ...form });
    await refreshConfig();
    await refreshBackups();
  } catch (error: any) {
    configError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    saving.value = false;
  }
}

async function deleteConfig() {
  if (!confirm('Remove the S3 backup config for this database? Existing backups in S3 are not deleted.')) return;
  saving.value = true;
  configError.value = null;
  try {
    await del(`/api/databases/${selectedDatabaseId.value}/s3-backup`);
    await refreshConfig();
    backups.value = [];
  } catch (error: any) {
    configError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    saving.value = false;
  }
}

async function testConfig() {
  testing.value = true;
  testMessage.value = null;
  try {
    const res = await post<{ success: boolean; error?: string }>(
      `/api/databases/${selectedDatabaseId.value}/s3-backup/test`,
      { ...form },
    );
    testOk.value = Boolean(res?.success);
    testMessage.value = res?.success ? 'Bucket reachable — credentials OK.' : `Failed: ${res?.error ?? 'unknown'}`;
  } catch (error: any) {
    testOk.value = false;
    testMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    testing.value = false;
  }
}

async function refreshBackups() {
  loadingBackups.value = true;
  backupsError.value = null;
  try {
    const res = await get<{ success: boolean; backups: BackupEntry[] }>(
      `/api/databases/${selectedDatabaseId.value}/backups`,
    );
    backups.value = res?.backups ?? [];
  } catch (error: any) {
    backupsError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    loadingBackups.value = false;
  }
}

async function takeBackup() {
  taking.value = true;
  actionMessage.value = null;
  try {
    const res = await post<{ success: boolean; backup?: any; pruned?: string[] }>(
      `/api/databases/${selectedDatabaseId.value}/backups`,
    );
    actionOk.value = Boolean(res?.success);
    const pruned = res?.pruned?.length ? ` (pruned ${res.pruned.length} old)` : '';
    actionMessage.value = `Backup ${res?.backup?.name} completed in ${Math.round((res?.backup?.durationMs ?? 0) / 1000)}s${pruned}.`;
    await refreshBackups();
  } catch (error: any) {
    actionOk.value = false;
    actionMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    taking.value = false;
  }
}

async function restoreBackup(key: string) {
  if (!confirm(`Restore from ${key}? Existing ClickHouse database will be replaced.`)) return;
  restoring.value = key;
  actionMessage.value = null;
  try {
    const res = await post<{ success: boolean; restore?: any }>(
      `/api/databases/${selectedDatabaseId.value}/backups/restore`,
      { key },
    );
    actionOk.value = Boolean(res?.success);
    actionMessage.value = `Restore from ${key} completed in ${Math.round((res?.restore?.durationMs ?? 0) / 1000)}s.`;
  } catch (error: any) {
    actionOk.value = false;
    actionMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    restoring.value = null;
  }
}

async function deleteBackup(key: string) {
  if (!confirm(`Delete backup ${key}? This removes every object under the prefix.`)) return;
  deleting.value = key;
  actionMessage.value = null;
  try {
    const res = await del<{ success: boolean; deletedObjects?: number }>(
      `/api/databases/${selectedDatabaseId.value}/backups?key=${encodeURIComponent(key)}`,
    );
    actionOk.value = Boolean(res?.success);
    actionMessage.value = `Deleted ${res?.deletedObjects ?? 0} object(s).`;
    await refreshBackups();
  } catch (error: any) {
    actionOk.value = false;
    actionMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    deleting.value = null;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

watch(selectedDatabaseId, () => {
  void refreshConfig();
  void refreshBackups();
});

onMounted(() => {
  void refreshConfig();
  void refreshBackups();
});
</script>
