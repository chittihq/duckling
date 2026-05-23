<template>
  <div class="p-6 space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Replication</h1>
      <p class="text-sm text-muted-foreground">
        Phase 1 (bootstrap dump) + Phase 2 (PeerDB CDC or in-repo polling) for
        <span class="font-mono">{{ selectedDatabaseId }}</span>.
        See <code>docs/replication-strategy.md</code>.
      </p>
    </div>

    <!-- Replication mode -->
    <div class="border rounded-lg p-4 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-semibold">Mode</h2>
          <p class="text-xs text-muted-foreground">
            Effective Phase-2 backend, auto-selected from the capability probe unless an operator pinned it.
          </p>
        </div>
        <button
          class="text-xs px-2 py-1 border rounded hover:bg-accent"
          @click="refreshMode"
          :disabled="modeLoading"
        >
          {{ modeLoading ? 'Probing…' : 'Re-probe' }}
        </button>
      </div>

      <div v-if="modeError" class="text-sm text-destructive">{{ modeError }}</div>
      <div v-else-if="mode" class="text-sm space-y-2">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-xs text-muted-foreground">Effective mode</div>
            <div class="font-mono text-base">{{ mode.effectiveMode }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Pinned mode</div>
            <div class="font-mono text-base">{{ mode.pinnedMode ?? 'auto' }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">CDC supported by source</div>
            <div :class="mode.capability.cdcSupported ? 'text-green-600 font-medium' : 'text-yellow-600 font-medium'">
              {{ mode.capability.cdcSupported ? 'yes' : 'no' }}
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Recommended</div>
            <div class="font-mono text-base">{{ mode.capability.recommendedMode }}</div>
          </div>
        </div>

        <div>
          <div class="text-xs text-muted-foreground mb-1">Probe reasons</div>
          <ul class="text-xs list-disc pl-5 space-y-0.5">
            <li v-for="reason in mode.capability.reasons" :key="reason">{{ reason }}</li>
          </ul>
        </div>

        <div v-if="mode.capability.knownBlockers?.length">
          <div class="text-xs text-muted-foreground mb-1">Known blockers</div>
          <div
            v-for="blocker in mode.capability.knownBlockers"
            :key="blocker.id"
            class="text-xs border-l-2 pl-2 mt-1"
            :class="{
              'border-yellow-500': blocker.severity === 'warn',
              'border-red-500': blocker.severity === 'error',
              'border-blue-500': blocker.severity === 'info',
            }"
          >
            <span class="font-mono font-medium">{{ blocker.id }}</span>
            <span class="text-muted-foreground"> ({{ blocker.severity }})</span>:
            {{ blocker.message }}
            <a
              v-if="blocker.reference"
              :href="`https://github.com/chittihq/duckling/blob/main/${blocker.reference}`"
              target="_blank"
              rel="noopener"
              class="text-blue-500 underline"
            >ref</a>
          </div>
        </div>

        <details class="text-xs">
          <summary class="cursor-pointer text-muted-foreground">Raw MySQL variables</summary>
          <pre class="mt-1 p-2 bg-muted rounded overflow-x-auto">{{ JSON.stringify(mode.capability.variables, null, 2) }}</pre>
        </details>

        <div class="flex gap-2 pt-2">
          <button
            v-for="m in ['auto', 'peerdb', 'polling', 'none']"
            :key="m"
            class="text-xs px-2 py-1 border rounded hover:bg-accent"
            :class="{ 'bg-accent': (mode.pinnedMode ?? 'auto') === m }"
            @click="pinMode(m as any)"
            :disabled="pinning"
          >
            Pin: {{ m }}
          </button>
        </div>
      </div>
      <div v-else class="text-sm text-muted-foreground">Loading…</div>
    </div>

    <!-- Bootstrap -->
    <div class="border rounded-lg p-4 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-semibold">Bootstrap (Phase 1)</h2>
          <p class="text-xs text-muted-foreground">
            Duckling captures the source binlog position and dumps every table into ClickHouse.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            class="text-xs px-2 py-1 border rounded hover:bg-accent"
            @click="runBootstrap({ resume: true, startPhase2: false })"
            :disabled="bootstrapRunning"
          >
            Resume
          </button>
          <button
            class="text-xs px-2 py-1 border rounded hover:bg-accent"
            @click="runBootstrap({ force: true, startPhase2: true })"
            :disabled="bootstrapRunning"
          >
            {{ bootstrapRunning ? 'Running…' : 'Re-run + start' }}
          </button>
        </div>
      </div>

      <div v-if="bootstrapError" class="text-sm text-destructive">{{ bootstrapError }}</div>
      <div v-if="bootstrap" class="text-sm space-y-2">
        <div class="grid grid-cols-3 gap-3">
          <div>
            <div class="text-xs text-muted-foreground">Status</div>
            <div
              class="font-mono text-base"
              :class="{
                'text-green-600': bootstrap.status === 'completed',
                'text-yellow-600': bootstrap.status === 'in_progress' || bootstrap.status === 'pending',
                'text-red-600': bootstrap.status === 'failed',
              }"
            >{{ bootstrap.status }}</div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Binlog position</div>
            <div class="font-mono text-xs">
              <span v-if="bootstrap.binlogPosition?.mode === 'gtid'">gtid: {{ bootstrap.binlogPosition.gtid }}</span>
              <span v-else-if="bootstrap.binlogPosition?.mode === 'filepos'">
                {{ bootstrap.binlogPosition.file }}:{{ bootstrap.binlogPosition.position }}
              </span>
              <span v-else class="text-muted-foreground">(none)</span>
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">Completed</div>
            <div class="text-xs">{{ bootstrap.completedAt ?? '—' }}</div>
          </div>
        </div>

        <div v-if="bootstrap.error" class="text-xs text-destructive">
          Error: {{ bootstrap.error }}
        </div>

        <div v-if="bootstrap.tableProgress && Object.keys(bootstrap.tableProgress).length">
          <div class="text-xs text-muted-foreground mb-1">Per-table progress</div>
          <table class="text-xs w-full">
            <thead class="text-left text-muted-foreground">
              <tr>
                <th class="font-normal pb-1">Table</th>
                <th class="font-normal pb-1">Status</th>
                <th class="font-normal pb-1 text-right">Rows</th>
                <th class="font-normal pb-1">Error</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(progress, name) in bootstrap.tableProgress"
                :key="name"
                class="border-t"
              >
                <td class="font-mono py-1">{{ name }}</td>
                <td
                  class="py-1"
                  :class="{
                    'text-green-600': progress.status === 'completed',
                    'text-yellow-600': progress.status === 'in_progress' || progress.status === 'pending',
                    'text-red-600': progress.status === 'failed',
                  }"
                >{{ progress.status }}</td>
                <td class="text-right py-1">{{ progress.recordsProcessed.toLocaleString() }}</td>
                <td class="text-destructive py-1 text-xs">{{ progress.error ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Phase 2 control -->
    <div class="border rounded-lg p-4 space-y-3">
      <h2 class="font-semibold">Continuous replication (Phase 2)</h2>
      <p class="text-xs text-muted-foreground">
        Start / stop the configured backend. Start is idempotent — re-running just resumes.
      </p>
      <div class="flex gap-2">
        <button
          class="text-xs px-2 py-1 border rounded hover:bg-accent"
          @click="startPhase2"
          :disabled="phase2Running"
        >
          {{ phase2Running ? 'Starting…' : 'Start' }}
        </button>
        <button
          class="text-xs px-2 py-1 border rounded hover:bg-accent"
          @click="stopPhase2"
          :disabled="phase2Running"
        >
          Stop
        </button>
      </div>
      <div v-if="phase2Message" class="text-sm">{{ phase2Message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';

definePageMeta({
  middleware: 'auth',
  layout: 'default',
});

const { selectedDatabaseId } = useDatabase();
const { get, post } = useApi();

type Capability = {
  recommendedMode: 'peerdb' | 'polling';
  cdcSupported: boolean;
  reasons: string[];
  variables: Record<string, string | null>;
  grants: string[];
  knownBlockers: Array<{ id: string; severity: 'info' | 'warn' | 'error'; message: string; reference?: string }>;
};

type ReplicationModeResponse = {
  success: boolean;
  pinnedMode: 'peerdb' | 'polling' | 'none' | null;
  effectiveMode: 'peerdb' | 'polling' | 'none';
  capability: Capability;
};

type BootstrapResponse = {
  success: boolean;
  bootstrap: {
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
    binlogPosition?: { mode: 'gtid' | 'filepos'; gtid?: string; file?: string; position?: number };
    tableProgress: Record<string, { status: string; recordsProcessed: number; error?: string }>;
    error?: string;
  };
};

const mode = ref<ReplicationModeResponse | null>(null);
const modeError = ref<string | null>(null);
const modeLoading = ref(false);
const pinning = ref(false);

const bootstrap = ref<BootstrapResponse['bootstrap'] | null>(null);
const bootstrapError = ref<string | null>(null);
const bootstrapRunning = ref(false);

const phase2Running = ref(false);
const phase2Message = ref<string | null>(null);

async function refreshMode() {
  modeLoading.value = true;
  modeError.value = null;
  try {
    mode.value = await get<ReplicationModeResponse>(`/api/databases/${selectedDatabaseId.value}/replication-mode`);
  } catch (error: any) {
    modeError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    modeLoading.value = false;
  }
}

async function refreshBootstrap() {
  bootstrapError.value = null;
  try {
    const res = await get<BootstrapResponse>(`/api/databases/${selectedDatabaseId.value}/bootstrap/status`);
    bootstrap.value = res.bootstrap;
  } catch (error: any) {
    bootstrapError.value = error?.data?.error ?? error?.message ?? 'failed';
  }
}

async function pinMode(m: 'auto' | 'peerdb' | 'polling' | 'none') {
  pinning.value = true;
  try {
    await post(`/api/databases/${selectedDatabaseId.value}/replication-mode`, { mode: m });
    await refreshMode();
  } finally {
    pinning.value = false;
  }
}

async function runBootstrap(options: { force?: boolean; resume?: boolean; startPhase2?: boolean }) {
  bootstrapRunning.value = true;
  bootstrapError.value = null;
  try {
    await post(`/api/databases/${selectedDatabaseId.value}/bootstrap`, options);
    await refreshBootstrap();
    await refreshMode();
  } catch (error: any) {
    bootstrapError.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    bootstrapRunning.value = false;
  }
}

async function startPhase2() {
  phase2Running.value = true;
  phase2Message.value = null;
  try {
    const res = await post<{ message: string }>(`/cdc/start?db=${selectedDatabaseId.value}`);
    phase2Message.value = res.message;
    await refreshMode();
  } catch (error: any) {
    phase2Message.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    phase2Running.value = false;
  }
}

async function stopPhase2() {
  phase2Running.value = true;
  phase2Message.value = null;
  try {
    const res = await post<{ message: string }>(`/cdc/stop?db=${selectedDatabaseId.value}`);
    phase2Message.value = res.message;
  } catch (error: any) {
    phase2Message.value = error?.data?.error ?? error?.message ?? 'failed';
  } finally {
    phase2Running.value = false;
  }
}

watch(selectedDatabaseId, () => {
  void refreshMode();
  void refreshBootstrap();
});

onMounted(() => {
  void refreshMode();
  void refreshBootstrap();
});
</script>
