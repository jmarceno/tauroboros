/**
 * MarkdownEditor Component - Rich text editor with TipTap
 * Ported from React to SolidJS using solid-tiptap
 */

import { createTiptapEditor, useEditorJSON } from 'solid-tiptap'
import { createSignal, createEffect, Show, onCleanup, onMount } from 'solid-js'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlock from '@tiptap/extension-code-block'

interface MarkdownEditorProps {
  modelValue: string
  disabled?: boolean
  placeholder?: string
  onUpdate?: (value: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
}

export interface MarkdownEditorRef {
  clear: () => void
  focus: () => void
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  let containerRef: HTMLDivElement | undefined
  let editorRef: HTMLDivElement | undefined
  const [isSettingContent, setIsSettingContent] = createSignal(false)

  const editor = createTiptapEditor(() => ({
    element: editorRef!,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
        codeBlock: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: props.placeholder || 'What should this task do?',
      }),
      CodeBlock.configure({
        HTMLAttributes: {
          class: 'code-block',
        },
      }),
    ],
    content: props.modelValue,
    editable: !props.disabled,
    onUpdate: ({ editor }) => {
      if (isSettingContent()) return
      props.onUpdate?.(editor.getHTML())
    },
    editorProps: {
      handleKeyDown: (_view, event) => {
        props.onKeyDown?.(event as KeyboardEvent)
        return false
      },
    },
  }))

  // Update content when modelValue changes
  createEffect(() => {
    const currentEditor = editor()
    if (!currentEditor || isSettingContent()) return

    const targetContent = props.modelValue || '<p></p>'
    const currentContent = currentEditor.getHTML()

    if (currentContent === targetContent) return

    setIsSettingContent(true)
    currentEditor.commands.setContent(targetContent, false)
    setIsSettingContent(false)
  })

  // Update editable state when disabled changes
  createEffect(() => {
    const currentEditor = editor()
    if (currentEditor) {
      currentEditor.setEditable(!props.disabled)
    }
  })

  // Cleanup editor on unmount
  onCleanup(() => {
    const currentEditor = editor()
    if (currentEditor) {
      currentEditor.destroy()
    }
  })

  // Toolbar actions
  const toggleBold = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleBold().run()
  }
  const toggleItalic = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleItalic().run()
  }
  const toggleCode = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleCode().run()
  }
  const toggleCodeBlock = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleCodeBlock().run()
  }
  const toggleHeading = (level: 1 | 2 | 3) => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleHeading({ level }).run()
  }
  const toggleBulletList = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleBulletList().run()
  }
  const toggleOrderedList = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleOrderedList().run()
  }
  const toggleBlockquote = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().toggleBlockquote().run()
  }
  const setParagraph = () => {
    const currentEditor = editor()
    currentEditor?.chain().focus().setParagraph().run()
  }
  const toggleLink = () => {
    const currentEditor = editor()
    if (!currentEditor) return
    const previousUrl = currentEditor.getAttributes('link').href
    const url = window.prompt('URL', previousUrl)
    if (url === null) return
    if (url === '') {
      currentEditor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    currentEditor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  // Expose imperative methods via ref
  const clear = () => {
    const currentEditor = editor()
    currentEditor?.commands.clearContent()
  }
  const focus = () => {
    const currentEditor = editor()
    currentEditor?.commands.focus()
  }

  // Attach methods to container for external access
  onMount(() => {
    if (containerRef) {
      ;(containerRef as any).clear = clear
      ;(containerRef as any).focus = focus
    }
  })

  return (
    <div ref={containerRef} class="markdown-editor">
      <div class="editor-toolbar">
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('bold') }}
          onClick={toggleBold}
          title="Bold"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('italic') }}
          onClick={toggleItalic}
          title="Italic"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 4h4m-2 0v16m-4 0h8" transform="skewX(-6)" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('code') }}
          onClick={toggleCode}
          title="Inline Code"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('codeBlock') }}
          onClick={toggleCodeBlock}
          title="Code Block"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
        </button>

        <span class="toolbar-divider" />

        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('heading', { level: 1 }) }}
          onClick={() => toggleHeading(1)}
          title="Heading 1"
        >
          H1
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('heading', { level: 2 }) }}
          onClick={() => toggleHeading(2)}
          title="Heading 2"
        >
          H2
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('heading', { level: 3 }) }}
          onClick={() => toggleHeading(3)}
          title="Heading 3"
        >
          H3
        </button>

        <span class="toolbar-divider" />

        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('bulletList') }}
          onClick={toggleBulletList}
          title="Bullet List"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h.01M8 6h12M4 12h.01M8 12h12M4 18h.01M8 18h12" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('orderedList') }}
          onClick={toggleOrderedList}
          title="Numbered List"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 6h.01M7 12h.01M7 18h.01M3 6h.01M3 12h10M3 18h10" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('blockquote') }}
          onClick={toggleBlockquote}
          title="Quote"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 10.5c0-1.5-1-2.5-2.5-2.5S3 9 3 10.5c0 2 2 3.5 4 5.5 1.5 1.5 2.5 3 2.5 5.5M17 10.5c0-1.5-1-2.5-2.5-2.5s-2.5 1-2.5 2.5c0 2 2 3.5 4 5.5 1.5 1.5 2.5 3 2.5 5.5" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('paragraph') }}
          onClick={setParagraph}
          title="Paragraph"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h12" />
          </svg>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          classList={{ 'active': editor()?.isActive('link') }}
          onClick={toggleLink}
          title="Link"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
      </div>

      <div ref={editorRef} class="editor-content" />

      <style>{`
        .markdown-editor {
          border: 1px solid var(--dark-surface3, #2a2a2a);
          border-radius: 0.375rem;
          overflow: hidden;
        }

        .editor-toolbar {
          display: flex;
          align-items: center;
          gap: 0.125rem;
          padding: 0.375rem;
          background: var(--dark-surface, #1a1a1a);
          border-bottom: 1px solid var(--dark-surface3, #2a2a2a);
          flex-wrap: wrap;
        }

        .toolbar-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 1.75rem;
          height: 1.75rem;
          padding: 0 0.25rem;
          border: none;
          border-radius: 0.25rem;
          background: transparent;
          color: var(--dark-text-muted, #8c8c9a);
          cursor: pointer;
          font-size: 0.75rem;
          font-weight: 600;
          transition: all 0.15s;
        }

        .toolbar-btn:hover {
          background: var(--dark-surface2, #222);
          color: var(--dark-text, #e0e0e0);
        }

        .toolbar-btn.active {
          background: var(--accent-primary, #818cf8);
          color: var(--dark-bg, #0a0a0f);
        }

        .toolbar-divider {
          width: 1px;
          height: 1.25rem;
          background: var(--dark-surface3, #2a2a2a);
          margin: 0 0.25rem;
        }

        .editor-content {
          background: var(--dark-bg, #0a0a0f);
        }

        .editor-content .ProseMirror {
          min-height: 80px;
          padding: 0.75rem;
          outline: none;
          color: var(--dark-text, #e0e0e0);
          font-size: 0.875rem;
          line-height: 1.5;
        }

        .editor-content .ProseMirror p {
          margin: 0 0 0.5rem 0;
        }

        .editor-content .ProseMirror p:last-child {
          margin-bottom: 0;
        }

        .editor-content .ProseMirror h1,
        .editor-content .ProseMirror h2,
        .editor-content .ProseMirror h3 {
          margin: 1rem 0 0.5rem 0;
          font-weight: 600;
          line-height: 1.3;
        }

        .editor-content .ProseMirror h1 {
          font-size: 1.5rem;
        }

        .editor-content .ProseMirror h2 {
          font-size: 1.25rem;
        }

        .editor-content .ProseMirror h3 {
          font-size: 1.125rem;
        }

        .editor-content .ProseMirror ul,
        .editor-content .ProseMirror ol {
          padding-left: 1.5rem;
          margin: 0.5rem 0;
        }

        .editor-content .ProseMirror li {
          margin: 0.25rem 0;
        }

        .editor-content .ProseMirror blockquote {
          border-left: 3px solid var(--accent-primary, #818cf8);
          padding-left: 1rem;
          margin: 0.5rem 0;
          color: var(--dark-text-muted, #8c8c9a);
        }

        .editor-content .ProseMirror code {
          background: var(--dark-surface2, #222);
          padding: 0.125rem 0.25rem;
          border-radius: 0.25rem;
          font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', monospace;
          font-size: 0.875em;
        }

        .editor-content .ProseMirror pre {
          background: var(--dark-surface2, #222);
          padding: 0.75rem;
          border-radius: 0.375rem;
          overflow-x: auto;
          margin: 0.5rem 0;
        }

        .editor-content .ProseMirror pre code {
          background: transparent;
          padding: 0;
        }

        .editor-content .ProseMirror a {
          color: var(--accent-primary, #818cf8);
          text-decoration: underline;
        }

        .editor-content .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          color: var(--dark-text-muted, #8c8c9a);
          pointer-events: none;
          float: left;
          height: 0;
        }

        .editor-content .ProseMirror:focus {
          outline: none;
        }
      `}</style>
    </div>
  )
}
