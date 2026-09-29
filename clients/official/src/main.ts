import './styles/tokens.css'
import './styles/base.css'
import './styles/controls.css'
import './styles/host-connection.css'
import './styles/dialog.css'
import './styles/conversation.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import OpenInApp from './components/OpenInApp.vue'
import { isTauri } from './lib/bridge'
import dockIconUrl from '../../../assets/icon.svg'

document.body.classList.add('alu-terminal-body')
const appIcon = document.querySelector<HTMLLinkElement>('#app-icon')
if (appIcon) appIcon.href = dockIconUrl
// Development previews run in a plain browser with sample data; a production
// build only runs inside the AluDock client.
if (isTauri || import.meta.env.DEV) createApp(App).use(createPinia()).mount('#app')
else createApp(OpenInApp).mount('#app')
