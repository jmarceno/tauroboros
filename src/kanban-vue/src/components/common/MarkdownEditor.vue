<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed, defineExpose } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import CodeBlock from '@tiptap/extension-code-block'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'keydown': [event: KeyboardEvent]
}>()

// Track if we're currently setting content to avoid circular updates
let isSettingContent = false

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      codeBlock: false,
      // StarterKit includes bold, italic, strike, bulletList, orderedList, blockquote, code
      // but NOT link and underline by default
    }),
    Link.configure({
      openOnClick: false,
    }),
    Placeholder.configure({
      placeholder: props.placeholder || 'What should this task do?',
    }),
    Underline,
    CodeBlock.configure({
      languageClassPrefix: 'language-',
    }),
  ],
  content: props.modelValue,
  editable: !props.disabled,
  onUpdate: ({ editor }) => {
    if (isSettingContent) return
    emit('update:modelValue', editor.getHTML())
  },
  editorProps: {
    handleKeyDown: (view, event) => {
      emit('keydown', event)
      return false // Don't prevent default handling
    },
  },
})

// Sync external changes
watch(() => props.modelValue, (newValue) => {
  if (!editor.value || isSettingContent) return
  
  const targetContent = newValue || '<p></p>'
  const currentContent = editor.value.getHTML()
  
  // Check if we need to update (content is different)
  if (currentContent === targetContent) return
  
  // Set content without triggering onUpdate to avoid circular loop
  isSettingContent = true
  editor.value.commands.setContent(targetContent, false)
  isSettingContent = false
})

watch(() => props.disabled, (disabled) => {
  if (editor.value) {
    editor.value.setEditable(!disabled)
  }
})

onBeforeUnmount(() => {
  editor.value?.destroy()
})

// Toolbar actions
const toggleBold = () => editor.value?.chain().focus().toggleBold().run()
const toggleItalic = () => editor.value?.chain().focus().toggleItalic().run()
const toggleUnderline = () => editor.value?.chain().focus().toggleUnderline().run()
const toggleStrike = () => editor.value?.chain().focus().toggleStrike().run()
const toggleCode = () => editor.value?.chain().focus().toggleCode().run()
const toggleCodeBlock = () => editor.value?.chain().focus().toggleCodeBlock().run()
const toggleHeading = (level: 1 | 2 | 3) => editor.value?.chain().focus().toggleHeading({ level }).run()
const toggleBulletList = () => editor.value?.chain().focus().toggleBulletList().run()
const toggleOrderedList = () => editor.value?.chain().focus().toggleOrderedList().run()
const toggleBlockquote = () => editor.value?.chain().focus().toggleBlockquote().run()
const setParagraph = () => editor.value?.chain().focus().setParagraph().run()
const toggleLink = () => {
  if (!editor.value) return
  const previousUrl = editor.value.getAttributes('link').href
  const url = window.prompt('URL', previousUrl)
  
  if (url === null) return
  if (url === '') {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.value.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}
const undo = () => editor.value?.chain().focus().undo().run()
const redo = () => editor.value?.chain().focus().redo().run()

// Expose method to clear editor content directly
const clear = () => {
  if (!editor.value) return
  editor.value.chain().focus().clearContent().run()
}

defineExpose({ clear })

// Check if actions are active
const isActive = (name: string, attributes?: Record<string, unknown>) => {
  return editor.value?.isActive(name, attributes) ?? false
}

const canUndo = computed(() => editor.value?.can().undo() ?? false)
const canRedo = computed(() => editor.value?.can().redo() ?? false)

</script>

<template>
  <div class="markdown-editor-container">
    <!-- Toolbar -->
    <div class="markdown-editor-toolbar">
      <div class="toolbar-group">
        <button
          type="button"
          class="toolbar-btn"
          :disabled="!canUndo"
          title="Undo (Ctrl+Z)"
          @click="undo"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :disabled="!canRedo"
          title="Redo (Ctrl+Shift+Z)"
          @click="redo"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
          </svg>
        </button>
      </div>

      <div class="toolbar-divider" />

      <div class="toolbar-group">
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('paragraph') }"
          title="Paragraph"
          @click="setParagraph"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('heading', { level: 1 }) }"
          title="Heading 1"
          @click="toggleHeading(1)"
        >
          H1
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('heading', { level: 2 }) }"
          title="Heading 2"
          @click="toggleHeading(2)"
        >
          H2
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('heading', { level: 3 }) }"
          title="Heading 3"
          @click="toggleHeading(3)"
        >
          H3
        </button>
      </div>

      <div class="toolbar-divider" />

      <div class="toolbar-group">
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('bold') }"
          title="Bold (Ctrl+B)"
          @click="toggleBold"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('italic') }"
          title="Italic (Ctrl+I)"
          @click="toggleItalic"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10 20l4-16m4 4l-4 16M6 20h4" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('underline') }"
          title="Underline (Ctrl+U)"
          @click="toggleUnderline"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('strike') }"
          title="Strikethrough"
          @click="toggleStrike"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 16L18 8M6 8l12 8" />
          </svg>
        </button>
      </div>

      <div class="toolbar-divider" />

      <div class="toolbar-group">
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('code') }"
          title="Inline Code"
          @click="toggleCode"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('codeBlock') }"
          title="Code Block"
          @click="toggleCodeBlock"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10l-2 2 2 2M16 10l2 2-2 2M10 14l4-4" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('blockquote') }"
          title="Quote"
          @click="toggleBlockquote"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('link') }"
          title="Link"
          @click="toggleLink"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
      </div>

      <div class="toolbar-divider" />

      <div class="toolbar-group">
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('bulletList') }"
          title="Bullet List"
          @click="toggleBulletList"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H4m0 0v14m0-14h16M9 12H4m15-7h-4m4 7h-4" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          :class="{ 'toolbar-btn-active': isActive('orderedList') }"
          title="Ordered List"
          @click="toggleOrderedList"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h12M7 12h12M7 17h12M3 7h.01M3 12h.01M3 17h.01" />
          </svg>
        </button>
      </div>

    </div>

    <!-- Editor Content -->
    <div 
      :class="[
        'markdown-editor-content',
        disabled && 'markdown-editor-disabled'
      ]"
    >
      <editor-content :editor="editor" />
    </div>
  </div>
