<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  /** Table names (optionally table -> columns) used for autocompletion. */
  tables?: string[]
}>(), {
  placeholder: '',
  tables: () => [],
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'run'): void
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

const langCompartment = new Compartment()

function sqlExtension() {
  const schema: Record<string, string[]> = {}
  for (const table of props.tables) {
    schema[table] = []
  }
  return sql({ schema, upperCaseKeywords: true })
}

// Style the editor with the app's design tokens so it matches shadcn inputs
// (and follows the .dark palette automatically if a theme toggle ever lands).
const theme = EditorView.theme({
  '&': {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    border: '1px solid hsl(var(--input))',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontSize: '0.875rem',
    minHeight: '7rem',
    maxHeight: '20rem',
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'hsl(var(--ring))',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '0.5rem 0',
    caretColor: 'hsl(var(--foreground))',
  },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
    border: 'none',
    borderTopLeftRadius: 'calc(var(--radius) - 2px)',
    borderBottomLeftRadius: 'calc(var(--radius) - 2px)',
  },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--accent) / 0.5)' },
  '.cm-activeLineGutter': { backgroundColor: 'hsl(var(--accent))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--primary) / 0.15)',
  },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 'calc(var(--radius) - 2px)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'hsl(var(--accent))',
    color: 'hsl(var(--accent-foreground))',
  },
})

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langCompartment.of(sqlExtension()),
        cmPlaceholder(props.placeholder),
        theme,
        keymap.of([
          // Run bindings first so Mod-Enter isn't swallowed by newline insertion.
          {
            key: 'Mod-Enter',
            run: () => {
              emit('run')
              return true
            },
          },
          {
            key: 'Ctrl-Enter',
            run: () => {
              emit('run')
              return true
            },
          },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            emit('update:modelValue', update.state.doc.toString())
          }
        }),
      ],
    }),
  })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// External writes (example queries, clear button) → editor.
watch(() => props.modelValue, (value) => {
  if (view && value !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }
})

// Refresh completion schema when the table list (re)loads.
watch(() => props.tables, () => {
  view?.dispatch({ effects: langCompartment.reconfigure(sqlExtension()) })
}, { deep: true })

defineExpose({
  focus: () => view?.focus(),
})
</script>

<template>
  <div ref="host" class="sql-editor" />
</template>

<style scoped>
.sql-editor :deep(.cm-editor) {
  width: 100%;
}
</style>
