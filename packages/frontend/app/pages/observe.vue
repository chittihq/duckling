<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler)

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const { get } = useApi()

// ─── System metrics ────────────────────────────────────────────────
interface SystemCurrent {
  cpuPercent: number
  rssMB: number
  heapUsedMB: number
  hostFreeMemMB: number
  hostTotalMemMB: number
  eventLoopLagMs: number
}
interface SystemSample { ts: string; cpuPercent: number; rssMB: number; eventLoopLagMs: number }
interface SystemPayload { current: SystemCurrent; history: SystemSample[] }

const systemCurrent = ref<SystemCurrent | null>(null)
const systemHistory = ref<SystemSample[]>([])
const systemError = ref('')

const fetchSystem = async () => {
  try {
    const data = await get<SystemPayload>('/api/metrics/system')
    systemCurrent.value = data.current
    systemHistory.value = data.history
    systemError.value = ''
  } catch (e: any) {
    systemError.value = e.message || 'Failed to load system metrics'
  }
}

// ─── Query metrics ─────────────────────────────────────────────────
interface ActiveQuery { id: string; sql: string; startedAt: string; runningSec: number; databaseId: string }
interface PatternStat { pattern: string; count: number; avgMs: number; minMs: number; maxMs: number; lastRun: string }
interface QueryPayload { active: ActiveQuery[]; totalExecuted: number; patterns: PatternStat[] }

const totalExecuted = ref(0)
const activeQueries = ref<ActiveQuery[]>([])
const patterns = ref<PatternStat[]>([])
const queryError = ref('')
const patternFilter = ref('')

const fetchQueries = async () => {
  try {
    const data = await get<QueryPayload>('/api/metrics/queries')
    totalExecuted.value = data.totalExecuted
    activeQueries.value = data.active
    patterns.value = data.patterns
    queryError.value = ''
  } catch (e: any) {
    queryError.value = e.message || 'Failed to load query metrics'
  }
}

const filteredPatterns = computed(() => {
  if (!patternFilter.value) return patterns.value
  const q = patternFilter.value.toLowerCase()
  return patterns.value.filter(p => p.pattern.toLowerCase().includes(q))
})

// ─── Charts ────────────────────────────────────────────────────────
const chartLabels = computed(() =>
  systemHistory.value.map(s => {
    const d = new Date(s.ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  })
)

const cpuChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [{
    label: 'CPU %',
    data: systemHistory.value.map(s => s.cpuPercent),
    borderColor: '#3b82f6',
    backgroundColor: 'rgba(59,130,246,0.1)',
    fill: true,
    tension: 0.3,
    pointRadius: 0,
  }]
}))

const memChartData = computed(() => ({
  labels: chartLabels.value,
  datasets: [{
    label: 'RSS MB',
    data: systemHistory.value.map(s => s.rssMB),
    borderColor: '#10b981',
    backgroundColor: 'rgba(16,185,129,0.1)',
    fill: true,
    tension: 0.3,
    pointRadius: 0,
  }]
}))

const cpuChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: { y: { beginAtZero: true, suggestedMax: 100, title: { display: true, text: '%' } } },
  plugins: { tooltip: { mode: 'index' as const, intersect: false } },
  animation: { duration: 0 },
}

const memChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  scales: { y: { beginAtZero: true, title: { display: true, text: 'MB' } } },
  plugins: { tooltip: { mode: 'index' as const, intersect: false } },
  animation: { duration: 0 },
}

// ─── Polling ───────────────────────────────────────────────────────
let systemTimer: ReturnType<typeof setInterval> | null = null
let queryTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([fetchSystem(), fetchQueries()])
  systemTimer = setInterval(fetchSystem, 30_000)
  queryTimer = setInterval(fetchQueries, 5_000)
})

onBeforeUnmount(() => {
  if (systemTimer) clearInterval(systemTimer)
  if (queryTimer) clearInterval(queryTimer)
})

const formatDate = (iso: string) => new Date(iso).toLocaleString()
</script>

