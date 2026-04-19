/**
 * ModalWrapper Component - Common modal wrapper
 * Ported from React to SolidJS - Full feature parity
 */

interface ModalWrapperProps {
  title: string
  onClose: () => void
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children: JSX.Element
}

export function ModalWrapper(props: ModalWrapperProps) {
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  }

  return (
    <div 
      class="modal-overlay"
      onClick={props.onClose}
    >
      <div
        class={`modal ${sizeClasses[props.size || 'md']}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2>{props.title}</h2>
          <button class="icon-btn" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body">
          {props.children}
        </div>
      </div>
    </div>
  )
}
