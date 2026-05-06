import { ref, computed } from 'vue';

interface Database {
  id: string;
  name: string;
  mysqlConnectionString: string;
  duckdbPath: string;
  clickhouseDatabase?: string;
  createdAt: string;
  updatedAt: string;
}

const selectedDatabaseId = ref<string>('default');
const databases = ref<Database[]>([]);

export function useDatabase() {
  // Load selected database from localStorage
  if (process.client) {
    const stored = localStorage.getItem('selectedDatabase');
    if (stored) {
      selectedDatabaseId.value = stored;
    }
  }

  const selectedDatabase = computed(() => {
    return databases.value.find(db => db.id === selectedDatabaseId.value);
  });

  function setDatabase(id: string) {
    selectedDatabaseId.value = id;
    if (process.client) {
      localStorage.setItem('selectedDatabase', id);
    }
  }

  async function loadDatabases() {
    try {
      const { get } = useApi();
      const data = await get<{ success: boolean; databases: Database[] }>('/api/databases');

      if (data.success) {
        databases.value = data.databases;

        // If no database is selected or the selected one doesn't exist, select the first one
        if (!selectedDatabaseId.value || !databases.value.find(db => db.id === selectedDatabaseId.value)) {
          if (databases.value.length > 0) {
            setDatabase(databases.value[0].id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load databases:', error);
    }
  }

  function getApiUrlWithDatabase(path: string): string {
    return `${path}${path.includes('?') ? '&' : '?'}db=${selectedDatabaseId.value}`;
  }

  return {
    selectedDatabaseId: computed(() => selectedDatabaseId.value),
    selectedDatabase,
    databases: computed(() => databases.value),
    setDatabase,
    loadDatabases,
    getApiUrlWithDatabase
  };
}