<template>
  <div class="h-full overflow-y-auto p-6 space-y-8">
    <h1 class="text-2xl font-bold">Observability</h1>

    <!-- ─── System Resources ──────────────────────────────────────── -->
    <section>
      <h2 class="text-lg font-semibold mb-4">System Resources</h2>
      <p v-if="systemError" class="text-destructive text-sm mb-2">{{ systemError }}</p>

      <!-- Current values -->
      <div v-if="systemCurrent" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-xs text-muted-foreground">CPU</p>
          <p class="text-2xl font-bold">{{ systemCurrent.cpuPercent }}%</p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-xs text-muted-foreground">RSS Memory</p>
          <p class="text-2xl font-bold">{{ systemCurrent.rssMB }} MB</p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-xs text-muted-foreground">Heap Used</p>
          <p class="text-2xl font-bold">{{ systemCurrent.heapUsedMB }} MB</p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-xs text-muted-foreground">Event Loop Lag</p>
          <p class="text-2xl font-bold">{{ systemCurrent.eventLoopLagMs }} ms</p>
        </div>
      </div>

      <!-- Charts -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="rounded-lg border bg-card p-4" style="height:260px">
          <Line v-if="systemHistory.length" :data="cpuChartData" :options="cpuChartOptions" />
          <p v-else class="text-muted-foreground text-sm pt-16 text-center">Waiting for samples…</p>
        </div>
        <div class="rounded-lg border bg-card p-4" style="height:260px">
          <Line v-if="systemHistory.length" :data="memChartData" :options="memChartOptions" />
          <p v-else class="text-muted-foreground text-sm pt-16 text-center">Waiting for samples…</p>
        </div>
      </div>
    </section>

    <!-- ─── Active Queries ────────────────────────────────────────── -->
    <section>
      <h2 class="text-lg font-semibold mb-2">Active Queries</h2>
      <p v-if="queryError" class="text-destructive text-sm mb-2">{{ queryError }}</p>

      <div class="flex gap-6 mb-3 text-sm">
        <span class="text-muted-foreground">Total Executed: <strong class="text-foreground">{{ totalExecuted.toLocaleString() }}</strong></span>
        <span class="text-muted-foreground">Active Now: <strong class="text-foreground">{{ activeQueries.length }}</strong></span>
      </div>

      <div class="rounded-lg border overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-muted/50">
            <tr>
              <th class="px-3 py-2 text-left font-medium">SQL</th>
              <th class="px-3 py-2 text-left font-medium">Database</th>
              <th class="px-3 py-2 text-right font-medium">Running&nbsp;for</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!activeQueries.length">
              <td colspan="3" class="px-3 py-4 text-center text-muted-foreground">No active queries</td>
            </tr>
            <tr v-for="q in activeQueries" :key="q.id" class="border-t">
              <td class="px-3 py-2 font-mono text-xs max-w-md truncate">{{ q.sql }}</td>
              <td class="px-3 py-2">{{ q.databaseId }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ q.runningSec }}s</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ─── Query Performance ─────────────────────────────────────── -->
    <section>
      <h2 class="text-lg font-semibold mb-2">Query Performance</h2>

      <input
        v-model="patternFilter"
        type="text"
        placeholder="Filter patterns…"
        class="mb-3 w-full max-w-sm rounded-md border bg-background px-3 py-1.5 text-sm"
      />

      <div class="rounded-lg border overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-muted/50">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Query Pattern</th>
              <th class="px-3 py-2 text-right font-medium">Executions</th>
              <th class="px-3 py-2 text-right font-medium">Avg&nbsp;ms</th>
              <th class="px-3 py-2 text-right font-medium">Min&nbsp;ms</th>
              <th class="px-3 py-2 text-right font-medium">Max&nbsp;ms</th>
              <th class="px-3 py-2 text-left font-medium">Last&nbsp;Run</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filteredPatterns.length">
              <td colspan="6" class="px-3 py-4 text-center text-muted-foreground">No query patterns recorded yet</td>
            </tr>
            <tr v-for="p in filteredPatterns" :key="p.pattern" class="border-t">
              <td class="px-3 py-2 font-mono text-xs max-w-lg truncate">{{ p.pattern }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ p.count.toLocaleString() }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ p.avgMs }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ p.minMs }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ p.maxMs }}</td>
              <td class="px-3 py-2 whitespace-nowrap">{{ formatDate(p.lastRun) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
