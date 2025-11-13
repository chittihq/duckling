<script setup lang="ts">
import { ref } from 'vue'

definePageMeta({
  layout: false
})

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
      <Card class="shadow-lg">
        <CardHeader class="text-center">
          <CardTitle class="text-3xl">Duckling</CardTitle>
          <CardDescription>DuckDB Server Dashboard</CardDescription>
        </CardHeader>

        <CardContent class="space-y-4">
          <div v-if="error" class="bg-destructive/10 border border-destructive text-destructive-foreground rounded-md p-3">
            <p class="text-sm">{{ error }}</p>
          </div>

          <div class="space-y-2">
            <label for="username" class="block text-sm font-medium">
              Username
            </label>
            <Input
              id="username"
              v-model="username"
              type="text"
              placeholder="Enter username"
              :disabled="isLoading"
              @keypress="handleKeyPress"
            />
          </div>

          <div class="space-y-2">
            <label for="password" class="block text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              v-model="password"
              type="password"
              placeholder="Enter password"
              :disabled="isLoading"
              @keypress="handleKeyPress"
            />
          </div>

          <Button
            @click="handleLogin"
            :disabled="isLoading"
            class="w-full"
            size="sm"
          >
            {{ isLoading ? 'Logging in...' : 'Login' }}
          </Button>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
