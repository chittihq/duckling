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
                <Button
                  v-if="db.id !== 'default'"
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { toast } from '@/components/ui/toast';

interface Database {
  id: string;
  name: string;
  mysqlConnectionString: string;
  duckdbPath: string;
  createdAt: string;
  updatedAt: string;
}

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
const { get, post, put, delete: del } = useApi()

onMounted(() => {
  loadDatabases();
});

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
  } catch (err) {
    error.value = 'Failed to load databases';
    console.error(err);
  } finally {
    loading.value = false;
  }
}

function editDatabase(db: Database) {
  editingDb.value = db;
  formData.value = {
    name: db.name,
    mysqlConnectionString: db.mysqlConnectionString
  };
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
      toast({
        title: 'Success',
        description: 'Database saved successfully'
      });
    } else {
      toast({
        title: 'Error',
        description: data.error || 'Failed to save database',
        variant: 'destructive'
      });
    }
  } catch (err) {
    toast({
      title: 'Error',
      description: 'Failed to save database',
      variant: 'destructive'
    });
    console.error(err);
  } finally {
    saving.value = false;
  }
}

async function deleteDatabase(id: string) {
  if (!confirm('Are you sure you want to delete this database?')) {
    return;
  }

  try {
    deleting.value = id;

    const data = await del<{ success: boolean; error?: string }>(`/api/databases/${id}`);

    if (data.success) {
      await loadDatabases();
      toast({
        title: 'Success',
        description: 'Database deleted successfully'
      });
    } else {
      toast({
        title: 'Error',
        description: data.error || 'Failed to delete database',
        variant: 'destructive'
      });
    }
  } catch (err) {
    toast({
      title: 'Error',
      description: 'Failed to delete database',
      variant: 'destructive'
    });
    console.error(err);
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
      toast({
        title: 'Success',
        description: 'Connection test successful'
      });
    } else {
      toast({
        title: 'Error',
        description: data.error || 'Failed to test connection',
        variant: 'destructive'
      });
    }
  } catch (err) {
    toast({
      title: 'Error',
      description: 'Failed to test connection',
      variant: 'destructive'
    });
    console.error(err);
  } finally {
    testing.value = '';
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}
</script>
