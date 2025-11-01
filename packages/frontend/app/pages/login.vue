<script setup lang="ts">
import { ref } from 'vue'

const { login, isAuthenticated, isLoading } = useAuth()
const router = useRouter()

const username = ref('')
const password = ref('')
const error = ref('')

// Redirect if already authenticated
onMounted(async () => {
  const { checkAuth } = useAuth()
  const authenticated = await checkAuth()
  if (authenticated) {
    router.push('/')
  }
})

const handleLogin = async () => {
  error.value = ''

  if (!username.value || !password.value) {
    error.value = 'Please enter username and password'
    return
  }

  const result = await login(username.value, password.value)

  if (result.success) {
    router.push('/')
  } else {
    error.value = result.message
  }
}

const handleKeyPress = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    handleLogin()
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background">
    <div class="w-full max-w-md">
      <div class="bg-card border rounded-lg shadow-lg p-8">
        <div class="text-center mb-8">
          <h1 class="text-3xl font-bold">Duckling</h1>
          <p class="text-muted-foreground mt-2">DuckDB Server Dashboard</p>
        </div>

        <div v-if="error" class="bg-destructive/10 border border-destructive text-destructive-foreground rounded-md p-3 mb-4">
          <p class="text-sm">{{ error }}</p>
        </div>

        <div class="space-y-4">
          <div>
            <label for="username" class="block text-sm font-medium mb-2">
              Username
            </label>
            <input
              id="username"
              v-model="username"
              type="text"
              class="w-full px-3 py-2 border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter username"
              :disabled="isLoading"
              @keypress="handleKeyPress"
            />
          </div>

          <div>
            <label for="password" class="block text-sm font-medium mb-2">
              Password
            </label>
            <input
              id="password"
              v-model="password"
              type="password"
              class="w-full px-3 py-2 border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter password"
              :disabled="isLoading"
              @keypress="handleKeyPress"
            />
          </div>

          <button
            @click="handleLogin"
            :disabled="isLoading"
            class="w-full bg-primary text-primary-foreground py-2 px-4 rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ isLoading ? 'Logging in...' : 'Login' }}
          </button>
        </div>

        <div class="mt-6 text-center text-sm text-muted-foreground">
          <p>Default credentials are configured in your .env file</p>
        </div>
      </div>
    </div>
  </div>
</template>
