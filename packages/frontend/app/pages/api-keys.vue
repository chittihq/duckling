<template>
  <div class="p-6 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">API Keys</h1>
      <p class="text-sm text-muted-foreground">
        Per-database keys for
        <span class="font-mono">{{ selectedDatabaseId }}</span>.
        A key created here can only access this database's data (queries, sync, CDC) — it
        cannot reach other databases or change configuration. Send it as
        <code>Authorization: Bearer dk_…</code>.
      </p>
    </div>

    <!-- Create -->
    <div class="border rounded-lg p-4 space-y-3">
      <div class="flex items-end gap-3 flex-wrap">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Name</span>
          <input
            v-model="newName"
            class="border rounded px-2 py-1 text-sm w-64"
            placeholder="e.g. Metabase, CI pipeline"
            @keyup.enter="createKey"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Expires (optional)</span>
          <input v-model="newExpiry" type="date" class="border rounded px-2 py-1 text-sm" />
        </label>
        <button
          class="text-sm px-3 py-1.5 border rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          :disabled="creating || !newName.trim()"
          @click="createKey"
        >
          {{ creating ? 'Creating…' : 'Create key' }}
        </button>
      </div>
      <div v-if="createError" class="text-sm text-destructive">{{ createError }}</div>

      <!-- One-time secret reveal -->
      <div v-if="revealed" class="border border-green-600/40 bg-green-600/5 rounded p-3 space-y-2">
        <p class="text-sm font-medium text-green-700">
          Copy this key now — it is shown only once and cannot be recovered.
        </p>
        <div class="flex items-center gap-2">
          <code class="font-mono text-sm break-all bg-muted px-2 py-1 rounded flex-1">{{ revealed }}</code>
          <button class="text-xs px-2 py-1 border rounded hover:bg-accent" @click="copyRevealed">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <button class="text-xs px-2 py-1 border rounded hover:bg-accent" @click="revealed = null">
            Dismiss
          </button>
        </div>
      </div>
    </div>

    <!-- List -->
    <div class="border rounded-lg p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">Existing keys</h2>
        <button class="text-xs px-2 py-1 border rounded hover:bg-accent" @click="refresh" :disabled="loading">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>
      <div v-if="listError" class="text-sm text-destructive">{{ listError }}</div>
      <div v-if="actionMessage" class="text-sm" :class="actionOk ? 'text-green-600' : 'text-destructive'">
        {{ actionMessage }}
      </div>

      <table v-if="keys.length" class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs text-muted-foreground border-b">
            <th class="py-2 font-medium">Name</th>
            <th class="py-2 font-medium">Key</th>
            <th class="py-2 font-medium">Created</th>
            <th class="py-2 font-medium">Last used</th>
            <th class="py-2 font-medium">Expires</th>
            <th class="py-2 font-medium">Status</th>
            <th class="py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id" class="border-b last:border-0">
            <td class="py-2">{{ k.name }}</td>
            <td class="py-2 font-mono text-xs text-muted-foreground">dk_…{{ k.last4 }}</td>
            <td class="py-2 text-xs">{{ fmt(k.createdAt) }}</td>
            <td class="py-2 text-xs">{{ k.lastUsedAt ? fmt(k.lastUsedAt) : '—' }}</td>
            <td class="py-2 text-xs" :class="isExpired(k) ? 'text-destructive' : ''">
              {{ k.expiresAt ? fmt(k.expiresAt) : '—' }}
            </td>
            <td class="py-2">
              <span
                class="text-xs px-2 py-0.5 rounded"
                :class="statusClass(k)"
              >{{ statusLabel(k) }}</span>
            </td>
            <td class="py-2 text-right whitespace-nowrap">
              <button
                class="text-xs px-2 py-1 border rounded hover:bg-accent"
                :disabled="busyId === k.id"
                @click="toggle(k)"
              >
                {{ k.enabled ? 'Disable' : 'Enable' }}
              </button>
              <button
                class="text-xs px-2 py-1 border rounded hover:bg-accent text-destructive ml-1"
                :disabled="busyId === k.id"
                @click="revoke(k)"
              >
                Revoke
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loading" class="text-sm text-muted-foreground">No API keys yet for this database.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

