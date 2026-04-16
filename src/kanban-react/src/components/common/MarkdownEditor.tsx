import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlock from '@tiptap/extension-code-block'
import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'

interface MarkdownEditorProps {
  modelValue: string
  disabled?: boolean
  placeholder?: string
  onUpdate?: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}

export interface MarkdownEditorRef {
  clear: () => void
  focus: () => void
}

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
  ({ modelValue, disabled = false, placeholder, onUpdate, onKeyDown }, ref) => {
    let isSettingContent = useRef(false)

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3],
          },
          codeBlock: false,
          link: false, // StarterKit includes Link, disable to use custom config
        }),
        Link.configure({
          openOnClick: false,
        }),
        Placeholder.configure({
          placeholder: placeholder || 'What should this task do?',
        }),
        CodeBlock.configure({
          HTMLAttributes: {
            class: 'code-block',
          },
        }),
      ],
      content: modelValue,
      editable: !disabled,
      onUpdate: ({ editor }) => {
        if (isSettingContent.current) return
        onUpdate?.(editor.getHTML())
      },
      editorProps: {
        handleKeyDown: (_view, event) => {
          onKeyDown?.(event as unknown as React.KeyboardEvent)
          return false
        },
      },
    })

    useImperativeHandle(ref, () => ({
      clear: () => {
        editor?.commands.clearContent()
      },
      focus: () => {
        editor?.commands.focus()
      },
    }))

    useEffect(() => {
      if (!editor || isSettingContent.current) return

      const targetContent = modelValue || '<p></p>'
      const currentContent = editor.getHTML()

      if (currentContent === targetContent) return

      isSettingContent.current = true
      editor.commands.setContent(targetContent, false)
      isSettingContent.current = false
    }, [modelValue, editor])

    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled)
      }
    }, [disabled, editor])

    useEffect(() => {
      return () => {
        editor?.destroy()
      }
    }, [editor])

    const toggleBold = () => editor?.chain().focus().toggleBold().run()
    const toggleItalic = () => editor?.chain().focus().toggleItalic().run()
    const toggleCode = () => editor?.chain().focus().toggleCode().run()
    const toggleCodeBlock = () => editor?.chain().focus().toggleCodeBlock().run()
    const toggleHeading = (level: 1 | 2 | 3) => editor?.chain().focus().toggleHeading({ level }).run()
    const toggleBulletList = () => editor?.chain().focus().toggleBulletList().run()
    const toggleOrderedList = () => editor?.chain().focus().toggleOrderedList().run()
    const toggleBlockquote = () => editor?.chain().focus().toggleBlockquote().run()
    const setParagraph = () => editor?.chain().focus().setParagraph().run()
    const toggleLink = () => {
      if (!editor) return
      const previousUrl = editor.getAttributes('link').href
      const url = window.prompt('URL', previousUrl)
      if (url === null) return
      if (url === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run()
        return
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }

    if (!editor) {
      return null
    }

    return (
      <div className="markdown-editor">
        <div className="editor-toolbar">
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
            onClick={toggleBold}
            title="Bold"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6V4zm0 8h9a4 4 0 014 4 4 4 0 01-4 4H6v-8z" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
            onClick={toggleItalic}
            title="Italic"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 4h4m-2 0v16m-4 0h8" transform="skewX(-6)" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('code') ? 'active' : ''}`}
            onClick={toggleCode}
            title="Inline Code"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
            onClick={toggleCodeBlock}
            title="Code Block"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          </button>

          <span className="toolbar-divider" />

          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
            onClick={() => toggleHeading(1)}
            title="Heading 1"
          >
            H1
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
            onClick={() => toggleHeading(2)}
            title="Heading 2"
          >
            H2
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
            onClick={() => toggleHeading(3)}
            title="Heading 3"
          >
            H3
          </button>

          <span className="toolbar-divider" />

          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
            onClick={toggleBulletList}
            title="Bullet List"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h.01M8 6h12M4 12h.01M8 12h12M4 18h.01M8 18h12" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
            onClick={toggleOrderedList}
            title="Numbered List"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 6h.01M7 12h.01M7 18h.01M3 6h.01M3 12h10M3 18h10" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
            onClick={toggleBlockquote}
            title="Quote"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5c0-1.5-1-2.5-2.5-2.5S3 9 3 10.5c0 2 2 3.5 4 5.5 1.5 1.5 2.5 3 2.5 5.5M17 10.5c0-1.5-1-2.5-2.5-2.5s-2.5 1-2.5 2.5c0 2 2 3.5 4 5.5 1.5 1.5 2.5 3 2.5 5.5" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('paragraph') ? 'active' : ''}`}
            onClick={setParagraph}
            title="Paragraph"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h12" />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive('link') ? 'active' : ''}`}
            onClick={toggleLink}
            title="Link"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </button>
        </div>

        <EditorContent
          editor={editor}
          className="editor-content"
        />

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
)

MarkdownEditor.displayName = 'MarkdownEditor'