/**
 * SolidJS Entry Point
 */

import { render } from 'solid-js/web'
import App from './App'

const root = document.getElementById('root')
if (root) {
  render(() => <App />, root)
} else {
  document.body.textContent = 'Root element not found'
}