definePageMeta({
  middleware: 'auth',
  layout: 'default',
});

type ApiKey = {
  id: string;
  name: string;
  last4: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  enabled: boolean;
};

const { selectedDatabaseId } = useDatabase();
const { get, post, patch, delete: del } = useApi();

const keys = ref<ApiKey[]>([]);
const loading = ref(false);
const listError = ref<string | null>(null);

const newName = ref('');
const newExpiry = ref('');
const creating = ref(false);
const createError = ref<string | null>(null);
const revealed = ref<string | null>(null);
const copied = ref(false);

const busyId = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionOk = ref(false);

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isExpired(k: ApiKey): boolean {
  return !!k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
}

function statusLabel(k: ApiKey): string {
  if (!k.enabled) return 'Disabled';
  if (isExpired(k)) return 'Expired';
  return 'Active';
}

function statusClass(k: ApiKey): string {
  if (!k.enabled) return 'bg-muted text-muted-foreground';
  if (isExpired(k)) return 'bg-destructive/10 text-destructive';
  return 'bg-green-600/10 text-green-700';
}

async function refresh() {
  loading.value = true;
  listError.value = null;
  try {
    const res = await get<{ success: boolean; apiKeys?: ApiKey[] }>(
      `/api/databases/${selectedDatabaseId.value}/api-keys`,
    );
    keys.value = res?.apiKeys ?? [];
  } catch (error: any) {
    listError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    loading.value = false;
  }
}

async function createKey() {
  if (!newName.value.trim()) return;
  creating.value = true;
  createError.value = null;
  revealed.value = null;
  copied.value = false;
  try {
    const body: Record<string, unknown> = { name: newName.value.trim() };
    if (newExpiry.value) {
      // <input type=date> yields YYYY-MM-DD; send end-of-day UTC.
      body.expiresAt = new Date(`${newExpiry.value}T23:59:59.000Z`).toISOString();
    }
    const res = await post<{ success: boolean; secret?: string }>(
      `/api/databases/${selectedDatabaseId.value}/api-keys`,
      body,
    );
    revealed.value = res?.secret ?? null;
    newName.value = '';
    newExpiry.value = '';
    await refresh();
  } catch (error: any) {
    createError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    creating.value = false;
  }
}

async function copyRevealed() {
  if (!revealed.value) return;
  try {
    await navigator.clipboard.writeText(revealed.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard blocked; user can select manually */
  }
}

async function toggle(k: ApiKey) {
  busyId.value = k.id;
  actionMessage.value = null;
  try {
    await patch(`/api/databases/${selectedDatabaseId.value}/api-keys/${k.id}`, {
      enabled: !k.enabled,
    });
    actionOk.value = true;
    actionMessage.value = `${k.name} ${k.enabled ? 'disabled' : 'enabled'}.`;
    await refresh();
  } catch (error: any) {
    actionOk.value = false;
    actionMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    busyId.value = null;
  }
}

async function revoke(k: ApiKey) {
  if (!confirm(`Revoke "${k.name}"? Any client using it will immediately lose access. This cannot be undone.`)) return;
  busyId.value = k.id;
  actionMessage.value = null;
  try {
    await del(`/api/databases/${selectedDatabaseId.value}/api-keys/${k.id}`);
    actionOk.value = true;
    actionMessage.value = `${k.name} revoked.`;
    await refresh();
  } catch (error: any) {
    actionOk.value = false;
    actionMessage.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    busyId.value = null;
  }
}

onMounted(refresh);
watch(selectedDatabaseId, () => {
  revealed.value = null;
  actionMessage.value = null;
  refresh();
});
</script>