</template>

<style>
.markdown-editor-container {
  border: 1px solid rgba(60, 60, 60, 0.5);
  border-radius: 0.5rem;
  background-color: rgba(20, 20, 20, 0.8);
  backdrop-filter: blur(8px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 200px;
  max-height: 500px;
  resize: vertical;
}

.markdown-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem;
  background-color: rgba(30, 30, 30, 0.6);
  border-bottom: 1px solid rgba(60, 60, 60, 0.5);
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}

.toolbar-divider {
  width: 1px;
  height: 1.25rem;
  background-color: rgba(60, 60, 60, 0.5);
  margin: 0 0.25rem;
}

.toolbar-spacer {
  flex: 1;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.375rem;
  border: none;
  background: transparent;
  color: #888888;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  transition: all 0.15s ease;
}

.toolbar-btn:hover:not(:disabled) {
  background-color: rgba(50, 50, 50, 0.6);
  color: #e0e0e0;
}

.toolbar-btn-active {
  background-color: rgba(80, 80, 80, 0.7);
  color: #e0e0e0;
}

.toolbar-btn-active:hover {
  background-color: rgba(100, 100, 100, 0.8);
  color: #e0e0e0;
}

.toolbar-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.markdown-editor-content {
  flex: 1;
  padding: 0.75rem;
  overflow-y: auto;
  min-height: 0;
}

.markdown-editor-content .ProseMirror {
  outline: none;
  min-height: 100%;
  color: #e0e0e0;
  line-height: 1.6;
}

.markdown-editor-content .ProseMirror p {
  margin: 0 0 0.75rem 0;
}

.markdown-editor-content .ProseMirror p:last-child {
  margin-bottom: 0;
}

.markdown-editor-content .ProseMirror h1,
.markdown-editor-content .ProseMirror h2,
.markdown-editor-content .ProseMirror h3 {
  margin: 0 0 0.75rem 0;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-editor-content .ProseMirror h1 {
  font-size: 1.25rem;
}

.markdown-editor-content .ProseMirror h2 {
  font-size: 1.125rem;
}

.markdown-editor-content .ProseMirror h3 {
  font-size: 1rem;
}

.markdown-editor-content .ProseMirror ul,
.markdown-editor-content .ProseMirror ol {
  margin: 0 0 0.75rem 0;
  padding-left: 1.5rem;
}

.markdown-editor-content .ProseMirror li {
  margin: 0.25rem 0;
}

.markdown-editor-content .ProseMirror blockquote {
  margin: 0 0 0.75rem 0;
  padding-left: 1rem;
  border-left: 3px solid rgba(100, 100, 100, 0.5);
  color: #888888;
  font-style: italic;
}

.markdown-editor-content .ProseMirror code {
  background-color: rgba(50, 50, 50, 0.6);
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 0.875em;
}

.markdown-editor-content .ProseMirror pre {
  background-color: rgba(40, 40, 40, 0.8);
  padding: 0.75rem;
  border-radius: 0.5rem;
  margin: 0 0 0.75rem 0;
  overflow-x: auto;
  border: 1px solid rgba(60, 60, 60, 0.3);
}

.markdown-editor-content .ProseMirror pre code {
  background: none;
  padding: 0;
  font-size: 0.875rem;
}

.markdown-editor-content .ProseMirror a {
  color: rgba(130, 170, 210, 0.9);
  text-decoration: underline;
}

.markdown-editor-content .ProseMirror .is-editor-empty::before {
  content: attr(data-placeholder);
  float: left;
  color: #555555;
  pointer-events: none;
  height: 0;
  opacity: 0.8;
}

.markdown-editor-disabled {
  opacity: 0.6;
  pointer-events: none;
}
</style>
